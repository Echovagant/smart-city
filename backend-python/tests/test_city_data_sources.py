"""城市数据层：各数据源的单元测试。

**这些测试一律不打真实网络。**
上游响应全部是写死的假数据（CI 上没有外网，而且真实网络会让测试变慢又flaky）。

覆盖的解析坑（都是实测踩出来的）：
- ``TimePoint`` 的两种格式（``/Date(...)/`` 与不带时区的 ISO）；
- AQI 是字符串，必须转数字；
- 天气的时间戳只有 ``HH:MM``，日期要推断，且可能不新鲜；
- 路网长度要自己算（等距圆柱近似）。
"""
import json
import math
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import pytest

from city_data import city_codes, http
from city_data.http import SourceUnavailable
from city_data.sources import air_quality, road_network, weather

CHINA_TZ = timezone(timedelta(hours=8))


# ---------------------------------------------------------------------------
# HTTP 封装
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

    def test_decodes_utf8_when_charset_is_missing(self, monkeypatch):
        # 中国天气网返回的是 text/html（没有 charset）——必须按 UTF-8 解，
        # 否则中文全是乱码。
        payload = '{"city": "北京"}'.encode("utf-8")
        monkeypatch.setattr(
            http.urllib.request, "urlopen", lambda *a, **k: _FakeResponse(payload)
        )
        assert http.request_json("https://example.invalid/x") == {"city": "北京"}

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
        # 上游对不存在的 cityid 返回的是 HTML 错误页
        monkeypatch.setattr(
            http.urllib.request,
            "urlopen",
            lambda *a, **k: _FakeResponse(b"<html>404</html>"),
        )
        with pytest.raises(SourceUnavailable):
            http.request_json("https://example.invalid/x")

    def test_sends_user_agent(self, monkeypatch):
        seen = {}

        def fake(request, timeout=None):
            seen["agent"] = request.get_header("User-agent")
            seen["timeout"] = timeout
            return _FakeResponse(b"{}")

        monkeypatch.setattr(http.urllib.request, "urlopen", fake)
        http.request_json("https://example.invalid/x", timeout=3.5)
        assert "smart-city" in seen["agent"]
        assert seen["timeout"] == 3.5


# ---------------------------------------------------------------------------
# 空气质量
# ---------------------------------------------------------------------------

REALTIME_PAYLOAD = [
    {
        "TimePoint": "2026-10-22T12:00:00",
        "AQI": "51",
        "AqiLevel": 2,
        "PrimaryPollutant": "颗粒物(PM10)",
        "Quality": "良",
        "Measure": "极少数异常敏感人群应减少户外活动",
        "Area": "北京市",
        "CityCode": 110000,
        "Latitude": "40.059588086956521739130434783",
        "Longitude": "116.40260991304347826086956522",
    }
]

HISTORY_PAYLOAD = [
    {
        "TimePoint": "/Date(1792558800000)/",
        "TimePointStr": "21日13时",
        "AQI": "16",
        "CO": "0.3",
        "NO2": "5",
        "O3": "51",
        "PM10": "9",
        "PM2_5": "3",
        "SO2": "3",
        "Quality": "优",
    },
    {
        "TimePoint": "/Date(1792641600000)/",
        "TimePointStr": "22日12时",
        "AQI": "60",
        "CO": "0.5",
        "NO2": "30",
        "O3": "44",
        "PM10": "64",
        "PM2_5": "32",
        "SO2": "4",
        "Quality": "良",
    },
]


# 逐日历史（实测上游给的就是倒序 newest-first，且字段带 _24h 后缀）
# 这两行是 2026-10-22 实测 cnemc 返回的原值。
DAILY_HISTORY_PAYLOAD = [
    {
        "TimePoint": "/Date(1792598400000)/",
        "TimePointStr": "22日",
        "AQI": "50",
        "PM2_5_24h": "26",
        "PM10_24h": "50",
        "O3_8h_24h": "62",
        "NO2_24h": "31",
        "SO2_24h": "3",
        "CO_24h": "0.5",
        "Quality": "良",
        "CityCode": 110000,
    },
    {
        "TimePoint": "/Date(1791561600000)/",
        "TimePointStr": "10日",
        "AQI": "93",
        "PM2_5_24h": "46",
        "PM10_24h": "84",
        "O3_8h_24h": "151",
        "NO2_24h": "31",
        "SO2_24h": "4",
        "CO_24h": "0.7",
        "Quality": "良",
        "CityCode": 110000,
    },
]


