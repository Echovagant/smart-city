import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402
import main  # noqa: E402

# 真实 OSM 提取数据（未纳入版本管理），缺失时相关用例跳过。
OSM_BUILDINGS = ROOT / "geojson" / "buildings.geojson"

requires_osm_data = pytest.mark.skipif(
    not OSM_BUILDINGS.exists(),
    reason=(
        "OSM 提取数据不存在（backend-python/geojson/buildings.geojson）；"
        "用 backend-python/scripts/fetch_osm_data.py 重新抓取"
        "（用法见 backend-python/scripts/README.md）"
    ),
)


@pytest.fixture
def osm_client():
    """指向真实 OSM 提取数据的客户端（不替换数据路径）。"""
    with TestClient(main.app) as test_client:
        yield test_client


def test_api_buildings_returns_featurecollection(client):
    """端点必须返回 FeatureCollection（合成数据：固定 3 个要素）。"""
    response = client.get("/api/buildings")
    assert response.status_code == 200
    body = response.json()
    assert body["type"] == "FeatureCollection"
    assert isinstance(body["features"], list)
    assert len(body["features"]) == 3


def test_api_roads_returns_featurecollection(client):
    response = client.get("/api/roads")
    assert response.status_code == 200
    body = response.json()
    assert body["type"] == "FeatureCollection"
    assert len(body["features"]) == 3


def test_api_buildings_bbox_filter_returns_exact_count(client):
    """bbox 过滤后应精确剩下「内部 + 跨界」两个要素。"""
    full = client.get("/api/buildings").json()
    filtered = client.get(
        "/api/buildings",
        params={"bbox": "0.0,0.0,0.15,0.15"},
    ).json()
    assert len(filtered["features"]) == 2
    # 不再是 "<= 完整数" 这种恒真断言。
    assert 0 < len(filtered["features"]) < len(full["features"])


def test_api_roads_bbox_filter_returns_exact_count(client):
    full = client.get("/api/roads").json()
    filtered = client.get(
        "/api/roads",
        params={"bbox": "0.0,0.0,0.15,0.15"},
    ).json()
    assert len(filtered["features"]) == 2
    assert 0 < len(filtered["features"]) < len(full["features"])


def test_client_fixture_clears_both_cache_families(request):
    """client 夹具初始化时必须把两族模块级缓存都清空。

    回归防护：夹具早先只把 _buildings_cache / _roads_cache 赋回 None，
    漏掉了 plan 011 新增的 bbox 过滤缓存。两族缓存一旦不同步，
    上一个用例留下的过滤结果就可能泄漏到下一个用例。
    """
    # 先人为污染两族缓存，模拟上一个用例留下的残留。
    main._buildings_cache = {"type": "FeatureCollection", "features": []}
    main._roads_cache = {"type": "FeatureCollection", "features": []}
    main._buildings_bbox_cache[(0.0, 0.0, 1.0, 1.0)] = (object(), {})
    main._roads_bbox_cache[(0.0, 0.0, 1.0, 1.0)] = (object(), {})

    # 申请 client 夹具：它的初始化必须把上面两族缓存都清掉。
    request.getfixturevalue("client")

    assert main._buildings_cache is None
    assert main._roads_cache is None
    assert len(main._buildings_bbox_cache) == 0
    assert len(main._roads_bbox_cache) == 0


def test_api_buildings_bad_bbox_returns_400(client):
    response = client.get("/api/buildings", params={"bbox": "not,a,bbox"})
    assert response.status_code == 400
    assert "bbox" in response.json()["detail"]


def test_api_roads_bad_bbox_returns_400(client):
    """两个端点共用同一套解析逻辑，roads 也要拦住非法 bbox。"""
    response = client.get("/api/roads", params={"bbox": "not,a,bbox"})
    assert response.status_code == 400
    assert "bbox" in response.json()["detail"]


def test_api_buildings_nan_bbox_returns_400(client):
    """float("nan") 能解析成功，必须显式拒绝，且不返回 500 堆栈。"""
    response = client.get("/api/buildings", params={"bbox": "nan,nan,nan,nan"})
    assert response.status_code == 400
    assert "Traceback" not in response.text
    assert "bbox" in response.json()["detail"]


def test_api_buildings_inf_bbox_returns_400(client):
    response = client.get("/api/buildings", params={"bbox": "inf,inf,inf,inf"})
    assert response.status_code == 400
    assert "Traceback" not in response.text


def test_api_buildings_inverted_bbox_returns_400(client):
    """min > max 的倒置框以前会静默返回全部要素。"""
    response = client.get(
        "/api/buildings",
        params={"bbox": "116.42,39.925,116.38,39.905"},
    )
    assert response.status_code == 400
    assert "bbox" in response.json()["detail"]


def test_api_buildings_out_of_range_longitude_returns_400(client):
    response = client.get("/api/buildings", params={"bbox": "200,39.9,201,40.0"})
    assert response.status_code == 400
    assert "bbox" in response.json()["detail"]


