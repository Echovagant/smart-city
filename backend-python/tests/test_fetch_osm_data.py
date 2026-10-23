"""Plan 013 的 Overpass 抓取脚本用例（端点加固）。

锁住三件新行为：
  1) 端点列表可以用环境变量 OVERPASS_ENDPOINTS 覆盖（空值 / 非法值有兜底）；
  2) 健康探测失败时**不进入重试循环**，直接换下一个端点；
  3) 重试之间的退避是指数的（BACKOFF_BASE * 2**(attempt-1)，封顶）。

同时锁住既有行为不许破：remark 算失败、0 元素算失败、空结果绝不写出去。

所有用例都用桩替换脚本唯一的出网口 fetch_osm_data._urlopen，
**没有任何一个用例会打到真实外网**；autouse 夹具是兜底 ——
漏网的真实请求会立刻 AssertionError，而不是悄悄连出去。
"""
import json
import sys
import urllib.error
import urllib.parse
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
for _path in (str(ROOT), str(SCRIPTS)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import fetch_osm_data as fetch  # noqa: E402


# ---------------------------------------------------------------- 桩

class FakeResponse:
    """最小可用的 urlopen 返回值：支持上下文管理器 + read()。"""

    def __init__(self, payload):
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def read(self):
        return self._payload


def _endpoint_of(url):
    """从请求 URL 里还原端点地址（去掉探测请求带的 query）。"""
    return url.split("?", 1)[0]


class Transport:
    """记录所有出网请求，并按端点分派到桩。

    routes: {endpoint: callable(method, url, data) -> bytes | Exception}
    """

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, request, timeout=None):
        method = request.get_method()
        url = request.full_url
        self.calls.append(
            {"method": method, "url": url, "timeout": timeout, "data": request.data}
        )
        handler = self.routes.get(_endpoint_of(url))
        if handler is None:
            raise AssertionError(f"unexpected request: {method} {url}")
        result = handler(method, url, request.data)
        if isinstance(result, BaseException):
            raise result
        return FakeResponse(result)


class SleepRecorder:
    """替掉 time.sleep，把等待秒数记下来（测试里不真的等）。"""

    def __init__(self):
        self.calls = []

    def sleep(self, seconds):
        self.calls.append(seconds)


# 一条最小的 way 要素：闭合环 -> Polygon
SAMPLE_WAY = {
    "type": "way",
    "id": 123,
    "tags": {"building": "yes", "height": "12"},
    "geometry": [
        {"lat": 39.906, "lon": 116.381},
        {"lat": 39.907, "lon": 116.382},
        {"lat": 39.906, "lon": 116.381},
    ],
}


def probe_body():
    """探测请求的成功响应：只要是能解析的 JSON 就算探通。"""
    return json.dumps({"elements": [{"type": "node", "id": 1, "lat": 0.0, "lon": 0.0}]})


def query_body(elements=None):
    """正式查询的成功响应。"""
    if elements is None:
        elements = [SAMPLE_WAY]
    return json.dumps({"version": 0.6, "elements": elements})


def alive_route(payload=None):
    """探测通、查询也成功的端点。"""
    def handler(method, url, data):
        if method == "GET":
            return probe_body()
        return payload if payload is not None else query_body()
    return handler


def dead_route(error=None):
    """探测就失败的端点（DNS 解析失败之类的形态）。"""
    def handler(method, url, data):
        raise error if error is not None else urllib.error.URLError("unreachable")
    return handler


@pytest.fixture(autouse=True)
def _no_real_network(monkeypatch):
    """兜底：漏网的真实网络请求立刻失败，绝不打到外网。"""
    def _boom(request, timeout=None):
        raise AssertionError("测试里出现了未打桩的真实网络请求")
    monkeypatch.setattr(fetch, "_urlopen", _boom)


@pytest.fixture(autouse=True)
def _clean_endpoint_env(monkeypatch):
    """端点列表默认走内置的，测试自己要用时再显式设置。"""
    monkeypatch.delenv(fetch.ENDPOINTS_ENV_VAR, raising=False)


def _install(monkeypatch, routes):
    transport = Transport(routes)
    monkeypatch.setattr(fetch, "_urlopen", transport)
    sleeper = SleepRecorder()
    monkeypatch.setattr(fetch, "time", sleeper)
    return transport, sleeper


def _all_default_routes(handler):
    return {endpoint: handler for endpoint in fetch.DEFAULT_ENDPOINTS}


# ---------------------------------------------------------------- 端点列表

