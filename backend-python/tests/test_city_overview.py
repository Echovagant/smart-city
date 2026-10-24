"""`GET /api/city/overview` 的契约与降级测试。

**这些测试一律不打真实网络**：远程源在**源模块层**被替换掉
（``city_data.sources.air_quality.fetch`` / ``city_data.sources.weather.fetch``），
CI 上没有外网也能跑。

为什么桩在源模块层而不是 HTTP 层：端点契约（参数、降级、缓存、序列形状）
与「上游 JSON 怎么解析」是两件事 —— 后者由源模块自己的测试负责。
桩在源模块层，这两组测试就不会互相牵制。

覆盖的硬要求：
- 每个指标都必须带 source（漏一个就红）；
- 模型估算必须标 ``estimated: true``；
- 某个源失败/超时 → 端点仍然 200，``degraded`` 列出该源，
  对应位置的指标值是 null（**不是 0**）；
- 缓存生效：连续两次请求只打一次上游，``fetched_at`` 是首次取数时间；
- 参数不合法（未知城市 id）→ 400。
"""
import time

import pytest

from city_data import aggregator, cities
from city_data.http import SourceUnavailable
from city_data.models import Metric, Series, SeriesPoint, SourceInfo, SourceResult


def _source(name, url="https://example.invalid/source", estimated=False):
    return SourceInfo(
        name=name,
        url=url,
        observed_at="2026-10-24T10:00:00Z",
        fetched_at="2026-10-24T10:00:05Z",
        realtime=True,
        estimated=estimated,
    )


def _air_result():
    """一份假的空气质量源结果（指标 + 两条序列）。"""
    source = _source("Open-Meteo 空气质量（CAMS 模型再分析）", estimated=True)
    metrics = [
        Metric(
            key="aqi",
            label="空气质量",
            value=42,
            unit="AQI",
            level=1,
            level_label="优",
            source=source,
        ),
        Metric(
            key="pm25",
            label="PM2.5",
            value=8.3,
            unit="μg/m³",
            source=source,
        ),
    ]
    series = [
        Series(
            key="aqi_24h",
            label="24 小时 AQI",
            unit="AQI",
            points=[SeriesPoint(t="2026-10-24T09:00:00Z", v=40)],
            source=source,
        ),
        Series(
            key="aqi_daily",
            label="逐日 AQI",
            unit="AQI",
            points=[
                SeriesPoint(
                    t="2026-10-23T00:00:00Z",
                    v=50,
                    values={"pm25": 26.0, "co": 0.5},
                )
            ],
            source=source,
        ),
    ]
    return SourceResult(metrics=metrics, series=series)


def _weather_result():
    source = _source("Open-Meteo 天气预报", estimated=True)
    metrics = [
        Metric(
            key="weather_temp",
            label="气温",
            value=15.8,
            unit="℃",
            source=source,
        ),
        Metric(
            key="weather_humidity",
            label="相对湿度",
            value=86,
            unit="%",
            source=source,
        ),
    ]
    return SourceResult(metrics=metrics, series=[])


@pytest.fixture(autouse=True)
def clear_aggregator_cache():
    """每个用例前后清空聚合器缓存，避免用例之间互相污染。"""
    aggregator.clear_cache()
    yield
    aggregator.clear_cache()


def _install(monkeypatch, *, air=None, weather=None, failing=(), slow=(), calls=None):
    """替换两个远程源的取数函数。

    ``failing`` / ``slow`` 里是源的**名字**片段（``"air"`` / ``"weather"``）。
    """
    air_result = air if air is not None else _air_result()
    weather_result = weather if weather is not None else _weather_result()

    def make_fetch(kind, result):
        def fetch(city, *args, **kwargs):
            if calls is not None:
                calls.append(kind)
            for token in failing:
                if token in kind:
                    raise SourceUnavailable("测试：上游不可用")
            for token in slow:
                if token in kind:
                    time.sleep(0.5)
            return result

        return fetch

    monkeypatch.setattr(
        "city_data.sources.air_quality.fetch", make_fetch("air", air_result)
    )
    monkeypatch.setattr(
        "city_data.sources.weather.fetch", make_fetch("weather", weather_result)
    )


