"""`GET /api/city/area` 的契约测试：按 bbox 聚合的空间统计。

**对拍是这里的核心**：每个数字都要能由「自己过滤 + 自己数」复算出来，
否则「两套算法算出两个数」这件事没人拦得住。

这些测试**一律不打真实网络**：数据是写死在临时目录里的合成 GeoJSON
（``backend-python/geojson/`` 是未入库的 OSM 抽取数据，测试不依赖它）。
"""
import json

import pytest
from fastapi.testclient import TestClient

import main
from city_data.sources import area as area_source
from city_data.sources import facilities, road_network

# 合成数据的范围（度）。
BBOX = "116.390,39.900,116.410,39.920"
BBOX_LIST = [116.390, 39.900, 116.410, 39.920]
# 一个什么都没有的范围（远离合成数据）—— 用来验证「空范围是正常结果」。
EMPTY_BBOX = "0.0,0.0,0.01,0.01"

BUILDINGS_TIMESTAMP = "2026-01-01T00:00:00Z"
ROADS_TIMESTAMP = "2026-01-02T00:00:00Z"


def _polygon(min_lon, min_lat, max_lon, max_lat, properties):
    """一个矩形建筑要素。"""
    return {
        "type": "Feature",
        "id": "way/%s" % properties.get("name", "unnamed"),
        "properties": properties,
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [min_lon, min_lat],
                [max_lon, min_lat],
                [max_lon, max_lat],
                [min_lon, max_lat],
                [min_lon, min_lat],
            ]],
        },
    }


def _line(coordinates, properties):
    """一条线要素（道路）。"""
    return {
        "type": "Feature",
        "id": "way/line",
        "properties": properties,
        "geometry": {"type": "LineString", "coordinates": coordinates},
    }


# 合成建筑：6 栋落在 BBOX 里（其中 1 栋既是医院又是历史建筑），
# 1 栋落在外面。分类预期：医疗 2、教育 1、历史 1、商业与办公 1、公共安全 0。
BUILDINGS = [
    _polygon(116.395, 39.905, 116.397, 39.907, {"name": "hospital-a", "building": "hospital"}),
    _polygon(116.395, 39.912, 116.397, 39.914, {"name": "school-a", "building": "school"}),
    _polygon(116.402, 39.905, 116.404, 39.907, {"name": "heritage-a", "historic": "yes"}),
    _polygon(116.402, 39.912, 116.404, 39.914, {"name": "office-a", "building": "office"}),
    _polygon(
        116.406,
        39.905,
        116.408,
        39.907,
        {"name": "hospital-b", "building": "hospital", "historic": "yes"},
    ),
    _polygon(116.406, 39.912, 116.408, 39.914, {"name": "plain-a", "building": "yes"}),
    _polygon(117.000, 39.000, 117.002, 39.002, {"name": "outside-a", "building": "hospital"}),
]

# 合成道路：5 条线要素（主干道 1、次干道 1、支路 1、人行道 1、其他 1）
# + 1 个广场面要素，全部落在 BBOX 里；另加 1 条落在外面的路。
ROADS = [
    _line([[116.392, 39.902], [116.408, 39.902]], {"highway": "primary"}),
    _line([[116.385, 39.918], [116.415, 39.918]], {"highway": "secondary"}),
    _line([[116.396, 39.906], [116.396, 39.916]], {"highway": "footway"}),
    _line([[116.402, 39.906], [116.402, 39.916]], {"highway": "service"}),
    _polygon(116.395, 39.916, 116.397, 39.918, {"highway": "pedestrian", "area": "yes"}),
    _line([[116.408, 39.905], [116.408, 39.915]], {"highway": "corridor"}),
    _line([[117.000, 39.000], [117.010, 39.010]], {"highway": "primary"}),
]


@pytest.fixture
def area_data(tmp_path):
    """把合成数据写成两个 GeoJSON 文件，返回它们的路径。"""
    buildings = tmp_path / "buildings.geojson"
    roads = tmp_path / "roads.geojson"
    buildings.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "timestamp": BUILDINGS_TIMESTAMP,
                "features": BUILDINGS,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    roads.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "timestamp": ROADS_TIMESTAMP,
                "features": ROADS,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return {"buildings": buildings, "roads": roads}


@pytest.fixture
def area_client(monkeypatch, area_data):
    """指向合成数据的 TestClient。"""
    monkeypatch.setattr(main, "_buildings_path", area_data["buildings"])
    monkeypatch.setattr(main, "_roads_path", area_data["roads"])
    main._clear_caches()
    with TestClient(main.app) as test_client:
        yield test_client