class TestTimePoint:
    def test_parses_dotnet_date_format(self):
        # "/Date(1792558800000)/" —— .NET 的毫秒时间戳
        parsed = air_quality.parse_time_point("/Date(1792558800000)/")
        assert parsed is not None
        assert parsed.tzinfo is not None
        assert parsed == datetime(2026, 10, 21, 5, 0, tzinfo=timezone.utc)

    def test_parses_naive_iso_as_china_time(self):
        # 不带时区的 ISO 按北京时间理解（上游服务器在北京）
        parsed = air_quality.parse_time_point("2026-10-22T12:00:00")
        assert parsed == datetime(2026, 10, 22, 4, 0, tzinfo=timezone.utc)

    def test_rejects_garbage(self):
        assert air_quality.parse_time_point("not a time") is None
        assert air_quality.parse_time_point("") is None
        assert air_quality.parse_time_point(None) is None
        assert air_quality.parse_time_point("/Date(abc)/") is None


class TestAirQualityRealtime:
    def test_finds_city_by_code(self):
        found = air_quality.find_city(REALTIME_PAYLOAD, 110000)
        assert found is not None
        assert found["Area"] == "北京市"

    def test_missing_city_returns_none(self):
        assert air_quality.find_city(REALTIME_PAYLOAD, 999999) is None
        assert air_quality.find_city({"not": "a list"}, 110000) is None

    def test_fetch_realtime_produces_metric_with_source(self, monkeypatch):
        calls = []

        def fake_request(url, **kwargs):
            calls.append((url, kwargs.get("method", "GET")))
            return REALTIME_PAYLOAD

        monkeypatch.setattr(air_quality.http, "request_json", fake_request)

        result = air_quality.fetch_realtime(110000)

        assert len(result.metrics) == 1
        metric = result.metrics[0]
        assert metric.key == "aqi"
        # AQI 上游是字符串，必须转成数字
        assert metric.value == 51
        assert metric.level == 2
        assert metric.level_label == "良"
        assert metric.extra["primary_pollutant"] == "颗粒物(PM10)"
        # 来源标注：实测，不是估算
        assert metric.source.name == air_quality.SOURCE_NAME
        assert metric.source.estimated is False
        assert metric.source.observed_at is not None
        assert metric.source.fetched_at is not None
        assert result.city["name"] == "北京市"
        assert result.city["latitude"] == pytest.approx(40.0595, abs=1e-3)
        # 实时的取数是 GET
        assert calls == [(air_quality.REALTIME_URL, "GET")]

    def test_unknown_city_raises_unavailable(self, monkeypatch):
        monkeypatch.setattr(
            air_quality.http, "request_json", lambda url, **kwargs: REALTIME_PAYLOAD
        )
        with pytest.raises(SourceUnavailable):
            air_quality.fetch_realtime(999999)


class TestAirQualityHistory:
    def test_parse_history_sorts_by_time(self):
        rows = air_quality.parse_history(HISTORY_PAYLOAD)
        assert len(rows) == 2
        assert rows[0]["t"] < rows[1]["t"]
        # 污染物是字符串，要转成数字
        assert rows[1]["pm25"] == 32.0
        assert rows[1]["co"] == 0.5
        assert rows[1]["aqi"] == 60.0

    def test_parse_history_ignores_broken_rows(self):
        rows = air_quality.parse_history([{"TimePoint": "nope"}, "not a dict"])
        assert rows == []

    def test_fetch_history_uses_post_with_empty_body(self, monkeypatch):
        calls = []

        def fake_request(url, **kwargs):
            calls.append((url, kwargs.get("method"), kwargs.get("data")))
            return HISTORY_PAYLOAD

        monkeypatch.setattr(air_quality.http, "request_json", fake_request)

        result = air_quality.fetch_history(110000)

        # 历史接口必须 POST 且 body 为空对象；用 GET 会 404
        assert calls[0][1] == "POST"
        assert calls[0][2] == b"{}"
        assert len(result.metrics) == 6
        keys = [metric.key for metric in result.metrics]
        assert keys == ["pm25", "pm10", "o3", "no2", "so2", "co"]
        # 最新一个小时的浓度
        assert result.metrics[0].value == 32.0
        assert result.metrics[0].source.estimated is False
        # 24 小时序列
        assert len(result.series) == 1
        assert result.series[0].key == "aqi_24h"
        assert len(result.series[0].points) == 2

    def test_empty_history_raises_unavailable(self, monkeypatch):
        monkeypatch.setattr(air_quality.http, "request_json", lambda url, **kwargs: [])
        with pytest.raises(SourceUnavailable):
            air_quality.fetch_history(110000)


