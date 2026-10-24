"""Plan 011 的用例：bbox 过滤的语义不变性 + 过滤结果缓存。

与 plan 010 的 test_api.py / test_data_processor.py 分开成文件，
是为了让本计划能与 010 / 012 并行执行而不产生合并冲突。

核心断言只有一条：**过滤结果必须与优化前完全一致**。
做法是把「优化前」的朴素实现（shapely 直接循环）当作参照实现写在这里，
逐个要素比对结果，而不是只比数量。
"""
import json
import sys
from pathlib import Path

import pytest
from shapely.geometry import shape

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import main  # noqa: E402
from data_processor import DataProcessor, DataProcessorError  # noqa: E402

# 真实 OSM 提取数据（未纳入版本管理），缺失时相关用例跳过。
OSM_BUILDINGS = ROOT / "geojson" / "barcelona" / "buildings.geojson"

requires_osm_data = pytest.mark.skipif(
    not OSM_BUILDINGS.exists(),
    reason=(
        "OSM 提取数据不存在（backend-python/geojson/<城市 id>/buildings.geojson）；"
        "用 backend-python/scripts/fetch_osm_data.py 重新抓取"
        "（用法见 backend-python/scripts/README.md）"
    ),
)

# 测试用 bbox：0,0,1,1
BBOX = [0.0, 0.0, 1.0, 1.0]


# --- 参照实现（= 优化前的朴素写法） ------------------------------------------


def _reference_filter(geojson, bbox):
    """优化前的 filter_features_by_bbox：逐要素解析几何 + intersects。

    新实现必须与它给出完全相同的结果（同样的要素、同样的顺序）。
    """
    min_lon, min_lat, max_lon, max_lat = bbox
    bbox_poly = shape(
        {
            "type": "Polygon",
            "coordinates": [[
                [min_lon, min_lat],
                [max_lon, min_lat],
                [max_lon, max_lat],
                [min_lon, max_lat],
                [min_lon, min_lat],
            ]],
        }
    )
    kept = []
    for feature in geojson.get("features", []):
        if shape(feature["geometry"]).intersects(bbox_poly):
            kept.append(feature)
    return {"type": "FeatureCollection", "features": kept}


# --- 构造测试要素 -------------------------------------------------------------


def _polygon(min_lon, min_lat, max_lon, max_lat):
    return {
        "type": "Polygon",
        "coordinates": [[
            [min_lon, min_lat],
            [max_lon, min_lat],
            [max_lon, max_lat],
            [min_lon, max_lat],
            [min_lon, min_lat],
        ]],
    }


def _multipolygon(min_lon, min_lat, max_lon, max_lat):
    return {
        "type": "MultiPolygon",
        "coordinates": [[
            [
                [min_lon, min_lat],
                [max_lon, min_lat],
                [max_lon, max_lat],
                [min_lon, max_lat],
                [min_lon, min_lat],
            ]
        ]],
    }


def _linestring(min_lon, min_lat, max_lon, max_lat):
    return {"type": "LineString", "coordinates": [[min_lon, min_lat], [max_lon, max_lat]]}


def _multilinestring(min_lon, min_lat, max_lon, max_lat):
    return {
        "type": "MultiLineString",
        "coordinates": [[[min_lon, min_lat], [max_lon, max_lat]]],
    }


def _point(lon, lat):
    return {"type": "Point", "coordinates": [lon, lat]}


def _multipoint(lon, lat):
    return {"type": "MultiPoint", "coordinates": [[lon, lat]]}


def _feature(name, geometry):
    return {"type": "Feature", "properties": {"name": name}, "geometry": geometry}


def _collection(*features):
    return {"type": "FeatureCollection", "features": list(features)}


# 各种几何类型 × 各种位置（内部 / 外部 / 跨界 / 正好压在边界上）
MIXED_FEATURES = [
    _feature("polygon-inside", _polygon(0.2, 0.2, 0.4, 0.4)),
    _feature("polygon-outside", _polygon(2.0, 2.0, 3.0, 3.0)),
    _feature("polygon-crossing", _polygon(0.8, 0.8, 1.2, 1.2)),
    _feature("multipolygon-inside", _multipolygon(0.1, 0.1, 0.2, 0.2)),
    _feature("multipolygon-outside", _multipolygon(5.0, 5.0, 6.0, 6.0)),
    _feature("linestring-inside", _linestring(0.1, 0.1, 0.9, 0.9)),
    _feature("linestring-outside", _linestring(3.0, 3.0, 4.0, 4.0)),
    _feature("linestring-crossing", _linestring(0.5, 0.5, 1.5, 1.5)),
    _feature("multilinestring-inside", _multilinestring(0.3, 0.3, 0.7, 0.7)),
    _feature("multilinestring-outside", _multilinestring(6.0, 6.0, 7.0, 7.0)),
    _feature("point-inside", _point(0.5, 0.5)),
    _feature("point-outside", _point(4.0, 4.0)),
    _feature("multipoint-inside", _multipoint(0.25, 0.75)),
    _feature("multipoint-outside", _multipoint(7.0, 7.0)),
    # 正好压在 bbox 边界上：闭区间语义下必须保留
    _feature("polygon-on-edge", _polygon(1.0, 0.5, 1.5, 0.6)),
    _feature("point-on-corner", _point(1.0, 1.0)),
]