def _manual_stats():
    """手工统计一遍：自己过滤、自己数、自己算长度。

    刻意**不调用** ``area.aggregate_area`` —— 这个函数就是「另一套算法」的对照组。
    """
    buildings = main.processor.filter_features_by_bbox(
        {"type": "FeatureCollection", "features": BUILDINGS}, BBOX_LIST
    )
    roads = main.processor.filter_features_by_bbox(
        {"type": "FeatureCollection", "features": ROADS}, BBOX_LIST
    )
    building_features = buildings["features"]
    road_features = roads["features"]

    tier_m = {}
    total_m = 0.0
    for feature in road_features:
        geometry = feature["geometry"]
        if geometry["type"] != "LineString":
            continue
        tier = road_network.tier_of(feature["properties"].get("highway"))
        length = road_network.polyline_length_m(geometry["coordinates"])
        tier_m[tier] = tier_m.get(tier, 0.0) + length
        total_m += length

    facility_counts = {}
    for feature in building_features:
        key = facilities.classify(feature.get("properties"))
        if key is not None:
            facility_counts[key] = facility_counts.get(key, 0) + 1

    return {
        "building_count": len(building_features),
        "road_count": len(road_features),
        "road_length_m": total_m,
        "tier_m": tier_m,
        "facility_counts": facility_counts,
        "area_km2": road_network.area_km2(BBOX_LIST),
    }