def test_env_overrides_the_default_endpoint_list(monkeypatch):
    """给了 OVERPASS_ENDPOINTS 就用它替代默认列表（不是追加）。"""
    monkeypatch.setenv(
        fetch.ENDPOINTS_ENV_VAR,
        "https://a.example/api/interpreter,https://b.example/api/interpreter",
    )
    endpoints = fetch.resolve_endpoints()
    assert endpoints == [
        "https://a.example/api/interpreter",
        "https://b.example/api/interpreter",
    ]
    assert not set(endpoints) & set(fetch.DEFAULT_ENDPOINTS)


def test_env_absent_uses_the_default_list(monkeypatch):
    """没设环境变量 -> 默认列表。"""
    monkeypatch.delenv(fetch.ENDPOINTS_ENV_VAR, raising=False)
    assert fetch.resolve_endpoints() == list(fetch.DEFAULT_ENDPOINTS)


def test_empty_env_value_falls_back_to_the_default_list(monkeypatch):
    """空值是「没配置」，不是「配置成空列表」——要兜底到默认列表。"""
    monkeypatch.setenv(fetch.ENDPOINTS_ENV_VAR, "")
    assert fetch.resolve_endpoints() == list(fetch.DEFAULT_ENDPOINTS)


def test_blank_env_entries_fall_back_to_the_default_list(monkeypatch):
    """只有空白与逗号 -> 同样兜底到默认列表。"""
    monkeypatch.setenv(fetch.ENDPOINTS_ENV_VAR, "  , ,  ")
    assert fetch.resolve_endpoints() == list(fetch.DEFAULT_ENDPOINTS)


def test_invalid_env_entries_are_dropped_and_reported(monkeypatch, capsys):
    """非 http/https 的条目被丢掉，并且要打印出来（不静默吞掉）。"""
    monkeypatch.setenv(
        fetch.ENDPOINTS_ENV_VAR,
        "not-a-url,https://ok.example/api/interpreter,ftp://x",
    )
    assert fetch.resolve_endpoints() == ["https://ok.example/api/interpreter"]
    err = capsys.readouterr().err
    assert "not-a-url" in err
    assert "ftp://x" in err


def test_all_invalid_env_values_fall_back_to_the_default_list(monkeypatch):
    """全是非法值 -> 兜底到默认列表（不能变成空列表，否则抓取直接没退路）。"""
    monkeypatch.setenv(fetch.ENDPOINTS_ENV_VAR, "not-a-url,ftp://x")
    assert fetch.resolve_endpoints() == list(fetch.DEFAULT_ENDPOINTS)


def test_explicit_endpoint_wins_over_the_env(monkeypatch):
    """命令行 --endpoint 优先级最高。"""
    monkeypatch.setenv(fetch.ENDPOINTS_ENV_VAR, "https://a.example/api/interpreter")
    assert fetch.resolve_endpoints("https://only.example/api/interpreter") == [
        "https://only.example/api/interpreter"
    ]


def test_endpoints_from_env_returns_empty_list_when_unset(monkeypatch):
    """底层读取函数：没设置时返回空列表，交给调用方兜底。"""
    monkeypatch.delenv(fetch.ENDPOINTS_ENV_VAR, raising=False)
    assert fetch.endpoints_from_env() == []


def test_endpoints_from_env_accepts_an_explicit_mapping():
    """底层读取函数也接受直接传入的 mapping（便于测试与复用）。"""
    assert fetch.endpoints_from_env(
        {fetch.ENDPOINTS_ENV_VAR: "https://a.example/api/interpreter"}
    ) == ["https://a.example/api/interpreter"]


# ---------------------------------------------------------------- 健康探测

def test_probe_failure_skips_the_endpoint_without_entering_the_retry_loop(monkeypatch):
    """探测不通 -> 立刻换下一个端点，一次正式查询都不发，也不等待。"""
    dead = "https://dead.example/api/interpreter"
    alive = "https://alive.example/api/interpreter"
    transport, sleeper = _install(
        monkeypatch,
        {dead: dead_route(), alive: alive_route()},
    )

    data, endpoint = fetch.fetch_overpass("query", [dead, alive])

    assert endpoint == alive
    assert data["elements"]
    # 死端点只收到 1 次探测（GET），0 次正式查询（POST）
    dead_calls = [c for c in transport.calls if _endpoint_of(c["url"]) == dead]
    assert [c["method"] for c in dead_calls] == ["GET"]
    assert sleeper.calls == []


def test_probe_uses_a_short_timeout_and_the_query_uses_the_long_one(monkeypatch):
    """探测是短超时，正式查询是长超时。"""
    endpoint = "https://alive.example/api/interpreter"
    transport, _ = _install(monkeypatch, {endpoint: alive_route()})

    fetch.fetch_overpass("query", [endpoint])

    probe_call = [c for c in transport.calls if c["method"] == "GET"][0]
    query_call = [c for c in transport.calls if c["method"] == "POST"][0]
    assert probe_call["timeout"] == fetch.PROBE_TIMEOUT
    assert query_call["timeout"] == fetch.HTTP_TIMEOUT
    assert fetch.PROBE_TIMEOUT < fetch.HTTP_TIMEOUT