class TestAirQualityDailyHistory:
    """逐日历史（14 天，日均值）。

    字段名与逐小时**不一样**：逐日是 24 小时均值，字段都带 ``_24h``，
    O3 是 ``O3_8h_24h``（8 小时最大值的日平均）。
    """

    def test_parse_daily_history_sorts_by_time(self):
        # 夹具是**倒序**的（上游就是这样给的）→ 解析后必须按时间升序
        rows = air_quality.parse_daily_history(DAILY_HISTORY_PAYLOAD)
        assert len(rows) == 2
        assert rows[0]["t"] < rows[1]["t"]
        # 污染物是字符串，要转成数字
        assert rows[1]["pm25"] == 26.0
        assert rows[1]["co"] == 0.5
        assert rows[1]["aqi"] == 50.0
        # O3 的日均值走的是 O3_8h_24h 字段
        assert rows[1]["o3"] == 62.0

    def test_parse_daily_history_ignores_broken_rows(self):
        rows = air_quality.parse_daily_history([{"TimePoint": "nope"}, "not a dict"])
        assert rows == []

    def test_parse_daily_history_accepts_the_iso_time_point(self):
        # 两种 TimePoint 格式都要能解析（与逐小时历史同一套解析器）
        rows = air_quality.parse_daily_history(
            [{"TimePoint": "2026-10-22T00:00:00", "AQI": "50"}]
        )
        assert len(rows) == 1
        assert rows[0]["t"] == "2026-10-21T16:00:00Z"

    def test_fetch_daily_history_uses_post_with_empty_body(self, monkeypatch):
        calls = []

        def fake_request(url, **kwargs):
            calls.append((url, kwargs.get("method"), kwargs.get("data"), kwargs.get("headers")))
            return DAILY_HISTORY_PAYLOAD

        monkeypatch.setattr(air_quality.http, "request_json", fake_request)

        result = air_quality.fetch_daily_history(110000)

        # 逐日接口同样必须 POST 且 body 为空对象；用 GET 会 404
        assert calls[0][1] == "POST"
        assert calls[0][2] == b"{}"
        # cnemc 要求带 Referer
        assert calls[0][3]["Referer"] == air_quality.BASE_URL + "/"
        # 这一条只产序列，不产指标（指标带已经有逐小时的浓度了）
        assert result.metrics == []
        assert len(result.series) == 1
        assert result.series[0].key == "aqi_daily"
        assert len(result.series[0].points) == 2

    def test_fetch_daily_history_points_carry_every_pollutant(self, monkeypatch):
        monkeypatch.setattr(
            air_quality.http, "request_json", lambda url, **kwargs: DAILY_HISTORY_PAYLOAD
        )

        result = air_quality.fetch_daily_history(110000)
        point = result.series[0].points[-1]

        # AQI 放在 v 里 —— 折线图组件不用改就能画
        assert point.v == 50.0
        # 各项污染物的日均值放在 values 里，键与指标 key 一致
        assert point.values is not None
        assert point.values["pm25"] == 26.0
        assert point.values["pm10"] == 50.0
        assert point.values["o3"] == 62.0
        assert point.values["no2"] == 31.0
        assert point.values["so2"] == 3.0
        assert point.values["co"] == 0.5
        # 来源标注：实测，不是估算；逐日数据按定义不是实时的
        assert result.series[0].source.name == air_quality.DAILY_SOURCE_NAME
        assert result.series[0].source.estimated is False
        assert result.series[0].source.realtime is False

    def test_empty_daily_history_raises_unavailable(self, monkeypatch):
        monkeypatch.setattr(air_quality.http, "request_json", lambda url, **kwargs: [])
        with pytest.raises(SourceUnavailable):
            air_quality.fetch_daily_history(110000)