class TestAreaEndpoint:
    def test_returns_a_stats_payload(self, area_client):
        response = area_client.get("/api/city/area?bbox=%s" % BBOX)

        assert response.status_code == 200
        payload = response.json()
        assert payload["bbox"] == BBOX_LIST
        assert payload["building_count"] == 6
        assert payload["road_count"] == 6
        assert payload["area_km2"] > 0
        assert payload["building_density_per_km2"] > 0

    def test_matches_a_manual_recomputation(self, area_client):
        """对拍：端点的每个数字都要等于「自己过滤 + 自己数」的结果。"""
        payload = area_client.get("/api/city/area?bbox=%s" % BBOX).json()
        expected = _manual_stats()

        assert payload["building_count"] == expected["building_count"]
        assert payload["road_count"] == expected["road_count"]
        assert payload["area_km2"] == pytest.approx(expected["area_km2"], abs=1e-4)
        assert payload["road_length_km"] == pytest.approx(expected["road_length_m"] / 1000.0, abs=1e-3)

        for tier, length_m in expected["tier_m"].items():
            assert payload["road_length_by_tier_km"][tier] == pytest.approx(
                length_m / 1000.0, abs=1e-3
            )

        for key, count in expected["facility_counts"].items():
            assert payload["facility_counts"][key] == count

    def test_building_count_matches_the_buildings_endpoint(self, area_client):
        """端点之间对拍：区域统计的建筑数 = /api/buildings 返回的要素条数。"""
        area_payload = area_client.get("/api/city/area?bbox=%s" % BBOX).json()
        buildings_payload = area_client.get("/api/buildings?bbox=%s" % BBOX).json()

        assert area_payload["building_count"] == len(buildings_payload["features"])

    def test_area_and_length_use_the_road_network_convention(self, area_client):
        """面积与路网长度的口径必须与 road_network.py 现有指标一致。"""
        payload = area_client.get("/api/city/area?bbox=%s" % BBOX).json()

        # 面积：同一个函数算出来的同一个数（精度与 road_network 的
        # coverage_area_km2 指标一致，保留 4 位小数）。
        assert payload["area_km2"] == round(road_network.area_km2(BBOX_LIST), 4)
        assert payload["area_km2"] == pytest.approx(road_network.area_km2(BBOX_LIST), abs=1e-4)

        # 长度：按 road_network 的几何口径逐条加总。
        expected_m = sum(
            road_network.polyline_length_m(feature["geometry"]["coordinates"])
            for feature in ROADS
            if feature["geometry"]["type"] == "LineString"
            and main.processor.filter_features_by_bbox(
                {"type": "FeatureCollection", "features": [feature]}, BBOX_LIST
            )["features"]
        )
        assert payload["road_length_km"] == pytest.approx(expected_m / 1000.0, abs=1e-3)

    def test_tier_breakdown_adds_up_to_the_total(self, area_client):
        """分解项之和必须与总额一致（前端画分解图时才对得上账）。"""
        payload = area_client.get("/api/city/area?bbox=%s" % BBOX).json()

        assert set(payload["road_length_by_tier_km"]) == {
            "main",
            "secondary",
            "local",
            "footway",
            "other",
        }
        assert sum(payload["road_length_by_tier_km"].values()) == pytest.approx(
            payload["road_length_km"], abs=1e-6
        )

    def test_area_features_are_counted_but_not_measured(self, area_client):
        """广场这类面要素计入道路数，但不计入路网长度。"""
        payload = area_client.get("/api/city/area?bbox=%s" % BBOX).json()

        # 6 个道路要素里有 1 个是广场面要素。
        assert payload["road_count"] == 6
        assert payload["method"]["line_features"] == 5
        assert payload["method"]["area_features"] == 1

    def test_every_number_carries_a_source(self, area_client):
        payload = area_client.get("/api/city/area?bbox=%s" % BBOX).json()

        source = payload["source"]
        assert source["name"]
        assert source["url"]
        assert source["fetched_at"]
        # 本地 OSM 快照：实测，不是模型估算。
        assert source["estimated"] is False
        assert source["realtime"] is False
        # 观测时间取 geojson 顶层的 timestamp。
        assert source["observed_at"] == BUILDINGS_TIMESTAMP

        # 每个设施分类也各自带来源。
        for category in payload["facility_categories"]:
            assert category["source"]["estimated"] is False
            assert category["source"]["observed_at"] == BUILDINGS_TIMESTAMP

    def test_method_states_the_geometry_convention(self, area_client):
        """几何折算的口径必须写进响应，不能只给数字。"""
        payload = area_client.get("/api/city/area?bbox=%s" % BBOX).json()
        method = payload["method"]

        assert "等距圆柱近似" in method["road_length"]
        assert "road_network.area_km2" in method["area"]
        assert method["density"].startswith("building_density_per_km2")
        assert method["files"] == [
            "backend-python/geojson/buildings.geojson",
            "backend-python/geojson/roads.geojson",
        ]
        # 两个数据文件各自的观测时间都可见。
        assert method["observed_at"]["buildings"] == BUILDINGS_TIMESTAMP
        assert method["observed_at"]["roads"] == ROADS_TIMESTAMP

    def test_facility_counts_use_the_shared_classification_rules(self, area_client):
        payload = area_client.get("/api/city/area?bbox=%s" % BBOX).json()

        counts = payload["facility_counts"]
        assert set(counts) == {key for key, _label, _rules in facilities.FACILITY_CATEGORIES}
        assert counts["medical"] == 2
        assert counts["education"] == 1
        assert counts["heritage"] == 1
        assert counts["commerce"] == 1
        assert counts["public_safety"] == 0
        # 一个建筑只归一类：既是医院又是历史建筑的那栋只算医疗。
        assert counts["medical"] + counts["heritage"] == 3

        labels = {item["key"]: item["label"] for item in payload["facility_categories"]}
        assert labels["medical"] == "医疗设施"

    def test_empty_range_is_a_normal_zero(self, area_client):
        """空范围 → 200 + 数字 0，不是故障。"""
        response = area_client.get("/api/city/area?bbox=%s" % EMPTY_BBOX)

        assert response.status_code == 200
        payload = response.json()
        assert payload["building_count"] == 0
        assert payload["road_count"] == 0
        assert payload["road_length_km"] == 0.0
        assert payload["building_density_per_km2"] == 0.0
        assert all(value == 0 for value in payload["facility_counts"].values())
        assert all(value == 0 for value in payload["road_length_by_tier_km"].values())
        # 面积是范围本身的面积，不是 0。
        assert payload["area_km2"] > 0

    def test_invalid_bbox_is_rejected_with_the_same_wording(self, area_client):
        """非法 bbox → 400，且原因文案与 /api/buildings 完全一致。"""
        for raw in ("1,2,3", "a,b,c,d", "116.4,39.9,116.3,39.95", "nan,39.9,116.4,39.95"):
            area_response = area_client.get("/api/city/area?bbox=%s" % raw)
            buildings_response = area_client.get("/api/buildings?bbox=%s" % raw)

            assert area_response.status_code == 400, raw
            assert area_response.json()["detail"] == buildings_response.json()["detail"], raw

    def test_missing_bbox_is_rejected(self, area_client):
        response = area_client.get("/api/city/area")

        assert response.status_code == 400
        assert "bbox" in response.json()["detail"]

    def test_missing_data_file_returns_503(self, area_client, monkeypatch, tmp_path):
        """数据文件读不到 → 503，不许返回编出来的 0。"""
        monkeypatch.setattr(main, "_buildings_path", tmp_path / "missing.geojson")
        main._clear_caches()

        response = area_client.get("/api/city/area?bbox=%s" % BBOX)

        assert response.status_code == 503
        assert response.json()["detail"] == main.DATA_UNAVAILABLE_DETAIL

    def test_response_carries_cache_and_generated_at_headers(self, area_client):
        response = area_client.get("/api/city/area?bbox=%s" % BBOX)

        assert response.headers["Cache-Control"] == "public, max-age=30"
        assert response.headers["X-Data-Generated-At"]
        assert response.headers["X-Data-Generated-At"] == response.json()["source"]["fetched_at"]


