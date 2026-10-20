import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from data_processor import DataProcessor, DataProcessorError  # noqa: E402


@pytest.fixture
def tmp_geojson_dir(tmp_path):
    return tmp_path


def test_load_geojson_success(tmp_geojson_dir):
    fp = tmp_geojson_dir / "ok.geojson"
    fp.write_text(json.dumps({"type": "FeatureCollection", "features": []}), encoding="utf-8")
    processor = DataProcessor(str(tmp_geojson_dir))
    result = processor.load_geojson(str(fp))
    assert result == {"type": "FeatureCollection", "features": []}


def test_load_geojson_missing_file_raises(tmp_geojson_dir):
    processor = DataProcessor(str(tmp_geojson_dir))
    with pytest.raises(DataProcessorError) as exc_info:
        processor.load_geojson(str(tmp_geojson_dir / "does_not_exist.geojson"))
    assert "不存在" in str(exc_info.value)
    assert isinstance(exc_info.value.__cause__, FileNotFoundError)


def test_load_geojson_invalid_json_raises(tmp_geojson_dir):
    fp = tmp_geojson_dir / "bad.geojson"
    fp.write_text("{ not valid json", encoding="utf-8")
    processor = DataProcessor(str(tmp_geojson_dir))
    with pytest.raises(DataProcessorError) as exc_info:
        processor.load_geojson(str(fp))
    assert "不是合法 JSON" in str(exc_info.value)
    assert isinstance(exc_info.value.__cause__, json.JSONDecodeError)


def test_save_geojson_success_returns_true(tmp_geojson_dir):
    fp = tmp_geojson_dir / "out.geojson"
    processor = DataProcessor(str(tmp_geojson_dir))
    result = processor.save_geojson({"type": "FeatureCollection", "features": []}, str(fp))
    assert result is True
    assert fp.exists()
    loaded = json.loads(fp.read_text(encoding="utf-8"))
    assert loaded == {"type": "FeatureCollection", "features": []}


def test_save_geojson_unserializable_raises(tmp_geojson_dir):
    fp = tmp_geojson_dir / "out.geojson"
    processor = DataProcessor(str(tmp_geojson_dir))
    # set is not JSON-serializable by default
    with pytest.raises(DataProcessorError) as exc_info:
        processor.save_geojson({"bad": {1, 2, 3}}, str(fp))
    assert "不可序列化" in str(exc_info.value)


# --- filter_features_by_bbox -------------------------------------------------

# 测试用 bbox：0,0,1,1
BBOX = [0.0, 0.0, 1.0, 1.0]


def _polygon_feature(min_lon, min_lat, max_lon, max_lat):
    """构造一个覆盖给定范围的方形 Polygon 要素。"""
    return {
        "type": "Feature",
        "properties": {},
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


def _collection(*features):
    return {"type": "FeatureCollection", "features": list(features)}


def test_filter_features_by_bbox_includes_inside_feature():
    """完全落在 bbox 内的要素应被保留。"""
    processor = DataProcessor("./data")
    geojson = _collection(_polygon_feature(0.2, 0.2, 0.4, 0.4))
    result = processor.filter_features_by_bbox(geojson, BBOX)
    assert len(result["features"]) == 1


def test_filter_features_by_bbox_excludes_outside_feature():
    """完全落在 bbox 外的要素应被排除。"""
    processor = DataProcessor("./data")
    geojson = _collection(_polygon_feature(2.0, 2.0, 3.0, 3.0))
    result = processor.filter_features_by_bbox(geojson, BBOX)
    assert len(result["features"]) == 0


def test_filter_features_by_bbox_includes_crossing_feature():
    """与 bbox 相交的要素应被保留。"""
    processor = DataProcessor("./data")
    geojson = _collection(_polygon_feature(0.8, 0.8, 1.2, 1.2))
    result = processor.filter_features_by_bbox(geojson, BBOX)
    assert len(result["features"]) == 1


def test_filter_features_by_bbox_counts_exactly():
    """混合场景下必须给出精确的要素数。"""
    processor = DataProcessor("./data")
    geojson = _collection(
        _polygon_feature(0.2, 0.2, 0.4, 0.4),   # 内部
        _polygon_feature(2.0, 2.0, 3.0, 3.0),   # 外部
        _polygon_feature(0.8, 0.8, 1.2, 1.2),   # 跨界
    )
    result = processor.filter_features_by_bbox(geojson, BBOX)
    assert len(result["features"]) == 2


def test_filter_features_by_bbox_empty_collection_returns_empty():
    processor = DataProcessor("./data")
    result = processor.filter_features_by_bbox(_collection(), BBOX)
    assert result == {"type": "FeatureCollection", "features": []}


def test_filter_features_by_bbox_missing_geometry_raises_data_processor_error():
    """缺少 geometry 的要素要抛 DataProcessorError，而不是 KeyError。"""
    processor = DataProcessor("./data")
    geojson = _collection({"type": "Feature", "properties": {}})
    with pytest.raises(DataProcessorError) as exc_info:
        processor.filter_features_by_bbox(geojson, BBOX)
    assert "第 0 个要素" in str(exc_info.value)
    assert exc_info.value.__cause__ is None


def test_filter_features_by_bbox_malformed_geometry_raises_data_processor_error():
    """几何非法（环不成立）的要素要抛 DataProcessorError，并保留原始原因。"""
    processor = DataProcessor("./data")
    geojson = _collection({
        "type": "Feature",
        "properties": {},
        "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 1]]]},
    })
    with pytest.raises(DataProcessorError) as exc_info:
        processor.filter_features_by_bbox(geojson, BBOX)
    assert "第 0 个要素" in str(exc_info.value)
    assert exc_info.value.__cause__ is not None