# ---------------------------------------------------------------------------
# 天气
# ---------------------------------------------------------------------------

WEATHER_PAYLOAD = {
    "weatherinfo": {
        "city": "北京",
        "cityid": "101010100",
        "temp": "18",
        "WD": "东南风",
        "WS": "1级",
        "SD": "17%",
        "time": "17:05",
        "rain": "0",
    }
}


class TestWeather:
    def test_observed_at_uses_today_when_in_the_past(self):
        # 本地时间 2026-10-22 18:00（= 10:00 UTC）→ 上游的 17:05 是 55 分钟前
        now = datetime(2026, 10, 22, 10, 0, tzinfo=timezone.utc)
        parsed = weather.parse_weather(WEATHER_PAYLOAD, now)
        assert parsed["observed_at"] == datetime(2026, 10, 22, 9, 5, tzinfo=timezone.utc)
        assert parsed["realtime"] is True

    def test_observed_at_rolls_back_a_day_when_in_the_future(self):
        # 本地时间 2026-10-22 12:00（= 04:00 UTC）→ 上游报的 17:05 落在未来，
        # 说明它不是今天的读数：回退一天，并如实标成「不是实时」。
        now = datetime(2026, 10, 22, 4, 0, tzinfo=timezone.utc)
        parsed = weather.parse_weather(WEATHER_PAYLOAD, now)
        assert parsed["observed_at"] == datetime(2026, 10, 21, 9, 5, tzinfo=timezone.utc)
        assert parsed["realtime"] is False

    def test_stale_weather_is_not_realtime(self):
        # 本地时间 2026-10-22 07:00（= 23:00 UTC 前一天）→ 观测已超过 1 小时
        now = datetime(2026, 10, 22, 23, 0, tzinfo=timezone.utc)
        parsed = weather.parse_weather(WEATHER_PAYLOAD, now)
        assert parsed["realtime"] is False

    def test_fetch_produces_metrics_with_source(self, monkeypatch):
        monkeypatch.setattr(
            weather.http, "request_json", lambda url, **kwargs: WEATHER_PAYLOAD
        )
        result = weather.fetch(110000)
        keys = [metric.key for metric in result.metrics]
        assert keys == ["weather_temp", "weather_humidity"]
        assert result.metrics[0].value == 18.0
        assert result.metrics[0].unit == "℃"
        assert result.metrics[1].value == 17.0
        assert result.metrics[0].extra["direction"] == "东南风"
        assert result.metrics[0].source.estimated is False

    def test_city_without_known_cityid_is_unavailable(self, monkeypatch):
        monkeypatch.setattr(
            weather.http, "request_json", lambda url, **kwargs: WEATHER_PAYLOAD
        )
        # 实测只有北京通，其它城市直接判为不可用，不瞎试别的 cityid
        with pytest.raises(SourceUnavailable):
            weather.fetch(310000)

    def test_non_json_response_is_unavailable(self, monkeypatch):
        # 上游对不存在的 cityid 返回的是 HTML 错误页
        def boom(url, **kwargs):
            raise SourceUnavailable("响应不是 JSON")

        monkeypatch.setattr(weather.http, "request_json", boom)
        with pytest.raises(SourceUnavailable):
            weather.fetch(110000)


# ---------------------------------------------------------------------------
# 本地路网
# ---------------------------------------------------------------------------


def _write_geojson(path, features, timestamp="2026-06-21T11:40:10Z"):
    path.write_text(
        json.dumps(
            {"type": "FeatureCollection", "timestamp": timestamp, "features": features},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return path


def _line(highway, coords):
    return {
        "type": "Feature",
        "properties": {"highway": highway},
        "geometry": {"type": "LineString", "coordinates": coords},
    }


def _polygon(name):
    return {
        "type": "Feature",
        "properties": {"name": name},
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]],
        },
    }