def test_probe_uses_the_same_interpreter_url_with_a_tiny_query(monkeypatch):
    """探测打在同一个 interpreter 地址上（GET + 极小查询）。"""
    endpoint = "https://alive.example/api/interpreter"
    transport, _ = _install(monkeypatch, {endpoint: alive_route()})

    fetch.fetch_overpass("query", [endpoint])

    probe_call = [c for c in transport.calls if c["method"] == "GET"][0]
    assert probe_call["url"].startswith(endpoint + "?")
    query_param = urllib.parse.parse_qs(
        urllib.parse.urlsplit(probe_call["url"]).query
    )["data"][0]
    assert query_param == fetch.PROBE_QUERY
    assert probe_call["data"] is None


def test_probe_failure_of_every_endpoint_raises_fetch_error(monkeypatch):
    """所有端点都探不通 -> FetchError，失败原因里写明是探测失败。"""
    endpoints = ["https://a.example/api/interpreter", "https://b.example/api/interpreter"]
    transport, sleeper = _install(
        monkeypatch, {endpoint: dead_route() for endpoint in endpoints}
    )

    with pytest.raises(fetch.FetchError) as excinfo:
        fetch.fetch_overpass("query", endpoints)

    assert "unreachable" in str(excinfo.value)
    assert sleeper.calls == []
    assert not [c for c in transport.calls if c["method"] == "POST"]


def test_probe_failure_is_not_retried_even_with_many_endpoints(monkeypatch):
    """端点很多时，死端点也不会被反复试探：每个端点只探一次。"""
    endpoints = [f"https://n{index}.example/api/interpreter" for index in range(5)]
    transport, sleeper = _install(
        monkeypatch, {endpoint: dead_route() for endpoint in endpoints}
    )

    with pytest.raises(fetch.FetchError):
        fetch.fetch_overpass("query", endpoints)

    assert len(transport.calls) == len(endpoints)
    assert sleeper.calls == []


# ---------------------------------------------------------------- 指数退避

def test_backoff_curve_is_exponential_and_capped():
    """退避曲线：10 -> 20 -> 40，上限 60。"""
    assert fetch.backoff_delay(1) == 10
    assert fetch.backoff_delay(2) == 20
    assert fetch.backoff_delay(3) == 40
    assert fetch.backoff_delay(4) == 60
    assert fetch.backoff_delay(10) == fetch.BACKOFF_MAX
    assert fetch.backoff_delay(99) == fetch.BACKOFF_MAX


def test_backoff_of_a_non_positive_attempt_is_the_base_delay():
    """attempt 传 0 或负数时按第 1 次算（不抛异常、不给出 0 秒等待）。"""
    assert fetch.backoff_delay(0) == fetch.BACKOFF_BASE
    assert fetch.backoff_delay(-5) == fetch.BACKOFF_BASE


def test_retries_wait_follow_the_exponential_curve(monkeypatch):
    """重试之间的等待间隔就是退避曲线上的值（3 次尝试 -> 等 2 次）。"""
    endpoint = "https://flaky.example/api/interpreter"
    transport, sleeper = _install(
        monkeypatch,
        {endpoint: lambda method, url, data: (
            probe_body() if method == "GET" else urllib.error.URLError("boom")
        )},
    )

    with pytest.raises(fetch.FetchError):
        fetch.fetch_overpass("query", [endpoint])

    assert sleeper.calls == [fetch.backoff_delay(1), fetch.backoff_delay(2)]
    assert sleeper.calls == [10, 20]
    posts = [c for c in transport.calls if c["method"] == "POST"]
    assert len(posts) == fetch.MAX_ATTEMPTS


# ---------------------------------------------------------------- 既有行为

def test_remark_is_treated_as_a_failure(monkeypatch):
    """HTTP 200 + remark：这次尝试算失败，换下一个端点。"""
    bad = "https://remark.example/api/interpreter"
    good = "https://good.example/api/interpreter"
    transport, _ = _install(
        monkeypatch,
        {
            bad: lambda method, url, data: (
                probe_body()
                if method == "GET"
                else json.dumps({"remark": "runtime error: Query timed out"})
            ),
            good: alive_route(),
        },
    )

    data, endpoint = fetch.fetch_overpass("query", [bad, good])

    assert endpoint == good
    assert data["elements"]
    bad_posts = [c for c in transport.calls if c["method"] == "POST" and c["url"] == bad]
    assert len(bad_posts) == fetch.MAX_ATTEMPTS


