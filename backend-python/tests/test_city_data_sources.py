"""两个远程数据源的单元测试：open-meteo 天气 + 空气质量（CAMS 模型再分析）。

**这些测试一律不打真实网络**：上游响应是构造出来的假数据
（``city_data.http.request_json`` 被替换掉），CI 上没有外网也能跑。

覆盖的坑：
- 上游的时间是 **Unix epoch 秒**（请求带 ``timeformat=unixtime``），
  不是 ISO 字符串；
- 空气质量**没有** ``daily`` 段落，日聚合要从 ``hourly`` 自己算；
- CO 的对外单位是 **mg/m³**（上游是 μg/m³）；
- 窗口内数据不足时，指标是 ``None``，**不是 0**；
- 两个源都是**模式数据** → ``source.estimated`` 必须是 ``True``。
"""
import time
import urllib.error
from datetime import datetime, timezone

import pytest

from city_data import http
from city_data.cities import CITIES, City
from city_data.http import SourceUnavailable
from city_data.sources import air_quality, weather

# 上游给的固定时区偏移（Europe/Madrid 的夏季偏移）。构造假数据时用它
# 对齐本地日边界 —— 响应里的 ``utc_offset_seconds`` 决定「哪一天」。
UTC_OFFSET = 7200

# 与上游一致的规模：``past_days=7`` + ``forecast_days=1``
# → 8 个本地日 × 24 小时 = 192 个点（含今天的不完整日与未来预报日）。
TOTAL_POINTS = 192
PAST_DAYS = 7

# 上游的污染物变量名。
UPSTREAM_VARS = (
    "pm2_5",
    "pm10",
    "ozone",
    "nitrogen_dioxide",
    "sulphur_dioxide",
    "carbon_monoxide",
)

# 一组「每项都落在分段点上」的常数浓度：算出来的 AQI 是 75（良）。
CONSTANT_CONCENTRATIONS = {
    "pm2_5": 55.0,
    "pm10": 50.0,
    "ozone": 100.0,
    "nitrogen_dioxide": 40.0,
    "sulphur_dioxide": 50.0,
    "carbon_monoxide": 2000.0,
}


def _now_epoch() -> int:
    return int(time.time())


