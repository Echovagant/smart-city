"""端到端验证响应真的在「线上」被压缩了。

为什么不用 TestClient：httpx / starlette 的 TestClient 会自动解压
Content-Encoding: gzip 的响应体，量到的是**解压后**的大小（1341 KB），
证明不了任何压缩效果。这里起一个真实的 uvicorn，用 urllib.request
取原始字节——urllib 不自动解压，len(raw) 就是线缆上真实传输的字节数。
"""
import gzip
import socket
import threading
import time
import urllib.request
from pathlib import Path

import pytest
import uvicorn

import main

# 线缆字节数上限（KB）。这是**回归护栏**：gzip 失效时响应会退回明文，
# 体积会翻十几倍，立刻越线。
#
# 上限跟着数据集走：巴塞罗那取景范围 4366 栋建筑（明文约 8.3 MB），
# gzip 后实测约 487 KB。原来的 400 KB 是按更小的数据集定的。
GZIP_THRESHOLD_KB = 600

# 真实 OSM 提取数据（未纳入版本管理），缺失时相关用例跳过。
OSM_BUILDINGS = Path(__file__).resolve().parent.parent / "geojson" / "barcelona" / "buildings.geojson"

requires_osm_data = pytest.mark.skipif(
    not OSM_BUILDINGS.exists(),
    reason=(
        "OSM 提取数据不存在（backend-python/geojson/<城市 id>/buildings.geojson）；"
        "用 backend-python/scripts/fetch_osm_data.py 重新抓取"
        "（用法见 backend-python/scripts/README.md）"
    ),
)


@pytest.fixture(scope="module")
def live_server():
    """在临时端口上起真实的 uvicorn，返回 base URL。"""
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


def _raw_get(url, accept_encoding="gzip"):
    """返回 (status, headers, 原始字节)。urllib 不会自动解压。

    headers 直接返回 http.client.HTTPMessage，不转成 dict：
    HTTPMessage.get() 大小写不敏感，而 uvicorn 发出的响应头名是小写的
    （content-encoding）。转成普通 dict 之后 headers.get("Content-Encoding")
    永远取不到值，断言会假失败。
    """
    request = urllib.request.Request(url, headers={"Accept-Encoding": accept_encoding})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.status, response.headers, response.read()


@requires_osm_data
def test_buildings_response_is_gzipped_on_the_wire(live_server):
    """主数据接口必须带 Content-Encoding: gzip，且线缆字节数显著小于解压后。"""
    status, headers, raw = _raw_get(f"{live_server}/api/buildings")

    assert status == 200
    assert headers.get("Content-Encoding") == "gzip"

    decompressed = gzip.decompress(raw)
    assert len(decompressed) > len(raw), "压缩后的字节数必须小于解压后"
    # 真实数据明文约 8.3 MB，gzip 后应落在上限以内
    assert len(raw) <= GZIP_THRESHOLD_KB * 1024, (
        f"线缆字节数 {len(raw) / 1024:.0f} KB 超过 {GZIP_THRESHOLD_KB} KB 上限"
    )


@requires_osm_data
def test_roads_response_is_gzipped_on_the_wire(live_server):
    status, headers, raw = _raw_get(f"{live_server}/api/roads")

    assert status == 200
    assert headers.get("Content-Encoding") == "gzip"
    assert len(gzip.decompress(raw)) > len(raw)


@requires_osm_data
def test_client_that_does_not_accept_gzip_gets_plain_response(live_server):
    """不支持压缩的客户端必须拿到原始未压缩响应，不能收到压缩体。"""
    status, headers, raw = _raw_get(f"{live_server}/api/buildings", accept_encoding="identity")

    assert status == 200
    assert headers.get("Content-Encoding") is None
    # 必须是可解析的 JSON，不是 gzip 流
    import json

    assert json.loads(raw)["type"] == "FeatureCollection"


def test_small_response_is_not_compressed(live_server):
    """小于 minimum_size 的响应不压缩——压缩 20 字节只会变大。"""
    status, headers, raw = _raw_get(f"{live_server}/health")

    assert status == 200
    assert headers.get("Content-Encoding") is None
    assert len(raw) < 1000