def test_zero_elements_is_treated_as_a_failure(monkeypatch):
    """HTTP 200 + 0 个元素：算失败（该实例不覆盖这个范围），换下一个端点。"""
    bad = "https://empty.example/api/interpreter"
    good = "https://good.example/api/interpreter"
    transport, _ = _install(
        monkeypatch,
        {
            bad: lambda method, url, data: (
                probe_body() if method == "GET" else query_body(elements=[])
            ),
            good: alive_route(),
        },
    )

    data, endpoint = fetch.fetch_overpass("query", [bad, good])

    assert endpoint == good
    assert data["elements"]
    bad_posts = [c for c in transport.calls if c["method"] == "POST" and c["url"] == bad]
    assert len(bad_posts) == fetch.MAX_ATTEMPTS


def test_empty_result_is_never_written_to_disk(monkeypatch, tmp_path):
    """所有端点都只返回空结果：不写任何 GeoJSON，退出码非 0。"""
    out_dir = tmp_path / "geojson"
    _install(monkeypatch, _all_default_routes(
        lambda method, url, data: (
            probe_body() if method == "GET" else query_body(elements=[])
        )
    ))

    exit_code = fetch.main(["--out-dir", str(out_dir), "--only", "buildings"])

    assert exit_code == 1
    assert not (out_dir / "buildings.geojson").exists()
    assert not out_dir.exists() or not list(out_dir.iterdir())


def test_existing_dataset_is_left_untouched_when_the_fetch_fails(monkeypatch, tmp_path):
    """抓取失败时原有的数据集保持原样（不覆盖成空文件）。"""
    out_dir = tmp_path / "geojson"
    out_dir.mkdir(parents=True)
    target = out_dir / "buildings.geojson"
    target.write_text('{"type":"FeatureCollection","features":[]}', encoding="utf-8")
    _install(monkeypatch, _all_default_routes(dead_route()))

    exit_code = fetch.main(["--out-dir", str(out_dir), "--only", "buildings"])

    assert exit_code == 1
    assert target.read_text(encoding="utf-8") == (
        '{"type":"FeatureCollection","features":[]}'
    )


def test_successful_fetch_writes_the_geojson(monkeypatch, tmp_path):
    """抓取成功时照常写出 GeoJSON（加固没有把正常路径弄坏）。"""
    out_dir = tmp_path / "geojson"
    _install(monkeypatch, _all_default_routes(alive_route()))

    exit_code = fetch.main(["--out-dir", str(out_dir), "--only", "buildings"])

    assert exit_code == 0
    written = json.loads(
        (out_dir / "buildings.geojson").read_text(encoding="utf-8")
    )
    assert written["type"] == "FeatureCollection"
    assert len(written["features"]) == 1
    assert written["features"][0]["geometry"]["type"] == "Polygon"


# ---------------------------------------------------------------- CLI

def test_help_runs(capsys):
    """--help 能跑，四个既有参数都还在。"""
    with pytest.raises(SystemExit) as excinfo:
        fetch.parse_args(["--help"])
    assert excinfo.value.code == 0
    out = capsys.readouterr().out
    for flag in ("--endpoint", "--bbox", "--out-dir", "--only"):
        assert flag in out


def test_endpoint_argument_still_selects_a_single_endpoint(monkeypatch, tmp_path):
    """--endpoint 只用给的那一个端点。"""
    endpoint = "https://only.example/api/interpreter"
    transport, _ = _install(monkeypatch, {endpoint: alive_route()})
    out_dir = tmp_path / "geojson"

    exit_code = fetch.main(
        ["--endpoint", endpoint, "--out-dir", str(out_dir), "--only", "roads"]
    )

    assert exit_code == 0
    assert set(_endpoint_of(c["url"]) for c in transport.calls) == {endpoint}


def test_env_endpoints_are_used_by_the_cli(monkeypatch, tmp_path):
    """环境变量里的端点会被 CLI 用上（而不是默认列表）。"""
    endpoint = "https://from-env.example/api/interpreter"
    transport, _ = _install(monkeypatch, {endpoint: alive_route()})
    monkeypatch.setenv(fetch.ENDPOINTS_ENV_VAR, endpoint)
    out_dir = tmp_path / "geojson"

    exit_code = fetch.main(["--out-dir", str(out_dir), "--only", "roads"])

    assert exit_code == 0
    assert set(_endpoint_of(c["url"]) for c in transport.calls) == {endpoint}


def test_bbox_argument_is_parsed_and_validated():
    """--bbox 的四个数与合法性检查照旧。"""
    assert fetch.parse_bbox("39.905,116.380,39.925,116.420") == (
        39.905, 116.380, 39.925, 116.420,
    )
    for bad in ("1,2,3", "a,b,c,d", "39.925,116.380,39.905,116.420"):
        with pytest.raises(Exception):
            fetch.parse_bbox(bad)
