"""验证「一个进程同时托管 API 与前端」的行为。

背景：Vite 的 /api 代理只在 dev 生效，仓库此前也没有任何反代配置，
所以 `dist/` 直接部署出去必然 404。本计划让 FastAPI 自己托管 dist/，
于是 /api/... 的相对路径请求天然同源。

这些用例**不依赖真实的 dist/**：用 tmp_path 造一个假的 dist/，
验证挂载函数的行为（目录存在 → 挂载；目录不存在 → 不挂载也不报错），
以及路由优先级（/api/* 不会被静态兜底抢走）。
"""
from fastapi import FastAPI
from fastapi.testclient import TestClient

import main


def _make_dist(tmp_path):
    """造一个最小可用的 dist/：index.html + 一个 asset。"""
    dist = tmp_path / "dist"
    assets = dist / "assets"
    assets.mkdir(parents=True)
    (dist / "index.html").write_text(
        '<!doctype html><html><body><div id="app"></div></body></html>', encoding="utf-8"
    )
    (assets / "app.js").write_text("console.log(1)", encoding="utf-8")
    return dist


def _app_with_api():
    app = FastAPI()

    @app.get("/api/buildings")
    def buildings():
        return {"type": "FeatureCollection", "features": []}

    return app


def test_mount_frontend_serves_index_at_root(tmp_path):
    dist = _make_dist(tmp_path)
    app = _app_with_api()

    assert main.mount_frontend(app, dist) is True

    client = TestClient(app)
    response = client.get("/")
    assert response.status_code == 200
    assert 'id="app"' in response.text
    assert response.headers["content-type"].startswith("text/html")


def test_mount_frontend_serves_built_assets(tmp_path):
    dist = _make_dist(tmp_path)
    app = _app_with_api()
    main.mount_frontend(app, dist)

    response = TestClient(app).get("/assets/app.js")
    assert response.status_code == 200
    assert response.text == "console.log(1)"


def test_api_routes_take_precedence_over_the_static_fallback(tmp_path):
    """/api/* 必须走 API，不能被静态兜底抢走。"""
    dist = _make_dist(tmp_path)
    app = _app_with_api()
    main.mount_frontend(app, dist)

    response = TestClient(app).get("/api/buildings")
    assert response.status_code == 200
    assert response.json()["type"] == "FeatureCollection"


def test_unknown_api_path_falls_through_to_static_and_404s(tmp_path):
    """未知 /api 路径落到静态兜底，返回 404 而不是 500。"""
    dist = _make_dist(tmp_path)
    app = _app_with_api()
    main.mount_frontend(app, dist)

    assert TestClient(app).get("/api/unknown-route").status_code == 404


def test_mount_frontend_skips_a_missing_dist_without_raising(tmp_path):
    """dist/ 不存在时不挂载、不抛错，后端仍能正常提供 API。"""
    app = _app_with_api()

    assert main.mount_frontend(app, tmp_path / "does-not-exist") is False

    client = TestClient(app)
    assert client.get("/api/buildings").status_code == 200
    assert client.get("/").status_code == 404