class TestRoadNetwork:
    def test_tier_matches_frontend_tiers(self):
        assert road_network.tier_of("primary") == "main"
        assert road_network.tier_of("trunk") == "main"
        assert road_network.tier_of("secondary") == "secondary"
        assert road_network.tier_of("residential") == "local"
        assert road_network.tier_of("footway") == "footway"
        # 不在分级表里的一律落到「其他」
        assert road_network.tier_of("living_street") == "other"
        assert road_network.tier_of("primary_link") == "other"
        assert road_network.tier_of(None) == "other"

    def test_polyline_length_is_about_right(self):
        # 天安门一带：1 度经度约 85.3 km，1 度纬度约 111.3 km
        length = road_network.polyline_length_m([[116.0, 39.9], [116.01, 39.9]])
        assert length == pytest.approx(853, rel=0.02)
        length = road_network.polyline_length_m([[116.0, 39.9], [116.0, 39.91]])
        assert length == pytest.approx(1113, rel=0.02)

    def test_load_index_is_deterministic(self):
        first, extra = road_network.compute_load_index(3854, 202.1729)
        second, _ = road_network.compute_load_index(3854, 202.1729)
        assert first == second
        assert 0 <= first <= 100
        assert extra["inputs"]["buildings_per_km_road"] == pytest.approx(19.0629, abs=1e-3)

    def test_load_index_is_capped(self):
        value, _ = road_network.compute_load_index(100000, 1.0)
        assert value == 100.0

    def test_fetch_produces_measured_and_estimated_metrics(self, tmp_path):
        buildings = _write_geojson(tmp_path / "buildings.geojson", [_polygon("a"), _polygon("b")])
        roads = _write_geojson(
            tmp_path / "roads.geojson",
            [
                _line("primary", [[116.0, 39.9], [116.01, 39.9]]),
                _line("footway", [[116.0, 39.9], [116.001, 39.9]]),
                _polygon("plaza"),
            ],
        )

        result = road_network.fetch(buildings, roads)
        by_key = {metric.key: metric for metric in result.metrics}

        assert by_key["building_count"].value == 2
        assert by_key["road_count"].value == 3
        assert by_key["road_count"].extra["line_features"] == 2
        assert by_key["road_count"].extra["area_features"] == 1
        assert by_key["road_count_main"].value == 1
        assert by_key["road_count_footway"].value == 1
        assert by_key["road_length_km"].value > 0
        # 实测指标：estimated 为 False
        assert by_key["road_length_km"].source.estimated is False
        # 模型估算指标：必须标 True
        assert by_key["road_load_index"].source.estimated is True
        assert "模型估算" in by_key["road_load_index"].label
        # 观测时间取自 OSM 抽取的时间戳
        assert by_key["building_count"].source.observed_at == "2026-06-21T11:40:10Z"


# ---------------------------------------------------------------------------
# 代码表
# ---------------------------------------------------------------------------


class TestCityCodes:
    def test_known_codes(self):
        assert city_codes.is_known_city_code(110000)
        assert city_codes.is_known_city_code(310000)
        # 只有省份、没有城市条目的代码也在表里
        assert city_codes.is_known_city_code(130000)
        assert not city_codes.is_known_city_code(999999)
        assert not city_codes.is_known_city_code(0)

    def test_weather_cityid_only_for_beijing(self):
        assert city_codes.WEATHER_CITY_IDS == {110000: "101010100"}

    def test_codes_only_no_region_names(self):
        """代码表里**只有代码**，没有行政区划名称。

        这条是公开仓库的硬约束：仓库里不留行政区划名录。
        校验能力靠纯数字白名单，名称由上游实时接口给出。
        """
        assert not hasattr(city_codes, "PROVINCE_NAMES")
        assert not hasattr(city_codes, "city_name")
        assert all(isinstance(code, int) for code in city_codes.KNOWN_CODES)
        # 城市代码与省份代码有 4 个重合（北京/天津/上海/重庆），
        # 所以并集不是两者之和 —— 断言集合相等，不���长度相加。
        assert city_codes.KNOWN_CODES == (
            city_codes.CITY_CODES | city_codes.PROVINCE_CODES
        )
        assert len(city_codes.KNOWN_CODES) == 368
