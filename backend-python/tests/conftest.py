"""测试夹具：合成 GeoJSON 数据 + 模块级缓存重置。

设计目标：
- 测试不依赖磁盘上的 OSM 提取数据（backend-python/geojson/ 是未纳入版本管理的输入数据）；
- 每个测试前后都清空 main 模块级的全部 GeoJSON 缓存（原始数据 + 按 bbox 的过滤结果），
  避免用例之间互相污染；
- 夹具保持通用，后续计划可以在此基础上继续扩展。
"""
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import main  # noqa: E402


# 合成数据的三种位置（单位：度，都是合法经纬度）：
#   INSIDE   完全落在 TEST_BBOX 内部
#   OUTSIDE  完全落在 TEST_BBOX 外部
#   CROSSING 与 TEST_BBOX 相交（跨越边界）
INSIDE = (0.02, 0.02, 0.08, 0.08)
OUTSIDE = (5.0, 5.0, 6.0, 6.0)
CROSSING = (0.10, 0.10, 0.30, 0.30)

# 合成数据共 3 个要素；用这个 bbox 过滤后应剩下 2 个（内部 + 跨界）。
TEST_BBOX = "0.0,0.0,0.15,0.15"
EXPECTED_TOTAL = 3
EXPECTED_FILTERED = 2


def _polygon(box, name):
    """由 (min_lon, min_lat, max_lon, max_lat) 生成一个方形 Polygon 要素。"""
    min_lon, min_lat, max_lon, max_lat = box
    return {
        "type": "Feature",
        "properties": {"name": name},
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


def _line(box, name):
    """由 (min_lon, min_lat, max_lon, max_lat) 生成一条 LineString 要素。"""
    min_lon, min_lat, max_lon, max_lat = box
    return {
        "type": "Feature",
        "properties": {"name": name},
        "geometry": {
            "type": "LineString",
            "coordinates": [[min_lon, min_lat], [max_lon, max_lat]],
        },
    }


@pytest.fixture
def synthetic_features():
    """三个合成要素：完全在 bbox 内、完全在 bbox 外、跨越 bbox 边界。"""
    return [
        _polygon(INSIDE, "inside"),
        _polygon(OUTSIDE, "outside"),
        _polygon(CROSSING, "crossing"),
    ]


@pytest.fixture
def synthetic_geojson(tmp_path, synthetic_features):
    """把合成要素写成 buildings.geojson / roads.geojson，返回两个路径。"""
    buildings = tmp_path / "buildings.geojson"
    roads = tmp_path / "roads.geojson"
    buildings.write_text(
        json.dumps(
            {"type": "FeatureCollection", "features": synthetic_features},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    roads.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    _line(INSIDE, "inside"),
                    _line(OUTSIDE, "outside"),
                    _line(CROSSING, "crossing"),
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return {"buildings": buildings, "roads": roads}


@pytest.fixture(autouse=True)
def reset_module_caches():
    """每个测试前后清空模块级 GeoJSON 缓存，避免用例之间互相污染。

    走 main._clear_caches() 而不是直接给 _buildings_cache / _roads_cache 赋 None：
    main 里有多族缓存（原始 GeoJSON、按 bbox 的过滤结果……），
    统一由 _clear_caches() 负责清空，将来新增缓存类型时这个夹具不会漏掉。
    """
    main._clear_caches()
    yield
    main._clear_caches()


@pytest.fixture
def client(monkeypatch, synthetic_geojson):
    """指向合成数据的 TestClient（不依赖磁盘上的 OSM 提取数据）。"""
    monkeypatch.setattr(main, "_buildings_path", synthetic_geojson["buildings"])
    monkeypatch.setattr(main, "_roads_path", synthetic_geojson["roads"])
    main._clear_caches()
    with TestClient(main.app) as test_client:
        yield test_client