class TestCityOverviewEndpoint:
    def test_returns_real_shaped_payload(self, client, monkeypatch):
        _install(monkeypatch)
        response = client.get("/api/city/overview?city=barcelona")

        assert response.status_code == 200
        payload = response.json()
        assert payload["city"]["id"] == "barcelona"
        assert payload["city"]["name"] == "巴塞罗那"
        assert payload["city"]["latitude"] == pytest.approx(41.3950)
        assert payload["city"]["longitude"] == pytest.approx(2.1650)
        assert payload["city"]["timezone"] == "Europe/Madrid"
        # 旧的数字代码字段已经不存在了
        assert "code" not in payload["city"]
        assert payload["generated_at"]
        assert payload["degraded"] == []

        keys = [metric["key"] for metric in payload["metrics"]]
        assert "aqi" in keys
        assert "weather_temp" in keys
        assert "road_load_index" in keys

        aqi = next(m for m in payload["metrics"] if m["key"] == "aqi")
        assert aqi["value"] == 42
        assert aqi["level_label"] == "优"

        # 两条序列都在
        series_keys = {s["key"] for s in payload["series"]}
        assert "aqi_24h" in series_keys
        assert "aqi_daily" in series_keys

    def test_every_metric_carries_a_source(self, client, monkeypatch):
        _install(monkeypatch)
        payload = client.get("/api/city/overview").json()

        assert payload["metrics"], "响应里应当有指标"
        for metric in payload["metrics"]:
            source = metric.get("source")
            assert source, "指标 %s 缺少 source" % metric["key"]
            assert source["name"]
            assert source["url"]
            assert source["fetched_at"]
            # 取不到时 observed_at 可以是 null，但键必须在
            assert "observed_at" in source
            assert isinstance(source["estimated"], bool)

    def test_estimated_flag_is_carried_through(self, client, monkeypatch):
        _install(monkeypatch)
        payload = client.get("/api/city/overview").json()

        estimated = {
            metric["key"]: metric["source"]["estimated"]
            for metric in payload["metrics"]
        }
        # 两个远程源都是模式数据 → 估算
        assert estimated["aqi"] is True
        assert estimated["weather_temp"] is True
        # 本地 OSM 快照是实测
        assert estimated["road_length_km"] is False
        assert estimated["building_count"] is False
        # 路网负载是模型估算
        assert estimated["road_load_index"] is True

    def test_degraded_source_keeps_the_endpoint_at_200(self, client, monkeypatch):
        _install(monkeypatch, failing=("air",))
        response = client.get("/api/city/overview")

        assert response.status_code == 200
        payload = response.json()
        assert "Open-Meteo 空气质量（CAMS 模型再分析）" in payload["degraded"]

        aqi = next(m for m in payload["metrics"] if m["key"] == "aqi")
        # 取不到就是 null —— **不许**拿 0 冒充
        assert aqi["value"] is None
        # 其它源照常返回
        weather = next(m for m in payload["metrics"] if m["key"] == "weather_temp")
        assert weather["value"] == 15.8
        assert next(m for m in payload["metrics"] if m["key"] == "road_load_index")["value"] is not None

    def test_degraded_placeholder_keeps_the_estimated_flag(self, client, monkeypatch):
        """降级占位也是模式来源的占位 —— 标记不能丢。"""
        _install(monkeypatch, failing=("air",))
        payload = client.get("/api/city/overview").json()

        aqi = next(m for m in payload["metrics"] if m["key"] == "aqi")
        assert aqi["value"] is None
        assert aqi["source"]["estimated"] is True

    def test_slow_source_times_out_without_slowing_the_others(self, client, monkeypatch):
        _install(monkeypatch, slow=("weather",))
        monkeypatch.setattr(aggregator, "SOURCE_TIMEOUT_SECONDS", 0.05)

        started = time.monotonic()
        response = client.get("/api/city/overview")
        elapsed = time.monotonic() - started

        assert response.status_code == 200
        payload = response.json()
        assert "Open-Meteo 天气预报" in payload["degraded"]
        weather = next(m for m in payload["metrics"] if m["key"] == "weather_temp")
        assert weather["value"] is None
        # 超时的源没有拖慢整体（上游睡了 0.5 s，整体必须明显快于它）
        assert elapsed < 0.5
        # 其它源照常有数据
        assert next(m for m in payload["metrics"] if m["key"] == "aqi")["value"] == 42

    def test_cache_hits_the_upstream_once_and_keeps_the_first_fetch_time(
        self, client, monkeypatch
    ):
        calls = []
        _install(monkeypatch, calls=calls)

        first = client.get("/api/city/overview").json()
        second = client.get("/api/city/overview").json()

        assert calls.count("air") == 1, "缓存命中时不该再打上游"
        assert calls.count("weather") == 1

        def fetched_at(payload):
            aqi = next(m for m in payload["metrics"] if m["key"] == "aqi")
            return aqi["source"]["fetched_at"]

        # fetched_at 是**首次**取数的时间，不是这次请求的时间
        assert fetched_at(first) == fetched_at(second)

    def test_response_carries_cache_and_generated_at_headers(self, client, monkeypatch):
        _install(monkeypatch)
        response = client.get("/api/city/overview")

        assert response.headers["Cache-Control"] == "public, max-age=30"
        assert response.headers["X-Data-Generated-At"]
        assert response.headers["X-Data-Generated-At"] == response.json()["generated_at"]

    def test_unknown_city_id_is_rejected(self, client, monkeypatch):
        _install(monkeypatch)
        response = client.get("/api/city/overview?city=atlantis")
        assert response.status_code == 400
        assert "city" in response.json()["detail"]

    def test_non_numeric_city_id_is_rejected(self, client, monkeypatch):
        _install(monkeypatch)
        response = client.get("/api/city/overview?city=110000")
        assert response.status_code == 400

    def test_default_city_is_the_configured_one(self, client, monkeypatch):
        _install(monkeypatch)
        payload = client.get("/api/city/overview").json()
        assert payload["city"]["id"] == cities.DEFAULT_CITY_ID

    def test_unexpected_internal_error_still_returns_200(self, client, monkeypatch):
        # 聚合器之外的意外错误也不能让大屏白屏：返回一份「全部降级」的 200。
        def boom(*args, **kwargs):
            raise RuntimeError("测试：聚合器内部炸了")

        monkeypatch.setattr(aggregator, "build_city_overview", boom)
        response = client.get("/api/city/overview")

        assert response.status_code == 200
        payload = response.json()
        assert payload["metrics"] == []
        assert "Open-Meteo 空气质量（CAMS 模型再分析）" in payload["degraded"]
        assert "Open-Meteo 天气预报" in payload["degraded"]
        assert payload["city"]["id"] == "barcelona"


