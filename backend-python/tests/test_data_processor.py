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