@pytest.fixture
def processor():
    return DataProcessor("./data")


@pytest.fixture(autouse=True)
def reset_caches():
    """每个用例前后清空全部模块级缓存（含本计划新增的 bbox 过滤缓存）。"""
    main._clear_caches()
    yield
    main._clear_caches()


# --- 过滤语义：结果必须与优化前一致 -------------------------------------------


def test_filter_matches_reference_implementation(processor):
    """各种几何类型 × 各种位置：结果必须与朴素实现逐要素一致。"""
    geojson = _collection(*MIXED_FEATURES)
    expected = _reference_filter(geojson, BBOX)
    actual = processor.filter_features_by_bbox(geojson, BBOX)

    assert [f["properties"]["name"] for f in actual["features"]] == [
        f["properties"]["name"] for f in expected["features"]
    ]
    # 逐要素比对（不只比数量）
    assert actual["features"] == expected["features"]


def test_filter_returns_exact_count(processor):
    """精确数量断言，不是 "<= 完整数" 这种恒真断言。"""
    geojson = _collection(*MIXED_FEATURES)
    result = processor.filter_features_by_bbox(geojson, BBOX)
    expected = _reference_filter(geojson, BBOX)
    assert len(result["features"]) == len(expected["features"])
    # 16 个要素里保留 10 个（内部 7 + 跨界 1 + 压边 2）
    assert len(result["features"]) == 10


def test_filter_is_idempotent(processor):
    """同样的输入调用两次，结果必须完全相同。"""
    geojson = _collection(*MIXED_FEATURES)
    first = processor.filter_features_by_bbox(geojson, BBOX)
    second = processor.filter_features_by_bbox(geojson, BBOX)
    assert first == second


def test_filter_excludes_feature_outside_range(processor):
    """范围与 bbox 完全不相交的几何被排除。"""
    geojson = _collection(
        _feature("outside", _polygon(2.0, 2.0, 3.0, 3.0)),
        _feature("inside", _polygon(0.2, 0.2, 0.4, 0.4)),
    )
    result = processor.filter_features_by_bbox(geojson, BBOX)
    assert [f["properties"]["name"] for f in result["features"]] == ["inside"]


def test_filter_keeps_feature_touching_bbox_edge(processor):
    """压在 bbox 边界上的要素算相交（闭区间语义，与 shapely 一致）。"""
    geojson = _collection(
        _feature("on-edge", _polygon(1.0, 0.5, 1.5, 0.6)),
        _feature("on-corner", _point(1.0, 1.0)),
    )
    result = processor.filter_features_by_bbox(geojson, BBOX)
    assert [f["properties"]["name"] for f in result["features"]] == ["on-edge", "on-corner"]


def test_filter_empty_collection_returns_empty(processor):
    result = processor.filter_features_by_bbox(_collection(), BBOX)
    assert result == {"type": "FeatureCollection", "features": []}


# --- 错误契约（plan 010 引入，不能改） -----------------------------------------


def test_filter_missing_geometry_raises_data_processor_error(processor):
    """缺少 geometry 的要素要抛 DataProcessorError，而不是 KeyError。"""
    geojson = _collection({"type": "Feature", "properties": {}})
    with pytest.raises(DataProcessorError) as exc_info:
        processor.filter_features_by_bbox(geojson, BBOX)
    assert "第 0 个要素" in str(exc_info.value)
    assert exc_info.value.__cause__ is None


def test_filter_malformed_geometry_raises_data_processor_error(processor):
    """几何非法（环不成立）的要素要抛 DataProcessorError，并保留原始原因。"""
    geojson = _collection({
        "type": "Feature",
        "properties": {},
        "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 1]]]},
    })
    with pytest.raises(DataProcessorError) as exc_info:
        processor.filter_features_by_bbox(geojson, BBOX)
    assert "第 0 个要素" in str(exc_info.value)
    assert exc_info.value.__cause__ is not None


def test_filter_invalid_bbox_raises_data_processor_error(processor):
    """bbox 本身非法时，报错必须指向 bbox，而不是某个要素。"""
    geojson = _collection(_feature("ok", _polygon(0.2, 0.2, 0.4, 0.4)))
    with pytest.raises(DataProcessorError) as exc_info:
        processor.filter_features_by_bbox(geojson, ["a", "b", "c", "d"])
    assert "bbox" in str(exc_info.value)
    assert "个要素" not in str(exc_info.value)


# --- 真实数据：过滤结果必须与优化前一致 ---------------------------------------