class TestSeriesShape:
    """序列的点形状不许变。"""

    def test_hourly_points_keep_their_original_shape(self, client, monkeypatch):
        """多指标序列的点多了 ``values``，但 ``aqi_24h`` 的点必须仍然是
        ``{"t": ..., "v": ...}`` —— 不多一个 ``"values": null``。
        """
        _install(monkeypatch)
        payload = client.get("/api/city/overview?city=barcelona").json()

        series = {s["key"]: s for s in payload["series"]}
        assert "aqi_24h" in series
        for point in series["aqi_24h"]["points"]:
            assert set(point.keys()) == {"t", "v"}
        # 逐日序列的点才带 values
        assert "values" in series["aqi_daily"]["points"][-1]
        assert series["aqi_daily"]["points"][-1]["values"]["pm25"] == 26.0


class TestExistingEndpointsUntouched:
    """既有端点的契约不许被改动。"""

    def test_buildings_still_serves_a_feature_collection(self, client):
        payload = client.get("/api/buildings").json()
        assert payload["type"] == "FeatureCollection"
        assert len(payload["features"]) == 3

    def test_roads_still_serves_a_feature_collection(self, client):
        payload = client.get("/api/roads").json()
        assert payload["type"] == "FeatureCollection"
        assert len(payload["features"]) == 3

    def test_traffic_status_keeps_its_shape(self, client):
        payload = client.get("/api/traffic-status").json()
        assert set(payload.keys()) == {
            "status",
            "congestion_level",
            "congestion",
            "flow",
            "update_time",
        }

    def test_bbox_validation_is_unchanged(self, client):
        response = client.get("/api/buildings?bbox=1,2,3")
        assert response.status_code == 400
        assert "bbox" in response.json()["detail"]