class TestAreaCache:
    def test_the_same_bbox_is_aggregated_once(self, area_client, monkeypatch):
        """同一个 bbox 重复请求只聚合一次（过滤结果与聚合结果都走缓存）。"""
        calls = []
        original = main.aggregate_area

        def counting(*args, **kwargs):
            calls.append(args[2] if len(args) > 2 else kwargs.get("bbox"))
            return original(*args, **kwargs)

        monkeypatch.setattr(main, "aggregate_area", counting)

        first = area_client.get("/api/city/area?bbox=%s" % BBOX).json()
        second = area_client.get("/api/city/area?bbox=%s" % BBOX).json()

        assert len(calls) == 1
        assert first == second
        # 缓存命中时 fetched_at 仍是**首次**取数的时间。
        assert first["source"]["fetched_at"] == second["source"]["fetched_at"]

    def test_a_different_bbox_is_aggregated_again(self, area_client, monkeypatch):
        calls = []
        original = main.aggregate_area

        def counting(*args, **kwargs):
            calls.append(1)
            return original(*args, **kwargs)

        monkeypatch.setattr(main, "aggregate_area", counting)

        area_client.get("/api/city/area?bbox=%s" % BBOX)
        area_client.get("/api/city/area?bbox=116.391,39.901,116.409,39.919")

        assert len(calls) == 2

    def test_clearing_caches_drops_the_aggregated_result(self, area_client, monkeypatch):
        calls = []
        original = main.aggregate_area

        def counting(*args, **kwargs):
            calls.append(1)
            return original(*args, **kwargs)

        monkeypatch.setattr(main, "aggregate_area", counting)

        area_client.get("/api/city/area?bbox=%s" % BBOX)
        main._clear_caches()
        area_client.get("/api/city/area?bbox=%s" % BBOX)

        assert len(calls) == 2

    def test_the_cache_is_bounded(self, area_client):
        """bbox 的取值组合无界：缓存必须有上限，不能被撑爆。"""
        for index in range(main._BBOX_CACHE_MAX_ENTRIES + 3):
            response = area_client.get(
                "/api/city/area?bbox=116.39%d,39.900,116.410,39.920" % index
            )
            assert response.status_code == 200

        assert len(main._area_stats_cache) == main._BBOX_CACHE_MAX_ENTRIES


class TestExistingEndpointsUntouched:
    """既有端点与契约零改动。"""

    def test_buildings_still_serves_a_feature_collection(self, area_client):
        payload = area_client.get("/api/buildings").json()
        assert payload["type"] == "FeatureCollection"
        assert len(payload["features"]) == len(BUILDINGS)

    def test_roads_still_serves_a_feature_collection(self, area_client):
        payload = area_client.get("/api/roads").json()
        assert payload["type"] == "FeatureCollection"
        assert len(payload["features"]) == len(ROADS)

    def test_traffic_status_keeps_its_shape(self, area_client):
        payload = area_client.get("/api/traffic-status").json()
        assert set(payload.keys()) == {
            "status",
            "congestion_level",
            "congestion",
            "flow",
            "update_time",
        }

    def test_city_overview_keeps_its_shape(self, area_client):
        payload = area_client.get("/api/city/overview").json()
        assert "metrics" in payload
        assert "facilities" in payload
        assert "events" in payload
        # CityOverview 不许被塞进 area 字段（那是另一个端点的事）。
        assert "area" not in payload


class TestAggregateAreaUnit:
    """``area.aggregate_area`` 本身的单元测试（不经过 HTTP）。"""

    def test_accepts_a_plain_feature_list(self):
        """调用方给要素列表（而不是 FeatureCollection）也认。"""
        stats = area_source.aggregate_area(BUILDINGS[:1], ROADS[:1], BBOX_LIST)

        assert stats.building_count == 1
        assert stats.road_count == 1
        assert stats.road_length_km > 0
        assert stats.bbox == BBOX_LIST

    def test_empty_inputs_produce_zeroes(self):
        stats = area_source.aggregate_area(None, None, BBOX_LIST)

        assert stats.building_count == 0
        assert stats.road_count == 0
        assert stats.road_length_km == 0.0
        assert stats.building_density_per_km2 == 0.0
        assert all(value == 0 for value in stats.facility_counts.values())
        assert all(value == 0 for value in stats.road_length_by_tier_km.values())

    def test_a_non_string_observed_at_is_dropped(self):
        """观测时间不是字符串就当没有 —— 不许编一个假时间。"""
        stats = area_source.aggregate_area([], [], BBOX_LIST, observed_at=12345)

        assert stats.source.observed_at is None

    def test_fetched_at_defaults_to_now(self):
        stats = area_source.aggregate_area([], [], BBOX_LIST)

        assert stats.source.fetched_at
        assert stats.source.estimated is False
