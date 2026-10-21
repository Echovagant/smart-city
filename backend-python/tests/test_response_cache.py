"""全量响应序列化缓存的回归测试。

缓存的是「不带 bbox 的全量响应」的序列化结果与压缩结果。
这里锁的是行为，不是实现细节：

1. 连续两次请求 /api/buildings，底层只序列化一次；
2. 改了源数据并清缓存之后，响应随之更新（缓存必须挂在 _clear_caches() 上）；
3. 带 bbox 的路径不进全量缓存；
4. 两次请求的响应体逐字节相同；
5. _clear_caches() 之后全量缓存确实被清空。

**被替换的符号**：`main._render_collection_bytes` —— 全量响应体唯一的序列化入口
（jsonable_encoder → JSONResponse.render）。给它套一个计数包装器，
就能知道「底层有没有重新序列化」，不必去数 CPU。
"""
import gzip
import json
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

import pytest
import uvicorn
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import main  # noqa: E402


def _polygon(index: int) -> dict:
    """造一个带唯一名字的方形要素。"""
    lon = 116.0 + index * 0.0001
    lat = 39.9 + index * 0.0001
    return {
        "type": "Feature",
        "properties": {"name": f"feature-{index}", "building": "yes"},
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [lon, lat],
                [lon + 0.00005, lat],
                [lon + 0.00005, lat + 0.00005],
                [lon, lat + 0.00005],
                [lon, lat],
            ]],
        },
    }


@pytest.fixture
def large_buildings_path(tmp_path):
    """一份「足够大」的合成建筑数据。

    合成数据必须超过 GZIP_MINIMUM_SIZE（1000 字节），否则走不到压缩分支，
    「压缩结果也被缓存」这件事就无从验证。
    """
    payload = {
        "type": "FeatureCollection",
        "features": [_polygon(index) for index in range(60)],
    }
    path = tmp_path / "large_buildings.geojson"
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


@pytest.fixture
def large_client(monkeypatch, large_buildings_path):
    """指向「足够大」的合成数据的客户端。"""
    monkeypatch.setattr(main, "_buildings_path", large_buildings_path)
    main._clear_caches()
    with TestClient(main.app) as test_client:
        yield test_client


def _raw_get(url, accept_encoding="gzip"):
    """返回 (status, headers, 原始字节)。urllib 不会自动解压。

    headers 保持 http.client.HTTPMessage（大小写不敏感），转成 dict 之后
    headers.get("Content-Encoding") 会取不到值。
    """
    request = urllib.request.Request(url, headers={"Accept-Encoding": accept_encoding})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.status, response.headers, response.read()


