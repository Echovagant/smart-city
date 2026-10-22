"""`GET /api/city/overview` 的契约与降级测试。

**这些测试一律不打真实网络**：上游响应是写死的假数据
（``city_data.http.request_json`` 被替换掉），CI 上没有外网也能跑。

覆盖的硬要求：
- 每个指标都必须带 source（漏一个就红）；
- 模型估算必须标 ``estimated: true``；
- 某个源失败/超时 → 端点仍然 200，``degraded`` 列出该源，
  对应位置的指标值是 null（**不是 0**）；
- 缓存生效：连续两次请求只打一次上游，``fetched_at`` 是首次取数时间；
- 参数不合法（未知城市代码）→ 400。
"""
import time

import pytest
from fastapi.testclient import TestClient

import main
from city_data import aggregator
from city_data.http import SourceUnavailable

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
        "TimePoint": "/Date(1792641600000)/",
        "AQI": "60",
        "CO": "0.5",
        "NO2": "30",
        "O3": "44",
        "PM10": "64",
        "PM2_5": "32",
        "SO2": "4",
    }
]

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


@pytest.fixture(autouse=True)
def clear_aggregator_cache():
    """每个用例前后清空聚合器缓存，避免用例之间互相污染。"""
    aggregator.clear_cache()
    yield
    aggregator.clear_cache()


def _fake_upstream(calls=None, failing=(), slow=()):
    """造一个假的 request_json。

    ``failing`` 里的片段出现在 URL 里就抛异常；
    ``slow`` 里的片段出现在 URL 里就睡一会儿（用来测超时）。
    """

    def fake(url, **kwargs):
        if calls is not None:
            calls.append(url)
        for token in failing:
            if token in url:
                raise SourceUnavailable("测试：上游不可用")
        for token in slow:
            if token in url:
                time.sleep(0.5)
        if "GetAllCityRealTimeAQIModels" in url:
            return REALTIME_PAYLOAD
        if "GetCityRealTimeAqiHistoryByCondition" in url:
            return HISTORY_PAYLOAD
        if "weather.com.cn" in url:
            return WEATHER_PAYLOAD
        raise SourceUnavailable("测试：未知地址 " + url)

    return fake


def _install(monkeypatch, **kwargs):
    calls = kwargs.pop("calls", None)
    monkeypatch.setattr("city_data.http.request_json", _fake_upstream(calls=calls, **kwargs))


class TestCityOverviewEndpoint:
    def test_returns_real_shaped_payload(self, client, monkeypatch):
        _install(monkeypatch)
        response = client.get("/api/city/overview?cityCode=110000")

        assert response.status_code == 200
        payload = response.json()
        assert payload["city"]["code"] == 110000
        assert payload["city"]["name"] == "北京市"
        assert payload["generated_at"]
        assert payload["degraded"] == []

        keys = [metric["key"] for metric in payload["metrics"]]
        assert "aqi" in keys
        assert "weather_temp" in keys
        assert "road_load_index" in keys

        aqi = next(m for m in payload["metrics"] if m["key"] == "aqi")
        assert aqi["value"] == 51
        assert aqi["level_label"] == "良"

        # 24 小时序列
        assert any(s["key"] == "aqi_24h" for s in payload["series"])

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

    def test_estimated_flag_marks_the_model_metric_only(self, client, monkeypatch):
        _install(monkeypatch)
        payload = client.get("/api/city/overview").json()

        estimated = {
            metric["key"]: metric["source"]["estimated"]
            for metric in payload["metrics"]
        }
        # 路网负载是模型估算
        assert estimated["road_load_index"] is True
        # 其余都是实测
        assert estimated["aqi"] is False
        assert estimated["weather_temp"] is False
        assert estimated["road_length_km"] is False
        assert estimated["building_count"] is False

    def test_degraded_source_keeps_the_endpoint_at_200(self, client, monkeypatch):
        _install(monkeypatch, failing=("GetAllCityRealTimeAQIModels",))
        response = client.get("/api/city/overview")

        assert response.status_code == 200
        payload = response.json()
        assert "中国环境监测总站" in payload["degraded"]

        aqi = next(m for m in payload["metrics"] if m["key"] == "aqi")
        # 取不到就是 null —— **不许**拿 0 冒充
        assert aqi["value"] is None
        # 其它源照常返回
        weather = next(m for m in payload["metrics"] if m["key"] == "weather_temp")
        assert weather["value"] == 18.0
        assert next(m for m in payload["metrics"] if m["key"] == "road_load_index")["value"] is not None

    def test_slow_source_times_out_without_slowing_the_others(self, client, monkeypatch):
        _install(monkeypatch, slow=("weather.com.cn",))
        monkeypatch.setattr(aggregator, "SOURCE_TIMEOUT_SECONDS", 0.05)

        started = time.monotonic()
        response = client.get("/api/city/overview")
        elapsed = time.monotonic() - started

        assert response.status_code == 200
        payload = response.json()
        assert "中国天气网" in payload["degraded"]
        weather = next(m for m in payload["metrics"] if m["key"] == "weather_temp")
        assert weather["value"] is None
        # 超时的源没有拖慢整体（上游睡了 0.5 s，整体必须明显快于它）
        assert elapsed < 0.5
        # 其它源照常有数据
        assert next(m for m in payload["metrics"] if m["key"] == "aqi")["value"] == 51

    def test_cache_hits_the_upstream_once_and_keeps_the_first_fetch_time(
        self, client, monkeypatch
    ):
        calls = []
        _install(monkeypatch, calls=calls)

        first = client.get("/api/city/overview").json()
        second = client.get("/api/city/overview").json()

        realtime_calls = [url for url in calls if "GetAllCityRealTimeAQIModels" in url]
        assert len(realtime_calls) == 1, "缓存命中时不该再打上游"

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

    def test_unknown_city_code_is_rejected(self, client, monkeypatch):
        _install(monkeypatch)
        response = client.get("/api/city/overview?cityCode=999999")
        assert response.status_code == 400
        assert "cityCode" in response.json()["detail"]

    def test_non_numeric_city_code_is_rejected(self, client, monkeypatch):
        _install(monkeypatch)
        response = client.get("/api/city/overview?cityCode=abc")
        assert response.status_code == 400

    def test_default_city_code_is_beijing(self, client, monkeypatch):
        _install(monkeypatch)
        payload = client.get("/api/city/overview").json()
        assert payload["city"]["code"] == 110000

    def test_unexpected_internal_error_still_returns_200(self, client, monkeypatch):
        # 聚合器之外的意外错误也不能让大屏白屏：返回一份「全部降级」的 200。
        def boom(*args, **kwargs):
            raise RuntimeError("测试：聚合器内部炸了")

        monkeypatch.setattr(aggregator, "build_city_overview", boom)
        response = client.get("/api/city/overview")

        assert response.status_code == 200
        payload = response.json()
        assert payload["metrics"] == []
        assert "中国环境监测总站" in payload["degraded"]
        assert "中国天气网" in payload["degraded"]
        assert payload["city"]["code"] == 110000


class TestExistingEndpointsUntouched:
    """既有端点的契约不许被这一轮改动。"""

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
