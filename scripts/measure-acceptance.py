#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验收指标度量脚本：一次跑完，输出对照计划书验收线的表格。

用法
----
    python scripts/measure-acceptance.py [选项]

覆盖率数字从哪里来
------------------
脚本**不现算**覆盖率（跑一遍要几十秒），而是读取已经跑好的覆盖率产物。
命令行显式指定的路径（--backend-coverage / --frontend-coverage）优先级最高；
否则按下面的顺序找，取第一个**存在**的文件：

    后端  <仓库根>/backend-python/coverage.json
          —— pytest-cov 的 `--cov-report=json` 默认就写在这个位置；
          找不到再回退 <度量产物目录>/backend-coverage.json
    前端  <仓库根>/Data-driven-modeling/coverage/coverage-final.json
          —— vitest 的 json reporter 默认写在这个位置（reportsDirectory=coverage）；
          找不到再回退 <度量产物目录>/frontend-coverage/coverage-final.json

产物缺失时对应指标显示「未提供」，其余指标照常测——脚本不猜数字。
默认度量产物目录是仓库根的 .acceptance/（已 gitignore）。

帧率什么时候不算数
------------------
帧率是**唯一**会被宿主机负载左右的指标：这台是共享开发机，
整机 CPU 被别的进程占住时，同样的代码量出来的帧率能掉到个位数。
度量脚本每轮都记了 systemCpuBusyPercent（测量期间整机 CPU 非空闲占比），
所以这里取各轮中位数：中位数 ≥ 60% 时两行帧率判「不可信（宿主机 CPU 忙）」，
既不算达标、也不算未达标，更不进未达标清单——那是机器忙，不是应用慢。
其它指标（首屏 LCP、load、体积、覆盖率、延迟）的判定一律不受影响。

延迟怎么测
----------
起一个**真实的 uvicorn 进程**（真实 HTTP 栈 + GZip/CORS/TrustedHost 中间件），
用 urllib 发真实请求取时延，**不是** TestClient（那不经过 HTTP 栈，
测出来的数没有参考价值）。

两个踩过的坑，这里已经绕开：
  1. 子进程的 stdout/stderr **必须落文件**。用没人读的 PIPE 的话，
     uvicorn 的请求日志会填满 64KB 管道缓冲，服务器直接阻塞在写日志上，
     表现为「所有请求超时 60 秒」——那是测量脚本的 bug，不是应用慢。
  2. 端口不写死 8000（本机 8000 被别的项目占着），默认 8031，
     端口被占就自动往后换一个。

退出码
------
永远是 0：这一步是「报告」不是「门禁」。未达标的项在输出里逐条列出，
要不要把它们变成红灯是维护者的决定。

依赖
----
只用标准库。任何 Python 3.8+ 解释器都能跑（CI 里用系统 python 即可，
不必先进 venv）。
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import socket
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# 计划书《智慧城市3D可视化计划书.docx》的验收线
# ---------------------------------------------------------------------------
TARGET_BUILDINGS_P95_MS = 200.0
TARGET_ROADS_P95_MS = 200.0
TARGET_BBOX_P95_MS = 200.0
TARGET_BACKEND_COVERAGE = 90.0
TARGET_FRONTEND_COVERAGE = 80.0
TARGET_APP_BUNDLE_MB = 5.0
# 浏览器端验收线：首屏 < 3 s、3D 渲染帧率 >= 30 fps
TARGET_FIRST_SCREEN_MS = 3000.0
TARGET_FPS = 30.0

# 测量期间整机 CPU 非空闲占比达到这个数，帧率数字就不作数了。
# 阈值与 measure-browser-performance.mjs 自己告警时用的那条线一致。
BUSY_HOST_CPU_PERCENT = 60.0

# 带 bbox 的测量用例：OSM 抽取范围 116.380,39.905,116.420,39.925 的左上一块。
# 故意不取整个范围——那等于「全量过滤」，比真实使用场景重得多。
MEASURE_BBOX = "116.390,39.905,116.405,39.915"

DEFAULT_PORT = 8031
DEFAULT_REQUESTS = 30
USER_AGENT = "smart-city-acceptance/1.0"

# 判定用的取值
PASS = "达标"
FAIL = "未达标"
UNKNOWN = "未提供"
NOTE = "口径差异"
UNRELIABLE = "不可信（宿主机 CPU 忙）"


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
def _width(text: str) -> int:
    """按终端显示宽度算字符串长度（中文/全角算 2 列）。"""
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in text)