def test_api_buildings_out_of_range_latitude_returns_400(client):
    response = client.get("/api/buildings", params={"bbox": "116.3,100,116.4,101"})
    assert response.status_code == 400
    assert "bbox" in response.json()["detail"]


def test_api_buildings_wrong_arity_bbox_returns_400(client):
    response = client.get("/api/buildings", params={"bbox": "1,2,3"})
    assert response.status_code == 400
    assert "bbox" in response.json()["detail"]


def test_api_missing_data_file_returns_503(client, monkeypatch, tmp_path):
    """数据文件缺失是我们的问题：503，且响应体里不能出现服务端路径。"""
    monkeypatch.setattr(main, "_buildings_path", tmp_path / "missing" / "buildings.geojson")
    main._clear_caches()
    response = client.get("/api/buildings")
    assert response.status_code == 503
    assert ":\\" not in response.text
    assert "Traceback" not in response.text


def test_api_roads_missing_data_file_returns_503(client, monkeypatch, tmp_path):
    """道路端点的错误契约与建筑端点一致：数据缺失同样是 503。"""
    monkeypatch.setattr(main, "_roads_path", tmp_path / "missing" / "roads.geojson")
    main._clear_caches()
    response = client.get("/api/roads")
    assert response.status_code == 503
    assert ":\\" not in response.text
    assert "Traceback" not in response.text


def test_api_response_omits_source_metadata(client, monkeypatch, tmp_path):
    """原始文件里的 overpass 元信息不能出现在响应体里。

    带 bbox 和不带 bbox 两种取数方式必须给前端同构的负载：
    只有 {"type", "features"} 两个键，不多不少。
    """
    source = tmp_path / "with_metadata.geojson"
    source.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "generator": "Overpass API 0.7.55",
                "copyright": "© OpenStreetMap contributors",
                "timestamp": "2024-04-24T10:00:00Z",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"name": "inside"},
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [[
                                [0.02, 0.02],
                                [0.08, 0.02],
                                [0.08, 0.08],
                                [0.02, 0.08],
                                [0.02, 0.02],
                            ]],
                        },
                    },
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(main, "_buildings_path", source)
    main._clear_caches()

    plain = client.get("/api/buildings")
    filtered = client.get("/api/buildings", params={"bbox": "0.0,0.0,0.15,0.15"})

    assert plain.status_code == 200
    assert filtered.status_code == 200
    assert set(plain.json()) == {"type", "features"}
    assert set(filtered.json()) == {"type", "features"}
    assert len(plain.json()["features"]) == 1
    assert len(filtered.json()["features"]) == 1


def test_api_malformed_feature_returns_503(client, monkeypatch, tmp_path):
    """要素几何损坏属于数据问题：503，而不是 500，也不是 400。"""
    bad_path = tmp_path / "bad.geojson"
    bad_path.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {},
                        # 环只有两个点，shapely 会拒绝
                        "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 1]]]},
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(main, "_buildings_path", bad_path)
    main._clear_caches()
    # 只有真正走 bbox 过滤时才会解析几何，所以这里要带上 bbox。
    response = client.get("/api/buildings", params={"bbox": "0.0,0.0,1.0,1.0"})
    assert response.status_code == 503
    assert ":\\" not in response.text
    assert "Traceback" not in response.text


def test_api_traffic_status_returns_shape(client):
    response = client.get("/api/traffic-status")
    assert response.status_code == 200
    body = response.json()
    assert "status" in body
    assert "congestion_level" in body
    assert "update_time" in body


def test_api_cors_allows_configured_origin(client):
    response = client.get("/api/traffic-status", headers={"Origin": main.origins[0]})
    assert response.headers.get("access-control-allow-origin") == main.origins[0]


def test_api_cors_rejects_unknown_origin(client):
    response = client.get("/api/traffic-status", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in response.headers


def test_normalize_origins_strips_whitespace():
    assert main._normalize_origins("http://a, http://b") == ["http://a", "http://b"]


def test_normalize_origins_deduplicates():
    assert main._normalize_origins("http://a,http://b,http://a") == ["http://a", "http://b"]


def test_normalize_origins_rejects_wildcard():
    """allow_credentials=True 时 '*' 会让 Starlette 回显任意 Origin，必须拒绝。"""
    with pytest.raises(ValueError):
        main._normalize_origins("http://a,*")


def test_normalize_origins_rejects_empty_list():
    with pytest.raises(ValueError):
        main._normalize_origins(" , ")


@requires_osm_data
def test_api_osm_buildings_returns_features(osm_client):
    """真实 OSM 提取数据的冒烟检查（数据缺失时跳过）。"""
    response = osm_client.get("/api/buildings")
    assert response.status_code == 200
    body = response.json()
    assert body["type"] == "FeatureCollection"
    assert len(body["features"]) > 0