@pytest.fixture
def live_server(monkeypatch, large_buildings_path):
    """在随机端口上起真实 uvicorn。

    TestClient 会自动解压响应，证明不了「线缆上到底是 gzip 还是明文」，
    所以线缆级的断言必须走真实服务器。
    """
    monkeypatch.setattr(main, "_buildings_path", large_buildings_path)
    main._clear_caches()

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()

    config = uvicorn.Config(main.app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    deadline = time.time() + 15
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    if not server.started:
        pytest.fail("uvicorn 未在 15 秒内启动")

    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        main._clear_caches()


def test_full_response_is_serialized_only_once(client, monkeypatch):
    """连续两次请求全量建筑，底层只序列化一次——第二次命中缓存。"""
    calls = {"render": 0}
    real_render = main._render_collection_bytes

    def counting_render(collection):
        calls["render"] += 1
        return real_render(collection)

    monkeypatch.setattr(main, "_render_collection_bytes", counting_render)

    first = client.get("/api/buildings")
    second = client.get("/api/buildings")

    assert first.status_code == 200
    assert second.status_code == 200
    assert calls["render"] == 1, "第二次请求不该再序列化"


def test_roads_full_response_is_serialized_only_once(client, monkeypatch):
    """道路端点共用同一套缓存逻辑，也必须只序列化一次。"""
    calls = {"render": 0}
    real_render = main._render_collection_bytes

    def counting_render(collection):
        calls["render"] += 1
        return real_render(collection)

    monkeypatch.setattr(main, "_render_collection_bytes", counting_render)

    client.get("/api/roads")
    client.get("/api/roads")

    assert calls["render"] == 1, "第二次请求不该再序列化"


def test_full_response_is_compressed_only_once(large_client, monkeypatch):
    """压缩同样只做一次——第二次请求直接复用缓存里的 gzip 字节。"""
    calls = {"gzip": 0}
    real_gzip = main._gzip_bytes

    def counting_gzip(payload):
        calls["gzip"] += 1
        return real_gzip(payload)

    monkeypatch.setattr(main, "_gzip_bytes", counting_gzip)

    first = large_client.get("/api/buildings", headers={"Accept-Encoding": "gzip"})
    second = large_client.get("/api/buildings", headers={"Accept-Encoding": "gzip"})

    assert first.headers.get("content-encoding") == "gzip"
    assert second.headers.get("content-encoding") == "gzip"
    assert calls["gzip"] == 1, "第二次请求不该再压缩"


def test_changed_source_data_updates_response(client, synthetic_geojson):
    """改了源数据并清缓存后，响应必须随之更新。

    中间那次「不清缓存、响应仍是旧的」的断言是在证明缓存真的在生效：
    如果响应每次都现算，这条断言会失败，整个用例就变成空转。
    """
    first = client.get("/api/buildings").json()
    assert first["features"][0]["properties"]["name"] == "inside"

    path = synthetic_geojson["buildings"]
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["features"][0]["properties"]["name"] = "renamed"
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    # 缓存还在，响应还是旧的。
    assert client.get("/api/buildings").json()["features"][0]["properties"]["name"] == "inside"

    main._clear_caches()

    updated = client.get("/api/buildings").json()
    assert updated["features"][0]["properties"]["name"] == "renamed"


def test_new_data_object_invalidates_cache_without_explicit_clear(client, monkeypatch):
    """底层数据对象换了（重新加载过）时，旧缓存自动作废。

    这是挂在 _clear_caches() 之外的第二道保险：即使有人忘了清缓存，
    也不会把上一份数据的响应端出去。
    """
    client.get("/api/buildings")
    assert main._full_response_cache, "请求之后全量缓存应该非空"

    monkeypatch.setattr(
        main,
        "_buildings_cache",
        {
            "type": "FeatureCollection",
            "features": [
                {"type": "Feature", "properties": {"name": "fresh"}, "geometry": None}
            ],
        },
    )

    body = client.get("/api/buildings").json()
    assert body["features"][0]["properties"]["name"] == "fresh"


def test_bbox_request_does_not_populate_full_response_cache(client):
    """带 bbox 的路径不进全量缓存——参数组合无界，缓存多少都救不了。"""
    response = client.get("/api/buildings", params={"bbox": "0.0,0.0,0.15,0.15"})
    assert response.status_code == 200
    assert main._full_response_cache == {}


def test_many_bboxes_do_not_grow_any_cache(client):
    """连续发很多不同 bbox：全量缓存与 bbox LRU 都不能无限增长。"""
    for index in range(20):
        low = index * 0.001
        client.get("/api/buildings", params={"bbox": f"{low},0.0,{low + 0.01},0.01"})

    assert main._full_response_cache == {}
    assert len(main._buildings_bbox_cache) <= main._BBOX_CACHE_MAX_ENTRIES


def test_bbox_response_is_not_the_cached_full_response(client):
    """带 bbox 的响应必须仍是过滤后的子集，不能被全量缓存顶替。"""
    full = client.get("/api/buildings")
    filtered = client.get("/api/buildings", params={"bbox": "0.0,0.0,0.15,0.15"})

    assert filtered.status_code == 200
    assert filtered.content != full.content
    assert len(filtered.json()["features"]) == 2


def test_repeated_full_responses_are_byte_identical(client):
    """两次请求的响应体必须逐字节相同（长度与内容）。"""
    first = client.get("/api/buildings")
    second = client.get("/api/buildings")

    assert first.status_code == second.status_code == 200
    assert first.content == second.content
    assert len(first.content) == len(second.content)


def test_clear_caches_empties_full_response_cache(client):
    """_clear_caches() 是模块级缓存的唯一失效入口，必须把全量缓存一起清掉。"""
    client.get("/api/buildings")
    client.get("/api/roads")
    assert main._full_response_cache, "请求之后全量缓存应该非空"

    main._clear_caches()

    assert main._full_response_cache == {}


def test_gzip_client_gets_gzip_body_and_identity_client_gets_plain(large_client):
    """接受 gzip 的客户端拿到 gzip，不接受的拿到明文——两者内容必须一致。

    httpx 会自动解压，所以解压后的内容与明文响应逐字节相同，
    就等于证明了「没有压第二遍」（压两遍的话 httpx 解不开）。
    """
    gzipped = large_client.get("/api/buildings", headers={"Accept-Encoding": "gzip"})
    plain = large_client.get("/api/buildings", headers={"Accept-Encoding": "identity"})

    assert gzipped.headers.get("content-encoding") == "gzip"
    assert plain.headers.get("content-encoding") is None
    assert gzipped.content == plain.content
    assert json.loads(gzipped.content)["type"] == "FeatureCollection"


def test_cached_response_headers(large_client):
    """缓存出来的响应仍要带上正确的 content-type 与 Vary。

    Vary 里还有 Origin——那是 CORSMiddleware 加的，与本缓存无关。
    """
    response = large_client.get("/api/buildings", headers={"Accept-Encoding": "gzip"})

    assert response.headers.get("content-type") == "application/json"
    vary = [item.strip() for item in response.headers.get("vary", "").split(",")]
    assert "Accept-Encoding" in vary


def test_live_wire_bytes_are_gzip_and_stable(live_server):
    """线缆上的字节：gzip 客户端拿到的是 gzip 字节，两次请求逐字节相同。"""
    status, headers, raw = _raw_get(f"{live_server}/api/buildings")

    assert status == 200
    assert headers.get("Content-Encoding") == "gzip"
    assert json.loads(gzip.decompress(raw))["type"] == "FeatureCollection"

    _, _, raw_again = _raw_get(f"{live_server}/api/buildings")
    assert raw_again == raw, "两次请求的线缆字节必须逐字节相同"


def test_live_identity_client_gets_plain_json(live_server):
    """不支持压缩的客户端必须拿到明文 JSON，不能拿到 gzip 字节。"""
    status, headers, raw = _raw_get(f"{live_server}/api/buildings", accept_encoding="identity")

    assert status == 200
    assert headers.get("Content-Encoding") is None
    assert json.loads(raw)["type"] == "FeatureCollection"