@requires_osm_data
def test_filter_on_real_osm_data_matches_reference(processor):
    """真实 OSM 数据上，新旧实现的过滤结果必须逐要素一致。"""
    data = processor.load_geojson(str(OSM_BUILDINGS))
    for bbox in (
        [2.145, 41.385, 2.185, 41.405],  # 整个提取范围
        [2.160, 41.390, 2.170, 41.400],  # Eixample 街区腹地
        [2.155, 41.392, 2.165, 41.402],  # 另一个子范围
    ):
        expected = _reference_filter(data, bbox)
        actual = processor.filter_features_by_bbox(data, bbox)
        assert len(actual["features"]) == len(expected["features"]), f"bbox={bbox}"
        assert actual["features"] == expected["features"], f"bbox={bbox}"


# --- 过滤结果缓存 -------------------------------------------------------------


def test_identical_bbox_requests_return_byte_identical_bodies(client):
    """同一个 bbox 请求两次：响应体必须逐字节相同（缓存不能把响应改坏）。"""
    first = client.get("/api/buildings", params={"bbox": "0.0,0.0,0.15,0.15"})
    second = client.get("/api/buildings", params={"bbox": "0.0,0.0,0.15,0.15"})
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.content == second.content


def test_different_bbox_returns_different_body(client):
    """不同的 bbox 必须返回不同的结果（缓存 key 不能把所有查询塌缩成一个）。"""
    wide = client.get("/api/buildings", params={"bbox": "0.0,0.0,0.15,0.15"})
    narrow = client.get("/api/buildings", params={"bbox": "0.0,0.0,0.05,0.05"})
    assert wide.status_code == 200
    assert narrow.status_code == 200
    assert wide.content != narrow.content
    assert len(wide.json()["features"]) == 2
    assert len(narrow.json()["features"]) == 1


def test_bbox_cache_key_is_canonical(client):
    """bbox 字符串里的空白/小数位数不同，命中的是同一个缓存条目。"""
    plain = client.get("/api/buildings", params={"bbox": "0.0,0.0,0.15,0.15"})
    spaced = client.get("/api/buildings", params={"bbox": " 0.0 , 0.0 , 0.15 , 0.15 "})
    padded = client.get("/api/buildings", params={"bbox": "0.000,0.000,0.1500,0.1500"})

    assert plain.content == spaced.content == padded.content
    assert len(main._buildings_bbox_cache) == 1


def test_bbox_cache_is_bounded(client):
    """客户端不能靠发一堆不同 bbox 把缓存撑大。"""
    for index in range(12):
        response = client.get(
            "/api/buildings",
            params={"bbox": f"0.0,0.0,0.01{index},0.01{index}"},
        )
        assert response.status_code == 200
    assert len(main._buildings_bbox_cache) <= main._BBOX_CACHE_MAX_ENTRIES
    assert len(main._buildings_bbox_cache) == 8


def test_filtered_cache_is_invalidated_when_source_data_is_reloaded(client, monkeypatch, tmp_path):
    """原始数据重载后，缓存不能返回旧的过滤结果。

    这里故意只把 main._buildings_cache 置回 None（强制重新加载原始数据），
    不动 bbox 过滤缓存——过滤结果必须靠"原始数据换了对象"自己作废，
    而不是靠谁顺手清缓存。
    """
    first_path = tmp_path / "first.geojson"
    first_path.write_text(
        json.dumps(_collection(_feature("a", _polygon(0.02, 0.02, 0.08, 0.08)))),
        encoding="utf-8",
    )
    second_path = tmp_path / "second.geojson"
    second_path.write_text(
        json.dumps(_collection(
            _feature("a", _polygon(0.02, 0.02, 0.08, 0.08)),
            _feature("b", _polygon(0.02, 0.02, 0.09, 0.09)),
        )),
        encoding="utf-8",
    )

    monkeypatch.setattr(main, "_buildings_path", first_path)
    main._buildings_cache.clear()
    first = client.get("/api/buildings", params={"bbox": "0.0,0.0,0.15,0.15"})
    assert len(first.json()["features"]) == 1

    monkeypatch.setattr(main, "_buildings_path", second_path)
    main._buildings_cache.clear()
    second = client.get("/api/buildings", params={"bbox": "0.0,0.0,0.15,0.15"})
    assert len(second.json()["features"]) == 2


def test_clear_caches_clears_raw_and_filtered_caches(client):
    """_clear_caches() 必须把原始缓存和过滤缓存一起清掉。"""
    client.get("/api/buildings", params={"bbox": "0.0,0.0,0.15,0.15"})
    client.get("/api/roads", params={"bbox": "0.0,0.0,0.15,0.15"})
    assert main._buildings_cache
    assert main._roads_cache
    assert len(main._buildings_bbox_cache) == 1
    assert len(main._roads_bbox_cache) == 1

    main._clear_caches()

    assert main._buildings_cache == {}
    assert main._roads_cache == {}
    assert len(main._buildings_bbox_cache) == 0
    assert len(main._roads_bbox_cache) == 0
