"""验证可选共享 API key 与生产形态下的文档路由开关。

设计取舍：key 是**可选**的 —— 不设 API_KEY 时行为与现在完全一致，
开发环境零摩擦；生产在 .env 里设一行即可开启。
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import main


@pytest.fixture(autouse=True)
def _clear_api_key(monkeypatch):
    """每个用例开始时清掉 API key，用例之间互不影响（monkeypatch 结束时会自动还原）。"""
    monkeypatch.setattr(main.settings, "api_key", None)


def test_without_api_key_everything_still_works(client):
    """未配置 key 时行为完全不变 —— 这是开发环境的默认路径。"""
    assert client.get("/api/buildings").status_code == 200
    assert client.get("/api/roads").status_code == 200


def test_with_api_key_missing_header_is_rejected(client):
    main.settings.api_key = "secret-123"

    response = client.get("/api/buildings")
    assert response.status_code == 401
    assert "API key" in response.json()["detail"]


def test_with_api_key_correct_header_is_accepted(client):
    main.settings.api_key = "secret-123"

    response = client.get("/api/buildings", headers={"X-API-Key": "secret-123"})
    assert response.status_code == 200


def test_with_api_key_wrong_header_is_rejected(client):
    main.settings.api_key = "secret-123"

    response = client.get("/api/buildings", headers={"X-API-Key": "wrong"})
    assert response.status_code == 401


def test_health_is_never_protected(client):
    """健康检查不校验 key —— 探针/负载均衡器不该被挡住。"""
    main.settings.api_key = "secret-123"

    assert client.get("/health").status_code == 200


def test_require_api_key_reads_settings_at_call_time():
    """依赖必须在调用时读 settings，不能在定义时捕获 —— 否则改配置不生效。"""
    main.settings.api_key = "abc"
    # 直接调用依赖函数：匹配的 key -> 不抛
    main.require_api_key(x_api_key="abc")
    with pytest.raises(Exception):
        main.require_api_key(x_api_key="nope")


def test_header_parameter_is_actually_read_from_the_request(client):
    """回归：省略 Header() 会让参数变成 query 参数，header 永远读不到 -> 永远 401。"""
    main.settings.api_key = "secret-123"

    # 用 query 参数传，**不应该**被当成合法凭证
    assert client.get("/api/buildings?x_api_key=secret-123").status_code == 401
    # 用 header 传，应该被认出来
    assert client.get("/api/buildings", headers={"X-API-Key": "secret-123"}).status_code == 200


def test_document_urls_are_disabled_when_not_exposed():
    """生产形态（不暴露文档）时三个文档路由都不注册。"""
    assert main._document_urls(False) == (None, None, None)
    assert main._document_urls(True) == ("/openapi.json", "/docs", "/redoc")


def test_docs_are_404_on_a_production_shaped_app():
    """构造一个「生产形状」的 app，验证三个文档路径全部 404。"""
    openapi_url, docs_url, redoc_url = main._document_urls(False)
    app = FastAPI(openapi_url=openapi_url, docs_url=docs_url, redoc_url=redoc_url)
    client = TestClient(app)

    assert client.get("/docs").status_code == 404
    assert client.get("/redoc").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_allowed_hosts_parsing():
    assert main._allowed_hosts("") == []
    assert main._allowed_hosts("  ") == []
    assert main._allowed_hosts("example.com") == ["example.com"]
    assert main._allowed_hosts("a.com, b.com ,,c.com") == ["a.com", "b.com", "c.com"]
