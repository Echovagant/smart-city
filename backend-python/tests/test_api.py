import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_api_buildings_returns_featurecollection():
    """只要 geojson/buildings.geojson 存在且合法，端点必须返回 FeatureCollection。"""
    response = client.get("/api/buildings")
    assert response.status_code == 200
    body = response.json()
    assert body["type"] == "FeatureCollection"
    assert isinstance(body["features"], list)
    # 不强制 feature 数（OSM 提取会变化），但要求非空。
    assert len(body["features"]) > 0, "buildings.geojson 为空或缺失"


def test_api_roads_returns_featurecollection():
    response = client.get("/api/roads")
    assert response.status_code == 200
    body = response.json()
    assert body["type"] == "FeatureCollection"
    assert len(body["features"]) > 0


def test_api_buildings_bbox_filter_reduces_count():
    full = client.get("/api/buildings").json()
    # 用一个非常小的 bbox（天安门核心 200m 见方），过滤后的要素数应 <= 完整数。
    filtered = client.get(
        "/api/buildings",
        params={"bbox": "116.395,39.910,116.397,39.912"},
    ).json()
    assert len(filtered["features"]) <= len(full["features"])


def test_api_buildings_bad_bbox_returns_400():
    response = client.get("/api/buildings", params={"bbox": "not,a,bbox"})
    assert response.status_code == 400
    assert "bbox" in response.json()["detail"]


def test_api_traffic_status_returns_shape():
    response = client.get("/api/traffic-status")
    assert response.status_code == 200
    body = response.json()
    assert "status" in body
    assert "congestion_level" in body
    assert "update_time" in body
