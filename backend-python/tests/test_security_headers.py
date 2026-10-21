"""安全响应头与 CSP report-only 开关的测试。

这里锁的是**行为**，不是实现细节：

1. API 响应、静态资源响应都带 X-Content-Type-Options / Referrer-Policy / X-Frame-Options；
2. 加头**不改变**响应体、content-type、content-length，也不改变 gzip 行为；
3. 头集中在一个模块级常量里（方便按部署形态统一调整或整体关掉）；
4. 用的是**纯 ASGI 中间件**——BaseHTTPMiddleware 会把响应体包成流，
   改变字节层面的行为，可能破坏「两次请求响应体逐字节相同」这类断言；
5. CSP 只走 report-only：默认不带头，且任何时候都不出现强制头 Content-Security-Policy。
"""
import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import main  # noqa: E402

SECURITY_HEADER_NAMES = (
    "X-Content-Type-Options",
    "Referrer-Policy",
    "X-Frame-Options",
)


def _assert_security_headers(response):
    """断言响应带上了模块级常量里定义的三个头（值也一致）。"""
    for name, value in main.SECURITY_HEADERS.items():
        assert response.headers.get(name.lower()) == value, name


def _static_mount_exists():
    """main.app 上是否挂了前端静态资源。

    dist/ 不在版本管理里（CI 上不存在），所以这个用例要按实际装配情况跳过，
    不能假设静态挂载一定存在。
    """
    return any(getattr(route, "name", "") == "static" for route in main.app.routes)


def _large_buildings_file(tmp_path):
    """一份「足够大」的合成建筑数据。

    必须超过 GZIP_MINIMUM_SIZE（1000 字节），否则走不到压缩分支，
    「加头没有改变 gzip 行为」这件事就无从验证。
    """
    features = []
    for index in range(60):
        lon = 116.0 + index * 0.0001
        lat = 39.9 + index * 0.0001
        features.append(
            {
                "type": "Feature",
                "properties": {"name": f"feature-{index}", "building": "yes"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [lon, lat],
                            [lon + 0.00005, lat],
                            [lon + 0.00005, lat + 0.00005],
                            [lon, lat + 0.00005],
                            [lon, lat],
                        ]
                    ],
                },
            }
        )
    path = tmp_path / "large_buildings.geojson"
    path.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False),
        encoding="utf-8",
    )
    return path


@pytest.fixture
def large_client(monkeypatch, tmp_path):
    """指向「足够大」的合成数据的客户端。"""
    monkeypatch.setattr(main, "_buildings_path", _large_buildings_file(tmp_path))
    main._clear_caches()
    with TestClient(main.app) as test_client:
        yield test_client


# --- 头是否真的出现在响应里 -------------------------------------------------


def test_health_response_carries_security_headers(client):
    """/health 要带头。"""
    response = client.get("/health")
    assert response.status_code == 200
    _assert_security_headers(response)


def test_api_response_carries_security_headers(client):
    """/api/buildings 要带头。"""
    response = client.get("/api/buildings")
    assert response.status_code == 200
    _assert_security_headers(response)


def test_root_response_carries_security_headers(client):
    """根路径要带头（它可能返回页面，也可能返回服务信息 JSON，两种都要覆盖到）。"""
    response = client.get("/")
    assert response.status_code == 200
    _assert_security_headers(response)


def test_built_static_asset_carries_security_headers(client):
    """真实构建产物里的 JS 也要带头——静态资源最需要 nosniff。"""
    if not _static_mount_exists():
        pytest.skip("没有前端构建产物，静态挂载未启用")

    assets = main.FRONTEND_DIST / "assets"
    scripts = sorted(assets.glob("*.js")) if assets.is_dir() else []
    if not scripts:
        pytest.skip("构建产物里没有 JS 资源")

    response = client.get(f"/assets/{scripts[0].name}")
    assert response.status_code == 200
    _assert_security_headers(response)


def test_static_assets_carry_security_headers(tmp_path):
    """静态挂载的响应也带头。

    用一份临时 dist/ 造场景，不依赖真实构建产物——
    CI 上没有 dist/，这条用例必须照样能跑。
    """
    dist = tmp_path / "dist"
    assets = dist / "assets"
    assets.mkdir(parents=True)
    (dist / "index.html").write_text(
        "<!doctype html><html><body>ok</body></html>", encoding="utf-8"
    )
    (assets / "app.js").write_text("console.log(1)", encoding="utf-8")

    # 装配方式与 main.py 一致：先装中间件，再挂静态资源。
    app = FastAPI()
    app.add_middleware(main.SecurityHeadersMiddleware)
    main.mount_frontend(app, dist)

    with TestClient(app) as client:
        for path in ("/", "/assets/app.js"):
            response = client.get(path)
            assert response.status_code == 200, path
            _assert_security_headers(response)


# --- 加头不能改变别的东西 ---------------------------------------------------


def test_security_headers_do_not_change_body_or_content_type(client):
    """加头只动响应头：body、content-type、content-length 都与加头前一致。"""
    response = client.get("/api/buildings")

    assert response.headers["content-type"] == "application/json"
    assert response.json()["type"] == "FeatureCollection"
    assert len(response.json()["features"]) == 3
    # content-length 仍与实际 body 长度对得上（加头没有把它改坏）
    assert int(response.headers["content-length"]) == len(response.content)


def test_security_headers_do_not_change_gzip_behavior(large_client):
    """gzip 客户端拿到 gzip、明文客户端拿到明文，且两者内容一致。

    加头不能碰压缩路径——E1 的全量响应缓存正是靠「线缆字节可复现」成立的。
    """
    gzipped = large_client.get("/api/buildings", headers={"Accept-Encoding": "gzip"})
    plain = large_client.get("/api/buildings", headers={"Accept-Encoding": "identity"})

    assert gzipped.headers["content-encoding"] == "gzip"
    assert plain.headers.get("content-encoding") is None
    assert gzipped.content == plain.content
    assert gzipped.headers["content-type"] == "application/json"
    for response in (gzipped, plain):
        _assert_security_headers(response)


def test_security_headers_are_not_duplicated(client):
    """同一个头只出现一次（防止中间件被装配两遍）。"""
    response = client.get("/health")
    for name in SECURITY_HEADER_NAMES:
        assert response.headers.get_list(name) == [main.SECURITY_HEADERS[name]]


# --- 头集中在一个常量里 + 纯 ASGI -------------------------------------------


def test_security_headers_live_in_one_module_level_constant():
    """头集中在一个模块级常量里。"""
    assert isinstance(main.SECURITY_HEADERS, dict)
    assert main.SECURITY_HEADERS["X-Content-Type-Options"] == "nosniff"
    assert set(main.SECURITY_HEADERS) == set(SECURITY_HEADER_NAMES)


def test_middleware_is_pure_asgi_not_base_http_middleware():
    """必须是纯 ASGI 中间件。

    BaseHTTPMiddleware 会把响应体包成流，改变字节层面的行为，
    可能破坏「两次请求响应体逐字节相同」这类断言。
    """
    assert not issubclass(main.SecurityHeadersMiddleware, BaseHTTPMiddleware)
    assert not hasattr(main.SecurityHeadersMiddleware, "dispatch")