def _local_midnight(now_epoch: int, offset: int = UTC_OFFSET) -> int:
    """当前本地日的 00:00（epoch 秒）。"""
    return ((now_epoch + offset) // 86400) * 86400 - offset


def _make_air_payload(
    concentrations,
    now_epoch=None,
    *,
    offset=UTC_OFFSET,
    start_epoch=None,
    total_points=TOTAL_POINTS,
    with_current=True,
):
    """造一份空气质量的响应。

    ``concentrations`` 的键是上游变量名；值可以是常数、列表，
    或 ``f(index) -> 值`` 的可调用对象（用来造浓度随时间变化的序列）。
    """
    now_epoch = _now_epoch() if now_epoch is None else now_epoch
    if start_epoch is None:
        start_epoch = _local_midnight(now_epoch, offset) - PAST_DAYS * 86400
    times = [start_epoch + index * 3600 for index in range(total_points)]

    hourly = {"time": list(times)}
    for var in UPSTREAM_VARS:
        source = concentrations.get(var)
        column = []
        for index in range(total_points):
            if source is None:
                column.append(None)
            elif callable(source):
                column.append(source(index))
            elif isinstance(source, list):
                column.append(source[index] if index < len(source) else None)
            else:
                column.append(source)
        hourly[var] = column

    payload = {
        "latitude": 41.4,
        "longitude": 2.2,
        "utc_offset_seconds": offset,
        "timezone": "Europe/Madrid",
        "elevation": 47.0,
        "hourly": hourly,
    }
    if with_current:
        usable = [value for value in times if value <= now_epoch]
        payload["current"] = {
            "time": max(usable) if usable else times[-1],
            "interval": 3600,
            "pm2_5": 7.6,
            "pm10": 11.3,
            "ozone": 33.0,
            "nitrogen_dioxide": 25.1,
            "sulphur_dioxide": 2.2,
            "carbon_monoxide": 163.0,
            "us_aqi": 40,
            "european_aqi": 40,
        }
    return payload


def _current_hour_index(now_epoch: int, offset: int = UTC_OFFSET) -> int:
    """当前小时在 hourly 数组里的下标。"""
    start = _local_midnight(now_epoch, offset) - PAST_DAYS * 86400
    return (now_epoch - start) // 3600


def _by_key(result):
    return {metric.key: metric for metric in result.metrics}


def _series_by_key(result):
    return {series.key: series for series in result.series}


# ---------------------------------------------------------------------------
# HTTP 封装（两个源都靠它把网络异常收敛成一种异常）
# ---------------------------------------------------------------------------


class _FakeResponse:
    """假的 urlopen 返回值。"""

    def __init__(self, payload: bytes, charset=None):
        self._payload = payload
        self.headers = _FakeHeaders(charset)

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeHeaders:
    def __init__(self, charset=None):
        self._charset = charset

    def get_content_charset(self):
        return self._charset


class TestHttp:
    """http.py 的职责是「把 urllib 的一堆异常收敛成一种异常」。"""

    def test_parses_json(self, monkeypatch):
        monkeypatch.setattr(
            http.urllib.request, "urlopen", lambda *a, **k: _FakeResponse(b'{"a": 1}')
        )
        assert http.request_json("https://example.invalid/x") == {"a": 1}

    def test_http_error_becomes_source_unavailable(self, monkeypatch):
        def boom(*args, **kwargs):
            raise urllib.error.HTTPError("u", 404, "Not Found", {}, None)

        monkeypatch.setattr(http.urllib.request, "urlopen", boom)
        with pytest.raises(SourceUnavailable):
            http.request_json("https://example.invalid/x")

    def test_network_error_becomes_source_unavailable(self, monkeypatch):
        def boom(*args, **kwargs):
            raise OSError("connection reset")

        monkeypatch.setattr(http.urllib.request, "urlopen", boom)
        with pytest.raises(SourceUnavailable):
            http.request_json("https://example.invalid/x")

    def test_non_json_body_becomes_source_unavailable(self, monkeypatch):
        monkeypatch.setattr(
            http.urllib.request,
            "urlopen",
            lambda *a, **k: _FakeResponse(b"<html>404</html>"),
        )
        with pytest.raises(SourceUnavailable):
            http.request_json("https://example.invalid/x")


# ---------------------------------------------------------------------------
# 天气
# ---------------------------------------------------------------------------


def _weather_payload(now_epoch, age_seconds=1800):
    """造一份天气预报响应（``current`` 里的时间是 epoch 秒）。"""
    observed = now_epoch - age_seconds
    return {
        "latitude": 41.43923,
        "longitude": 2.168546,
        "utc_offset_seconds": UTC_OFFSET,
        "timezone": "Europe/Madrid",
        "elevation": 47.0,
        "current_units": {"time": "unixtime", "temperature_2m": "°C"},
        "current": {
            "time": observed,
            "interval": 900,
            "temperature_2m": 15.8,
            "relative_humidity_2m": 86,
            "apparent_temperature": 16.0,
            "weather_code": 80,
            "wind_speed_10m": 6.2,
            "precipitation": 0.10,
        },
    }


class TestWeatherUrl:
    def test_url_uses_the_city_coordinates_and_timezone(self):
        city = City(id="other", name="别处", latitude=12.5, longitude=-3.25, timezone="UTC")
        url = weather.build_url(city)
        assert "latitude=12.5" in url
        assert "longitude=-3.25" in url
        assert "timezone=UTC" in url
        # 不能把某一座城市的坐标写死。
        assert "41.395" not in url
        assert "2.165" not in url

    def test_url_asks_for_unixtime_and_the_current_block(self):
        url = weather.build_url(CITIES["barcelona"])
        assert url.startswith("https://api.open-meteo.com/v1/forecast?")
        assert "timeformat=unixtime" in url
        assert "current=temperature_2m" in url
        assert "timezone=Europe%2FMadrid" in url


class TestWeatherParse:
    def test_parse_current_reads_the_numbers(self):
        now = datetime(2026, 10, 24, 2, 0, tzinfo=timezone.utc)
        payload = _weather_payload(int(now.timestamp()), age_seconds=1800)
        parsed = weather.parse_current(payload, now)
        assert parsed["temperature"] == 15.8
        assert parsed["humidity"] == 86.0
        assert parsed["apparent_temperature"] == 16.0
        assert parsed["wind_speed_10m"] == 6.2
        assert parsed["precipitation"] == 0.10
        assert parsed["weather_code"] == 80
        assert parsed["realtime"] is True
        assert parsed["utc_offset_seconds"] == UTC_OFFSET

    def test_parse_current_rejects_a_missing_block(self):
        now = datetime(2026, 10, 24, 2, 0, tzinfo=timezone.utc)
        with pytest.raises(SourceUnavailable):
            weather.parse_current({"current": None}, now)
        with pytest.raises(SourceUnavailable):
            weather.parse_current({"current": {}}, now)
        with pytest.raises(SourceUnavailable):
            weather.parse_current("not a dict", now)

    def test_parse_current_rejects_non_numeric_fields(self):
        now = datetime(2026, 10, 24, 2, 0, tzinfo=timezone.utc)
        payload = _weather_payload(int(now.timestamp()))
        payload["current"]["temperature_2m"] = "很冷"
        with pytest.raises(SourceUnavailable):
            weather.parse_current(payload, now)

        payload = _weather_payload(int(now.timestamp()))
        payload["current"]["relative_humidity_2m"] = None
        with pytest.raises(SourceUnavailable):
            weather.parse_current(payload, now)

        payload = _weather_payload(int(now.timestamp()))
        payload["current"]["time"] = "2026-10-24T02:00:00"
        with pytest.raises(SourceUnavailable):
            weather.parse_current(payload, now)


class TestWeatherFetch:
    def test_fetch_produces_two_metrics_with_a_source(self, monkeypatch):
        now_epoch = _now_epoch()
        payload = _weather_payload(now_epoch)
        calls = []

        def fake_request(url, **kwargs):
            calls.append(url)
            return payload

        monkeypatch.setattr(weather.http, "request_json", fake_request)

        result = weather.fetch(CITIES["barcelona"])

        assert [metric.key for metric in result.metrics] == [
            "weather_temp",
            "weather_humidity",
        ]
        temp = result.metrics[0]
        assert temp.value == 15.8
        assert temp.unit == "℃"
        assert result.metrics[1].value == 86.0
        assert result.metrics[1].unit == "%"

        # 来源标注：数值模式预报 → 必须标 estimated。
        source = temp.source
        assert source.name == weather.SOURCE_NAME
        assert source.estimated is True
        assert source.url == weather.build_url(CITIES["barcelona"])
        assert calls == [source.url]
        assert source.fetched_at.endswith("Z")
        # observed_at 是上游数据自身的时间，不是取数时间。
        expected = datetime.fromtimestamp(payload["current"]["time"], tz=timezone.utc)
        assert source.observed_at == expected.isoformat(timespec="seconds").replace("+00:00", "Z")
        assert source.observed_at != source.fetched_at
        assert source.realtime is True

    def test_extra_carries_the_upstream_fields(self, monkeypatch):
        payload = _weather_payload(_now_epoch())
        monkeypatch.setattr(weather.http, "request_json", lambda url, **kwargs: payload)

        result = weather.fetch(CITIES["barcelona"])
        extra = result.metrics[0].extra

        assert extra["apparent_temperature"] == 16.0
        assert extra["wind_speed_10m"] == 6.2
        assert extra["precipitation"] == 0.10
        assert extra["weather_code"] == 80
        assert extra["timezone"] == "Europe/Madrid"
        assert extra["utc_offset_seconds"] == UTC_OFFSET
        # 上游的署名要求随数据一起发出去。
        assert extra["attribution"] == weather.ATTRIBUTION
        # 两个指标共用一份 extra。
        assert result.metrics[1].extra == extra

    def test_missing_upstream_field_is_not_invented(self, monkeypatch):
        payload = _weather_payload(_now_epoch())
        payload["current"]["precipitation"] = None
        monkeypatch.setattr(weather.http, "request_json", lambda url, **kwargs: payload)

        result = weather.fetch(CITIES["barcelona"])
        assert "precipitation" not in result.metrics[0].extra

    def test_stale_observation_is_not_realtime(self, monkeypatch):
        now_epoch = _now_epoch()
        payload = _weather_payload(now_epoch, age_seconds=7200)
        monkeypatch.setattr(weather.http, "request_json", lambda url, **kwargs: payload)

        result = weather.fetch(CITIES["barcelona"])
        assert result.metrics[0].source.realtime is False

    def test_upstream_failure_propagates_as_unavailable(self, monkeypatch):
        def boom(url, **kwargs):
            raise SourceUnavailable("测试：上游不可用")

        monkeypatch.setattr(weather.http, "request_json", boom)
        with pytest.raises(SourceUnavailable):
            weather.fetch(CITIES["barcelona"])

    def test_broken_payload_is_unavailable(self, monkeypatch):
        monkeypatch.setattr(weather.http, "request_json", lambda url, **kwargs: {"nope": 1})
        with pytest.raises(SourceUnavailable):
            weather.fetch(CITIES["barcelona"])


# ---------------------------------------------------------------------------
# 空气质量
# ---------------------------------------------------------------------------


class TestAirQualityUrl:
    def test_url_uses_the_city_coordinates_and_timezone(self):
        city = City(id="other", name="别处", latitude=12.5, longitude=-3.25, timezone="UTC")
        url = air_quality.build_url(city)
        assert "latitude=12.5" in url
        assert "longitude=-3.25" in url
        assert "timezone=UTC" in url
        assert "41.395" not in url
        assert "2.165" not in url

    def test_url_asks_for_hourly_current_and_unixtime(self):
        url = air_quality.build_url(CITIES["barcelona"])
        assert url.startswith("https://air-quality-api.open-meteo.com/v1/air-quality?")
        assert "timeformat=unixtime" in url
        assert "hourly=pm2_5,pm10,ozone" in url
        assert "european_aqi" in url
        assert "past_days=7" in url


class TestAirQualityFetch:
    def test_produces_seven_metrics_and_two_series(self, monkeypatch):
        payload = _make_air_payload(CONSTANT_CONCENTRATIONS)
        monkeypatch.setattr(
            air_quality.http, "request_json", lambda url, **kwargs: payload
        )

        result = air_quality.fetch(CITIES["barcelona"])
        metrics = _by_key(result)

        assert [metric.key for metric in result.metrics] == [
            "aqi",
            "pm25",
            "pm10",
            "o3",
            "no2",
            "so2",
            "co",
        ]
        assert metrics["pm25"].value == 55.0
        assert metrics["pm10"].value == 50.0
        assert metrics["o3"].value == 100.0
        assert metrics["no2"].value == 40.0
        assert metrics["so2"].value == 50.0
        # CO 的对外单位是 mg/m³（上游给的是 μg/m³）。
        assert metrics["co"].value == 2.0
        assert metrics["co"].unit == "mg/m³"
        assert metrics["pm25"].unit == "μg/m³"

        assert [series.key for series in result.series] == ["aqi_24h", "aqi_daily"]

    def test_aqi_uses_the_national_standard_conversion(self, monkeypatch):
        payload = _make_air_payload(CONSTANT_CONCENTRATIONS)
        monkeypatch.setattr(
            air_quality.http, "request_json", lambda url, **kwargs: payload
        )

        metrics = _by_key(air_quality.fetch(CITIES["barcelona"]))
        aqi = metrics["aqi"]

        # PM2.5 = 55 → IAQI 75；其余污染物都落在更低的段上 → AQI = 75。
        assert aqi.value == 75
        assert aqi.unit == "AQI"
        assert aqi.level == 2
        assert aqi.level_label == "良"

    def test_source_is_marked_estimated_and_carries_the_url(self, monkeypatch):
        payload = _make_air_payload(CONSTANT_CONCENTRATIONS)
        monkeypatch.setattr(
            air_quality.http, "request_json", lambda url, **kwargs: payload
        )

        result = air_quality.fetch(CITIES["barcelona"])
        source = result.metrics[0].source

        assert source.name == air_quality.SOURCE_NAME
        # CAMS 是模型再分析值 → 必须标 estimated。
        assert source.estimated is True
        assert source.url == air_quality.build_url(CITIES["barcelona"])
        assert source.realtime is True
        assert source.fetched_at.endswith("Z")
        # 观测时刻是「当前小时」那个点，不是取数时刻。
        assert source.observed_at.endswith("Z")
        assert source.observed_at != source.fetched_at

    def test_extra_explains_the_basis_and_carries_the_upstream_indices(self, monkeypatch):
        payload = _make_air_payload(CONSTANT_CONCENTRATIONS)
        monkeypatch.setattr(
            air_quality.http, "request_json", lambda url, **kwargs: payload
        )

        metrics = _by_key(air_quality.fetch(CITIES["barcelona"]))
        extra = metrics["aqi"].extra

        assert extra["aqi_basis"] == air_quality.AQI_BASIS
        assert extra["data_kind"] == air_quality.DATA_KIND
        assert extra["european_aqi"] == 40
        assert extra["us_aqi"] == 40
        # 上游的署名要求随数据一起发出去。
        assert extra["attribution"] == air_quality.ATTRIBUTION

    def test_hourly_series_covers_the_last_24_hours(self, monkeypatch):
        payload = _make_air_payload(CONSTANT_CONCENTRATIONS)
        monkeypatch.setattr(
            air_quality.http, "request_json", lambda url, **kwargs: payload
        )

        series = _series_by_key(air_quality.fetch(CITIES["barcelona"]))["aqi_24h"]
        assert len(series.points) == 24
        assert series.unit == "AQI"
        assert series.label == "24 小时 AQI"
        # 时间升序。
        times = [point.t for point in series.points]
        assert times == sorted(times)
        # 浓度恒定 → 每一点的 AQI 都是 75。
        assert [point.v for point in series.points] == [75] * 24

    def test_daily_series_keeps_only_complete_local_days(self, monkeypatch):
        payload = _make_air_payload(CONSTANT_CONCENTRATIONS)
        monkeypatch.setattr(
            air_quality.http, "request_json", lambda url, **kwargs: payload
        )

        series = _series_by_key(air_quality.fetch(CITIES["barcelona"]))["aqi_daily"]
        assert len(series.points) == 7

        times = [point.t for point in series.points]
        assert times == sorted(times)

        point = series.points[-1]
        assert point.v == 75
        assert point.values == {
            "pm25": 55.0,
            "pm10": 50.0,
            "o3": 100.0,
            "no2": 40.0,
            "so2": 50.0,
            "co": 2.0,
        }

    def test_daily_series_excludes_today_and_the_future(self, monkeypatch):
        now_epoch = _now_epoch()
        payload = _make_air_payload(CONSTANT_CONCENTRATIONS, now_epoch)
        monkeypatch.setattr(
            air_quality.http, "request_json", lambda url, **kwargs: payload
        )

        series = _series_by_key(air_quality.fetch(CITIES["barcelona"]))["aqi_daily"]
        # 今天是不完整的一天（24 小时还没走完），未来是预报 —— 都不许出现。
        today = _local_midnight(now_epoch)
        for point in series.points:
            assert datetime.fromisoformat(point.t.replace("Z", "+00:00")).timestamp() < today

    def test_sliding_window_spans_24_hours_not_one(self, monkeypatch):
        """最近 12 小时 PM2.5 = 100，其余为 0。

        24 小时滑动平均 = 50；1 小时的窗口会给出 100 —— 两者必须不同。
        """
        now_epoch = _now_epoch()
        current_index = _current_hour_index(now_epoch)
        concentrations = dict(CONSTANT_CONCENTRATIONS)
        concentrations["pm2_5"] = lambda index: 100.0 if index > current_index - 12 else 0.0
        payload = _make_air_payload(concentrations, now_epoch)
        monkeypatch.setattr(
            air_quality.http, "request_json", lambda url, **kwargs: payload
        )

        metrics = _by_key(air_quality.fetch(CITIES["barcelona"]))

        assert metrics["pm25"].value == 50.0
        # PM2.5 = 50 → IAQI 68.75 → 取整 69。
        assert metrics["aqi"].value == 69

    def test_missing_pollutant_is_none_not_zero(self, monkeypatch):
        concentrations = dict(CONSTANT_CONCENTRATIONS)
        concentrations["ozone"] = None
        payload = _make_air_payload(concentrations)
        monkeypatch.setattr(
            air_quality.http, "request_json", lambda url, **kwargs: payload
        )

        metrics = _by_key(air_quality.fetch(CITIES["barcelona"]))
        # 取不到就是 None —— 不许拿 0 冒充。
        assert metrics["o3"].value is None
        # 其余污染物照常出数，AQI 也照常算。
        assert metrics["pm25"].value == 55.0
        assert metrics["aqi"].value == 75

    def test_too_few_points_in_the_window_is_none(self, monkeypatch):
        """数据刚开头（窗口里不足 12 个点）→ 指标是 None。"""
        now_epoch = _now_epoch()
        current_hour = (now_epoch // 3600) * 3600
        payload = _make_air_payload(
            CONSTANT_CONCENTRATIONS,
            now_epoch,
            start_epoch=current_hour - 5 * 3600,
            total_points=6,
        )
        monkeypatch.setattr(
            air_quality.http, "request_json", lambda url, **kwargs: payload
        )

        metrics = _by_key(air_quality.fetch(CITIES["barcelona"]))
        assert metrics["pm25"].value is None
        assert metrics["aqi"].value is None
        assert metrics["co"].value is None

    def test_future_points_are_not_used_as_the_current_hour(self, monkeypatch):
        """最后一个 ≤ 当前时刻的点才是「当前小时」；未来的预报点不算。"""
        now_epoch = _now_epoch()
        payload = _make_air_payload(CONSTANT_CONCENTRATIONS, now_epoch)
        monkeypatch.setattr(
            air_quality.http, "request_json", lambda url, **kwargs: payload
        )

        result = air_quality.fetch(CITIES["barcelona"])
        source = result.metrics[0].source
        observed = datetime.fromisoformat(source.observed_at.replace("Z", "+00:00"))
        assert observed.timestamp() <= now_epoch
        assert now_epoch - observed.timestamp() < 3600

    def test_upstream_failure_propagates_as_unavailable(self, monkeypatch):
        def boom(url, **kwargs):
            raise SourceUnavailable("测试：上游不可用")

        monkeypatch.setattr(air_quality.http, "request_json", boom)
        with pytest.raises(SourceUnavailable):
            air_quality.fetch(CITIES["barcelona"])

    def test_broken_payload_is_unavailable(self, monkeypatch):
        monkeypatch.setattr(air_quality.http, "request_json", lambda url, **kwargs: {"nope": 1})
        with pytest.raises(SourceUnavailable):
            air_quality.fetch(CITIES["barcelona"])