def _pad(text: str, width: int, align: str = "left") -> str:
    gap = max(0, width - _width(text))
    if align == "right":
        return " " * gap + text
    return text + " " * gap


def render_table(header, rows) -> str:
    """渲染一张等宽表格（ASCII 边框，避免控制台编码问题）。"""
    widths = []
    for index in range(len(header)):
        widths.append(max(_width(str(header[index])), *(
            _width(str(row[index])) for row in rows
        )) if rows else _width(str(header[index])))

    def line(left, mid, right):
        return left + mid.join("-" * (w + 2) for w in widths) + right

    out = [line("+", "+", "+")]
    out.append("| " + " | ".join(_pad(str(h), widths[i]) for i, h in enumerate(header)) + " |")
    out.append(line("+", "+", "+"))
    for row in rows:
        out.append("| " + " | ".join(_pad(str(c), widths[i]) for i, c in enumerate(row)) + " |")
    out.append(line("+", "+", "+"))
    return "\n".join(out)


def _percent(value) -> str:
    return "未提供" if value is None else f"{value:.2f}%"


def _mb(byte_count) -> str:
    return f"{byte_count / (1024 * 1024):.2f} MB"


def _ms(value) -> str:
    return "未提供" if value is None else f"{value:.1f} ms"


def _sec(value) -> str:
    """毫秒 → 秒。首屏时间用秒更贴近「< 3 s」这条验收线的读法。"""
    return "未提供" if value is None else f"{value / 1000:.2f} s"


def _fps(value) -> str:
    return "未提供" if value is None else f"{value:.1f} fps"


# ---------------------------------------------------------------------------
# HTTP 测量
# ---------------------------------------------------------------------------
def http_get(url: str, timeout: float = 60.0, accept_gzip: bool = False):
    """发一次真实 HTTP GET，返回 (状态码, 耗时毫秒, 响应体字节数, 响应头)。"""
    headers = {"User-Agent": USER_AGENT}
    if accept_gzip:
        headers["Accept-Encoding"] = "gzip"
    request = urllib.request.Request(url, headers=headers)
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
            status = response.status
            response_headers = dict(response.headers)
    except urllib.error.HTTPError as exc:
        payload = exc.read()
        status = exc.code
        response_headers = dict(exc.headers)
    except Exception:
        raise
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    if response_headers.get("Content-Encoding", "").lower() == "gzip":
        payload = gzip.decompress(payload)
    return status, elapsed_ms, len(payload), response_headers


def percentile(samples, fraction: float) -> float:
    """取分位数（最近秩法）。samples 必须已排序。"""
    if not samples:
        return float("nan")
    rank = max(1, math.ceil(fraction * len(samples)))
    return samples[min(rank, len(samples)) - 1]


def median(values):
    """中位数。偶数个取中间两个的平均——口径与浏览器度量脚本的 median() 一致。"""
    ordered = sorted(values)
    if not ordered:
        return None
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return float(ordered[middle])
    return (ordered[middle - 1] + ordered[middle]) / 2.0


# ---------------------------------------------------------------------------
# 后端进程
# ---------------------------------------------------------------------------
def find_python(repo_root: Path) -> str:
    """优先用 backend-python/.venv 里的解释器；没有就用当前解释器。"""
    venv = repo_root / "backend-python" / ".venv"
    for relative in (("Scripts", "python.exe"), ("bin", "python")):
        candidate = venv.joinpath(*relative)
        if candidate.exists():
            return str(candidate)
    return sys.executable


def pick_port(preferred: int) -> int:
    """找一个能绑的端口。preferred 被占就往后找。"""
    for candidate in range(preferred, preferred + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", candidate))
                return candidate
            except OSError:
                continue
    raise RuntimeError(f"{preferred}..{preferred + 39} 之间的端口都被占用了")


class BackendProcess:
    """起一个真实的 uvicorn 子进程，并把它的日志落盘。"""

    def __init__(self, repo_root: Path, port: int, log_path: Path):
        self.repo_root = repo_root
        self.port = port
        self.log_path = log_path
        self.process = None
        self._log_handle = None

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self, startup_timeout: float = 30.0) -> None:
        backend_dir = self.repo_root / "backend-python"
        env = dict(os.environ)
        env["PORT"] = str(self.port)
        env["PYTHONUNBUFFERED"] = "1"
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        # 关键：stdout/stderr 落文件。没人读的 PIPE 会让 uvicorn 卡在写日志上。
        self._log_handle = open(self.log_path, "wb")
        self.process = subprocess.Popen(
            [find_python(self.repo_root), "main.py"],
            cwd=str(backend_dir),
            env=env,
            stdout=self._log_handle,
            stderr=subprocess.STDOUT,
        )
        deadline = time.time() + startup_timeout
        while time.time() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(
                    f"后端进程启动即退出（退出码 {self.process.returncode}），"
                    f"日志见 {self.log_path}"
                )
            try:
                status, _, _, _ = http_get(self.base_url + "/health", timeout=2.0)
                if status == 200:
                    return
            except Exception:
                pass
            time.sleep(0.2)
        raise RuntimeError(f"后端在 {startup_timeout} 秒内没有就绪，日志见 {self.log_path}")

    def stop(self) -> None:
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)
        if self._log_handle is not None:
            self._log_handle.close()
            self._log_handle = None


