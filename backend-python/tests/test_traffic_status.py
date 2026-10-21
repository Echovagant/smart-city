"""`/api/traffic-status` 的行为测试：读数必须随时间真实变化。

设计目标：
- 时间源可注入（monkeypatch main._now），断言不依赖 time.sleep，也不 flaky；
- 明确写出这个端点的响应契约（键名、类型、取值范围）；
- 守住「不许再出现写死的常量」这条底线。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import main  # noqa: E402

# 响应契约：这个端点的键不许被删（前端按这些键取数，可以新增但不能少）。
REQUIRED_KEYS = {"status", "congestion_level", "congestion", "flow", "update_time"}

# 老调用方（plan 005 以来）依赖的键，一个都不能少。
LEGACY_KEYS = {"status", "congestion_level", "update_time"}

# 时钟钉死在一个已知的时刻上：断言不依赖「跑测试时的真实时间」。
T0 = 1_700_000_000.0  # 2023-11-14T22:13:20Z
T1 = T0 + 137.0


def _freeze_clock(monkeypatch, now):
    """把 main._now 钉死在一个时刻上（可注入的时间源）。"""
    monkeypatch.setattr(main, "_now", lambda: now)


def test_traffic_status_response_contract(client, monkeypatch):
    """响应契约：键、类型、取值范围都写死在这里，改坏了会红。"""
    _freeze_clock(monkeypatch, T0)
    response = client.get("/api/traffic-status")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")

    body = response.json()
    assert REQUIRED_KEYS <= set(body)
    assert body["status"] in {"normal", "slow", "congested"}
    assert isinstance(body["flow"], float)
    assert 0.0 <= body["flow"] <= 1.0
    assert isinstance(body["congestion_level"], float)
    assert 0.0 <= body["congestion_level"] <= 1.0
    assert body["congestion"] in {"畅通", "轻微拥堵", "拥堵", "严重拥堵"}
    # 时间戳是 ISO8601（UTC，Z 结尾），能被标准日期解析器读懂
    assert body["update_time"] == "2023-11-14T22:13:20.000Z"


def test_traffic_status_keeps_the_legacy_keys():
    """老调用方依赖的键不许消失（可以新增）。"""
    body = main._traffic_status_payload(T0)
    assert LEGACY_KEYS <= set(body)


def test_traffic_status_values_follow_the_clock(client, monkeypatch):
    """时钟往前走，读数必须跟着变（这是本计划的核心）。"""
    _freeze_clock(monkeypatch, T0)
    first = client.get("/api/traffic-status").json()
    _freeze_clock(monkeypatch, T1)
    second = client.get("/api/traffic-status").json()

    assert first["flow"] != second["flow"]
    assert first["congestion_level"] != second["congestion_level"]
    assert first["update_time"] != second["update_time"]


def test_traffic_status_is_deterministic_for_the_same_instant(client, monkeypatch):
    """同一个时刻必须给出同一份响应：值是时间的纯函数，不是随机数。"""
    _freeze_clock(monkeypatch, T0)
    first = client.get("/api/traffic-status").json()
    second = client.get("/api/traffic-status").json()
    assert first == second


def test_traffic_status_payload_is_a_pure_function_of_the_clock():
    """模型层同样是纯函数：同样的输入必然得到同样的输出。"""
    assert main._traffic_status_payload(T0) == main._traffic_status_payload(T0)
    assert main._traffic_status_payload(T0)["flow"] != main._traffic_status_payload(T1)["flow"]


def test_traffic_status_timestamp_is_not_a_hardcoded_constant(client, monkeypatch):
    """时间戳必须跟着时钟走，不许再出现那个写死的占位常量。"""
    _freeze_clock(monkeypatch, T0)
    body = client.get("/api/traffic-status").json()
    assert "2024-04-24" not in body["update_time"]
    # 源码里也不许留着那个占位常量
    source = (ROOT / "main.py").read_text(encoding="utf-8")
    assert "2024-04-24" not in source


def test_traffic_status_body_stays_small(client, monkeypatch):
    """这个端点会被前端轮询，响应体必须小。"""
    _freeze_clock(monkeypatch, T0)
    response = client.get("/api/traffic-status")
    assert len(response.content) < 512


def test_traffic_status_needs_no_api_key(client, monkeypatch):
    """前端不携带 key：即使服务端配了 key，这个端点也必须放行。"""
    monkeypatch.setattr(main, "settings", main.Settings(api_key="secret-key"))
    response = client.get("/api/traffic-status")
    assert response.status_code == 200


def test_traffic_status_route_has_no_api_key_dependency():
    """结构上守住：/api/traffic-status 没有挂 require_api_key。"""
    route = next(
        route
        for route in main.app.routes
        if getattr(route, "path", None) == "/api/traffic-status"
    )
    calls = [dependency.call for dependency in route.dependant.dependencies]
    assert main.require_api_key not in calls


def test_traffic_status_does_not_affect_other_endpoints(client):
    """改这个端点不能牵连别的端点。"""
    assert client.get("/health").status_code == 200
    assert client.get("/api/buildings").status_code == 200