# ---------------------------------------------------------------------------
# 覆盖率产物
# ---------------------------------------------------------------------------
def resolve_coverage_artifact(explicit, candidates):
    """挑出实际要读的覆盖率产物路径。

    explicit 是命令行显式给的路径（非 None 时优先级最高）；
    否则按 candidates 顺序取第一个**存在**的文件。
    一个都不存在时返回首选路径——读不到就是「未提供」，不猜数字。

    返回 (路径, 来源说明)。
    """
    if explicit is not None:
        return explicit, "命令行指定"
    for index, candidate in enumerate(candidates):
        if candidate.is_file():
            return candidate, "工具默认路径" if index == 0 else "度量产物目录"
    searched = "、".join(str(candidate) for candidate in candidates)
    return candidates[0], f"未找到（已搜索：{searched}）"


def read_backend_coverage(path: Path):
    """读 coverage.py 的 json 报告。返回 (总覆盖率百分比, {文件: [缺失行号]})。"""
    if not path.is_file():
        return None, {}
    data = json.loads(path.read_text(encoding="utf-8"))
    totals = data.get("totals") or {}
    percent = totals.get("percent_covered")
    missing = {}
    for filename, entry in (data.get("files") or {}).items():
        lines = entry.get("missing_lines") or []
        if lines:
            missing[filename] = sorted(lines)
    return percent, missing


def read_frontend_coverage(path: Path):
    """读 vitest 的 istanbul json 报告。

    返回 (语句覆盖率, 汇总字典, {文件: [缺失行号]})。
    """
    if not path.is_file():
        return None, {}, {}
    data = json.loads(path.read_text(encoding="utf-8"))
    statements_total = statements_covered = 0
    functions_total = functions_covered = 0
    branches_total = branches_covered = 0
    missing = {}
    for filename, coverage in data.items():
        statements = coverage.get("s", {})
        functions = coverage.get("f", {})
        branches = coverage.get("b", {})
        statements_total += len(statements)
        statements_covered += sum(1 for value in statements.values() if value > 0)
        functions_total += len(functions)
        functions_covered += sum(1 for value in functions.values() if value > 0)
        for hits in branches.values():
            branches_total += len(hits)
            branches_covered += sum(1 for value in hits if value > 0)
        statement_map = coverage.get("statementMap", {})
        missed = sorted({
            statement_map[key]["start"]["line"]
            for key, value in statements.items()
            if value == 0 and key in statement_map
        })
        if missed:
            missing[filename] = missed
    if not statements_total:
        return None, {}, missing
    summary = {
        "statements": (statements_covered, statements_total),
        "functions": (functions_covered, functions_total),
        "branches": (branches_covered, branches_total),
    }
    return statements_covered / statements_total * 100.0, summary, missing


def read_browser_metrics(path: Path):
    """读浏览器端度量产物（scripts/measure-browser-performance.mjs 写的 JSON）。

    产物缺失或坏掉时返回 None——**不猜数字**，对应指标显示「未提供」。
    产物里有 runs（逐轮原始数据）与 summary（各轮中位数）。
    """
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def busy_host_cpu_percent(browser_data):
    """取各轮 systemCpuBusyPercent 的中位数（%）；产物里没这项时返回 None。

    这个数字是「测量期间整机 CPU 非空闲占比」——宿主机忙不忙全看它。
    """
    values = []
    for run in browser_data.get("runs") or []:
        value = (run or {}).get("systemCpuBusyPercent")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if math.isfinite(value):
            values.append(float(value))
    return median(values) if values else None


def _source_snippet(source_path: Path, line_number: int) -> str:
    """取出某一行的源码文本（拿不到就返回空串）。"""
    try:
        lines = source_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    if 1 <= line_number <= len(lines):
        return lines[line_number - 1].strip()
    return ""


# ---------------------------------------------------------------------------
# 产物体积
# ---------------------------------------------------------------------------
def measure_dist(dist_dir: Path):
    """统计 dist/ 的文件数与体积，拆成「Cesium 运行时」与「应用产物」两份。"""
    if not dist_dir.is_dir():
        return None
    cesium_files = 0
    cesium_bytes = 0
    app_files = 0
    app_bytes = 0
    for path in dist_dir.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(dist_dir).as_posix()
        size = path.stat().st_size
        if relative.startswith("Cesium/"):
            cesium_files += 1
            cesium_bytes += size
        else:
            app_files += 1
            app_bytes += size
    return {
        "cesium_files": cesium_files,
        "cesium_bytes": cesium_bytes,
        "app_files": app_files,
        "app_bytes": app_bytes,
        "total_files": cesium_files + app_files,
        "total_bytes": cesium_bytes + app_bytes,
    }


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def parse_args(argv):
    repo_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="智慧城市平台验收指标度量")
    parser.add_argument("--repo-root", default=str(repo_root), help="仓库根目录")
    parser.add_argument("--artifacts", default=None,
                        help="覆盖率产物目录（默认 <仓库根>/.acceptance）")
    parser.add_argument("--backend-coverage", default=None,
                        help="后端 coverage.py json 报告路径")
    parser.add_argument("--frontend-coverage", default=None,
                        help="前端 vitest istanbul json 报告路径")
    parser.add_argument("--dist-dir", default=None,
                        help="前端构建产物目录（默认 <仓库根>/Data-driven-modeling/dist）")
    parser.add_argument("--browser-metrics", default=None,
                        help="浏览器端度量产物 JSON（默认 <artifacts>/browser-performance.json，"
                             "由 scripts/measure-browser-performance.mjs 产出）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="测量用的后端端口")
    parser.add_argument("--requests", type=int, default=DEFAULT_REQUESTS,
                        help="每个端点发多少个请求取分位数")
    parser.add_argument("--skip-http", action="store_true",
                        help="跳过延迟测量（只报覆盖率与体积）")
    args = parser.parse_args(argv)

    args.repo_root = Path(args.repo_root).resolve()
    args.artifacts = Path(args.artifacts).resolve() if args.artifacts \
        else args.repo_root / ".acceptance"
    # 覆盖率：命令行显式指定的路径优先级最高；没指定就按下面的顺序找。
    args.backend_coverage = Path(args.backend_coverage).resolve() if args.backend_coverage \
        else None
    args.frontend_coverage = Path(args.frontend_coverage).resolve() if args.frontend_coverage \
        else None
    args.backend_coverage_candidates = [
        args.repo_root / "backend-python" / "coverage.json",
        args.artifacts / "backend-coverage.json",
    ]
    args.frontend_coverage_candidates = [
        args.repo_root / "Data-driven-modeling" / "coverage" / "coverage-final.json",
        args.artifacts / "frontend-coverage" / "coverage-final.json",
    ]
    args.dist_dir = Path(args.dist_dir).resolve() if args.dist_dir \
        else args.repo_root / "Data-driven-modeling" / "dist"
    args.browser_metrics = Path(args.browser_metrics).resolve() if args.browser_metrics \
        else args.artifacts / "browser-performance.json"
    return args


def measure_endpoint(base_url: str, path: str, count: int):
    """对同一个端点连发 count 个请求，返回时延统计与最后一次的响应信息。

    第一个请求单独记为「冷启动」：它是**第一次**读这份数据，
    含 GeoJSON 解析与首次序列化，跟稳态延迟不是一回事，
    混进 P95 会把「冷启动成本」和「稳态延迟」搅在一起。
    """
    cold_ms = None
    status, elapsed_ms, size, _headers = http_get(base_url + path, timeout=60.0)
    cold_ms = elapsed_ms
    if status != 200:
        return {
            "status": status, "p50": None, "p95": None, "max": None,
            "count": 0, "size": size, "cold_ms": cold_ms,
        }

    samples = []
    last_status = status
    last_size = size
    for _ in range(count):
        status, elapsed_ms, size, _headers = http_get(base_url + path, timeout=60.0)
        last_status = status
        last_size = size
        if status != 200:
            # 非 200（比如数据缺失时的 503）继续发没有意义，提前收手。
            break
        samples.append(elapsed_ms)
    samples.sort()
    if not samples:
        return {
            "status": last_status, "p50": None, "p95": None, "max": None,
            "count": 0, "size": last_size, "cold_ms": cold_ms,
        }
    return {
        "status": last_status,
        "p50": percentile(samples, 0.50),
        "p95": percentile(samples, 0.95),
        "max": samples[-1],
        "min": samples[0],
        "count": len(samples),
        "size": last_size,
        "cold_ms": cold_ms,
    }


def measure_gzip_p95(base_url: str, path: str, count: int):
    """同一端点带 Accept-Encoding: gzip 再测一轮（浏览器实际走的就是这条路）。"""
    samples = []
    for _ in range(count):
        status, elapsed_ms, _size, _headers = http_get(
            base_url + path, timeout=60.0, accept_gzip=True
        )
        if status != 200:
            return None
        samples.append(elapsed_ms)
    if not samples:
        return None
    samples.sort()
    return percentile(samples, 0.95)


def main(argv=None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    repo_root = args.repo_root

    print("=" * 78)
    print("智慧城市平台 · 验收指标度量")
    print("=" * 78)
    print(f"仓库根      : {repo_root}")
    print(f"度量产物目录: {args.artifacts}")

    # --- 覆盖率产物落在哪 ---------------------------------------------------
    backend_path, backend_source = resolve_coverage_artifact(
        args.backend_coverage, args.backend_coverage_candidates
    )
    frontend_path, frontend_source = resolve_coverage_artifact(
        args.frontend_coverage, args.frontend_coverage_candidates
    )
    print(f"后端覆盖率  : {backend_path}（{backend_source}）")
    print(f"前端覆盖率  : {frontend_path}（{frontend_source}）")
    print()

    # --- 覆盖率 -------------------------------------------------------------
    backend_percent, backend_missing = read_backend_coverage(backend_path)
    frontend_percent, frontend_summary, frontend_missing = read_frontend_coverage(
        frontend_path
    )

    # --- 产物体积 -----------------------------------------------------------
    dist = measure_dist(args.dist_dir)

    # --- 延迟 ---------------------------------------------------------------
    endpoints = {}
    gzip_p95 = {}
    server_note = ""
    data_available = True
    if args.skip_http:
        server_note = "已用 --skip-http 跳过延迟测量"
    else:
        port = pick_port(args.port)
        log_path = args.artifacts / "server-logs" / f"backend-{port}.log"
        server = BackendProcess(repo_root, port, log_path)
        try:
            server.start()
            endpoints["/api/buildings"] = measure_endpoint(
                server.base_url, "/api/buildings", args.requests
            )
            endpoints["/api/roads"] = measure_endpoint(
                server.base_url, "/api/roads", args.requests
            )
            endpoints["bbox"] = measure_endpoint(
                server.base_url, f"/api/buildings?bbox={MEASURE_BBOX}", args.requests
            )
            for key, result in endpoints.items():
                if result["status"] not in (200, None):
                    data_available = False
                    server_note = (
                        f"后端返回 HTTP {result['status']}（多半是 geojson/ 数据缺失），"
                        f"延迟指标不可信；服务端日志：{log_path}"
                    )
                    break
            gzip_p95 = {
                key: measure_gzip_p95(server.base_url, path, min(args.requests, 10))
                for key, path in (
                    ("/api/buildings", "/api/buildings"),
                    ("/api/roads", "/api/roads"),
                )
            }
        except Exception as exc:
            server_note = f"后端起不来，延迟指标无法测量：{exc}"
            gzip_p95 = {}
        finally:
            server.stop()

    # --- 对照表 -------------------------------------------------------------
    rows = []
    unmet = []

    def latency_row(label, target, result, note=""):
        if result is None or result.get("p95") is None:
            rows.append([label, f"< {target:.0f} ms", "未提供", "无法评估" + (f"（{note}）" if note else "")])
            return
        ok = result["p95"] < target
        rows.append([
            label,
            f"< {target:.0f} ms",
            _ms(result["p95"]),
            PASS if ok else FAIL,
        ])
        if not ok:
            unmet.append(f"{label}：P95 {result['p95']:.1f} ms ≥ {target:.0f} ms")

    latency_row("/api/buildings（全量）P95", TARGET_BUILDINGS_P95_MS,
                endpoints.get("/api/buildings"), server_note)
    latency_row("/api/roads（全量）P95", TARGET_ROADS_P95_MS,
                endpoints.get("/api/roads"), server_note)
    latency_row(f"带 bbox 的路径 P95（bbox={MEASURE_BBOX}）", TARGET_BBOX_P95_MS,
                endpoints.get("bbox"), server_note)

    if backend_percent is None:
        rows.append(["后端覆盖率", "> 90%", "未提供", "未提供覆盖率产物"])
        unmet.append(f"后端覆盖率：未提供覆盖率产物（{backend_path}）")
    else:
        ok = backend_percent > TARGET_BACKEND_COVERAGE
        rows.append(["后端覆盖率（main.py + data_processor.py）", "> 90%",
                     _percent(backend_percent), PASS if ok else FAIL])
        if not ok:
            unmet.append(f"后端覆盖率：{backend_percent:.2f}% ≤ 90%")

    if frontend_percent is None:
        rows.append(["前端覆盖率", "> 80%", "未提供", "未提供覆盖率产物"])
        unmet.append(f"前端覆盖率：未提供覆盖率产物（{frontend_path}）")
    else:
        ok = frontend_percent > TARGET_FRONTEND_COVERAGE
        rows.append(["前端覆盖率（src/**）", "> 80%",
                     _percent(frontend_percent), PASS if ok else FAIL])
        if not ok:
            unmet.append(f"前端覆盖率：{frontend_percent:.2f}% ≤ 80%")

    if dist is None:
        rows.append(["Vite 产物体积（不含 Cesium 运行时）", "< 5 MB", "未提供",
                     "未找到 dist/（先跑 npm run build）"])
        rows.append(["dist/ 总体积", "口径差异", "未提供", "未找到 dist/"])
    else:
        app_mb = dist["app_bytes"] / (1024 * 1024)
        ok = app_mb < TARGET_APP_BUNDLE_MB
        rows.append([
            "Vite 产物体积（不含 Cesium 运行时）",
            "< 5 MB",
            f"{app_mb:.2f} MB（{dist['app_files']} 个文件）",
            PASS if ok else FAIL,
        ])
        if not ok:
            unmet.append(f"Vite 产物体积：{app_mb:.2f} MB ≥ 5 MB")
        total_mb = dist["total_bytes"] / (1024 * 1024)
        rows.append([
            "dist/ 总体积",
            "（计划书写的是 < 5 MB，但含 6.6 MB 自托管 Cesium 运行时）",
            f"{total_mb:.2f} MB（{dist['total_files']} 个文件）",
            NOTE,
        ])

    # --- 浏览器端指标 ---------------------------------------------------
    # 产物由 scripts/measure-browser-performance.mjs 产出（生产构建 + 独立 headless Chrome）。
    # 产物缺失时显示「未提供」——不猜数字。
    browser = read_browser_metrics(args.browser_metrics)
    cpu_busy_median = None
    busy_host = False
    busy_note = ""
    if browser is None:
        for label, target in (
            ("首屏（LargestContentfulPaint）", "< 3 s"),
            ("页面 load 事件（loadEventEnd）", "< 3 s"),
            ("帧率（静止）", ">= 30 fps"),
            ("帧率（相机运动）", ">= 30 fps"),
        ):
            rows.append([label, target, "未提供", "未找到浏览器度量产物"])
        unmet.append("浏览器端指标：未提供浏览器度量产物"
                     "（先跑 node scripts/measure-browser-performance.mjs）")
    else:
        summary = browser.get("summary") or {}

        def browser_median(key):
            return (summary.get(key) or {}).get("median")

        # 宿主机忙不忙：只有帧率受这个影响，其它指标的判定一律不动。
        cpu_busy_median = busy_host_cpu_percent(browser)
        busy_host = (cpu_busy_median is not None
                     and cpu_busy_median >= BUSY_HOST_CPU_PERCENT)
        if busy_host:
            busy_note = (
                f"宿主机 CPU 忙（测量期间整机非空闲中位数 {cpu_busy_median:.0f}% "
                f"≥ {BUSY_HOST_CPU_PERCENT:.0f}%）：两行帧率判「{UNRELIABLE}」，"
                f"不计入未达标清单——是机器忙，不是应用慢"
            )

        lcp_ms = browser_median("lcpMs")
        load_ms = browser_median("loadEventEndMs")
        ready_ms = browser_median("appReadyMs")
        fps_static = browser_median("fpsStatic")
        fps_motion = browser_median("fpsMotion")

        if lcp_ms is None:
            rows.append(["首屏（LargestContentfulPaint）", "< 3 s", "未提供", "度量产物缺该项"])
        else:
            ok = lcp_ms < TARGET_FIRST_SCREEN_MS
            rows.append(["首屏（LargestContentfulPaint）", "< 3 s", _sec(lcp_ms),
                         PASS if ok else FAIL])
            if not ok:
                unmet.append(f"首屏 LCP：中位数 {lcp_ms:.0f} ms "
                             f">= {TARGET_FIRST_SCREEN_MS:.0f} ms")

        if load_ms is None:
            rows.append(["页面 load 事件（loadEventEnd）", "< 3 s", "未提供", "度量产物缺该项"])
        else:
            ok = load_ms < TARGET_FIRST_SCREEN_MS
            rows.append(["页面 load 事件（loadEventEnd）", "< 3 s", _sec(load_ms),
                         PASS if ok else FAIL])
            if not ok:
                unmet.append(f"load 事件：中位数 {load_ms:.0f} ms "
                             f">= {TARGET_FIRST_SCREEN_MS:.0f} ms")

        if ready_ms is None:
            rows.append(["应用就绪（数据到位 → 城市入场景）", "参考（无验收线）", "未提供",
                         "度量产物缺该项"])
        else:
            rows.append(["应用就绪（数据到位 → 城市入场景）", "参考（无验收线）",
                         _sec(ready_ms), NOTE])

        cold_ms = browser_median("coldStartFirstByteMs")
        if cold_ms is None:
            rows.append(["冷启动（全新浏览器首个导航的首字节）", "参考（浏览器开销，不是产品成本）",
                         "未提供", "度量产物缺该项"])
        else:
            rows.append(["冷启动（全新浏览器首个导航的首字节）",
                         "参考（浏览器开销，不是产品成本）", _sec(cold_ms), NOTE])

        if fps_static is None:
            rows.append(["帧率（静止）", ">= 30 fps", "未提供", "度量产物缺该项"])
        elif busy_host:
            # 宿主机在抢 CPU：这个数字既不判达标也不判未达标，更不进 unmet。
            rows.append(["帧率（静止）", ">= 30 fps", _fps(fps_static), UNRELIABLE])
        else:
            ok = fps_static >= TARGET_FPS
            rows.append(["帧率（静止）", ">= 30 fps", _fps(fps_static),
                         PASS if ok else FAIL])
            if not ok:
                unmet.append(f"静止帧率：中位数 {fps_static:.1f} fps < {TARGET_FPS:.0f} fps")

        if fps_motion is None:
            rows.append(["帧率（相机运动）", ">= 30 fps", "未提供", "度量产物缺该项"])
        elif busy_host:
            rows.append(["帧率（相机运动）", ">= 30 fps", _fps(fps_motion), UNRELIABLE])
        else:
            ok = fps_motion >= TARGET_FPS
            rows.append(["帧率（相机运动）", ">= 30 fps", _fps(fps_motion),
                         PASS if ok else FAIL])
            if not ok:
                unmet.append(f"运动帧率：中位数 {fps_motion:.1f} fps < {TARGET_FPS:.0f} fps")

        transfer_bytes = browser_median("transferBytes")
        decoded_bytes = browser_median("decodedBytes")
        tile_count = browser_median("externalTileCount")
        tile_ms = browser_median("externalTileDurationMs")
        rows.append(["首屏传输量（线上字节，不含外部请求）", "参考",
                     _mb(transfer_bytes) if transfer_bytes is not None else "未提供", NOTE])
        rows.append(["首屏解码后体积（不含外部请求）", "参考",
                     _mb(decoded_bytes) if decoded_bytes is not None else "未提供", NOTE])
        if tile_count is not None and tile_ms is not None:
            rows.append([
                "外部请求（第三方）",
                "参考（外部依赖，不是前端成本）",
                f"{tile_count:.0f} 个 / {tile_ms:.0f} ms",
                NOTE,
            ])
        else:
            rows.append(["外部请求（第三方）", "参考（外部依赖，不是前端成本）",
                         "未提供", NOTE])

    print(render_table(["指标", "计划书验收线", "实测", "判定"], rows))
    print()

    # --- 附加信息 -----------------------------------------------------------
    if endpoints:
        print("延迟明细（同一进程、连续请求，单位毫秒）")
        detail_rows = []
        for key, result in endpoints.items():
            if result.get("p95") is None:
                continue
            detail_rows.append([
                key,
                str(result.get("count", 0)),
                _ms(result.get("cold_ms")),
                _ms(result.get("min")),
                _ms(result.get("p50")),
                _ms(result.get("p95")),
                _ms(result.get("max")),
                f"{result.get('size', 0) / 1024:.0f} KB",
            ])
        print(render_table(
            ["端点", "请求数", "冷启动", "min", "P50", "P95", "max", "响应体"], detail_rows))
        print("「冷启动」是第一个请求（含 GeoJSON 解析），不计入 P95。")
        print("「min」是所有轮次里最快的一次：共享开发机上跑时，它比 P95 更能说明"
              "「应用本身有多快」，P95 里混着宿主机负载。")
        print()

        if gzip_p95:
            gzip_rows = [
                [path, _ms(value)]
                for path, value in gzip_p95.items() if value is not None
            ]
            if gzip_rows:
                print("同一端点带 Accept-Encoding: gzip（浏览器实际走的就是这条路）")
                print(render_table(["端点", "gzip P95"], gzip_rows))
                print()

    if dist is not None:
        print(f"产物拆分：Cesium 运行时 {dist['cesium_files']} 个文件 / "
              f"{_mb(dist['cesium_bytes'])}；"
              f"应用产物 {dist['app_files']} 个文件 / {_mb(dist['app_bytes'])}")
        print()

    if browser is not None:
        env = browser.get("environment") or {}
        runs = browser.get("runs") or []
        print("浏览器端性能明细（生产构建 + 后端单端口托管 + 独立 headless Chrome）")
        detail_rows = []
        for run in runs:
            external = (run.get("transfer") or {}).get("external") or {}
            detail_rows.append([
                str(run.get("run", "")),
                _sec(run.get("lcpMs")),
                _sec(run.get("loadEventEndMs")),
                _sec(run.get("appReadyMs")),
                _fps(run.get("fpsStatic")),
                _fps(run.get("fpsMotion")),
                str(external.get("tileCount", "—")),
                f"{external.get('tileDurationMs', 0)} ms",
            ])
        print(render_table(
            ["轮", "LCP", "load", "应用就绪", "静止 fps", "运动 fps", "瓦片数", "瓦片耗时"],
            detail_rows))
        print()
        print(f"浏览器：{env.get('chromeVersion') or env.get('chromeBinary') or '未知'}"
              f"（{'headless' if env.get('headless') else 'headful'}）"
              f" · 采样 {env.get('runs')} 轮 × {env.get('sampleSeconds')} 秒"
              f" · 浏览器缓存"
              f"{'已禁用（每轮都是首次访问）' if env.get('cacheDisabled') else '已启用'}")
        if cpu_busy_median is not None:
            print(f"宿主机  ：测量期间整机 CPU 非空闲中位数 {cpu_busy_median:.0f}%"
                  f"（≥ {BUSY_HOST_CPU_PERCENT:.0f}% 时帧率判「{UNRELIABLE}」）")
        print("口径  ：首屏 LCP 是浏览器的 Largest Contentful Paint。WebGL 画布不是 LCP 候选元素，")
        print("        LCP 量到的是页面文字块；「3D 城市画出来」对应的口径是「应用就绪」那一行。")
        print("        首屏量的是**浏览器已就绪之后**的页面加载；全新 Chrome 的冷启动首字节延迟")
        print("        单独记在「冷启动」那一行（那是浏览器开销，不是产品成本）。")
        print("外部网：第三方请求的等待时间是外部网络成本，")
        print("        传输量已把它拆开单列——读首屏数字时别把它算到前端头上。")
        print()

    if frontend_summary:
        def _pair(name, key):
            covered, total = frontend_summary[key]
            return f"{name} {covered}/{total}（{covered / total * 100:.2f}%）"
        print("前端覆盖率明细（语句 / 函数 / 分支）：")
        print(f"  {_pair('语句', 'statements')}")
        print(f"  {_pair('函数', 'functions')}")
        print(f"  {_pair('分支', 'branches')}")
        print()

    # --- 未覆盖清单 ---------------------------------------------------------
    if backend_missing:
        print("未覆盖清单 · 后端")
        for filename, lines in sorted(backend_missing.items()):
            source = repo_root / "backend-python" / filename
            print(f"  {filename}")
            for line_number in lines:
                snippet = _source_snippet(source, line_number)
                print(f"    {line_number:>4}: {snippet}")
        print()

    if frontend_missing:
        print("未覆盖清单 · 前端")
        for filename, lines in sorted(frontend_missing.items()):
            relative = filename
            try:
                relative = str(Path(filename).resolve().relative_to(repo_root))
            except (ValueError, OSError):
                relative = filename
            source = repo_root / relative
            print(f"  {relative}")
            for line_number in lines:
                snippet = _source_snippet(source, line_number)
                print(f"    {line_number:>4}: {snippet}")
        print()

    # --- 结论 ---------------------------------------------------------------
    if unmet:
        print("未达标项（只报告，不阻塞）：")
        for item in unmet:
            print(f"  - {item}")
    else:
        print("全部指标达标。")
    if server_note:
        print(f"备注：{server_note}")
    if busy_note:
        print(f"备注：{busy_note}")
    print()
    print("退出码 0 —— 这一步是报告，不是门禁。")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.exit(main())
