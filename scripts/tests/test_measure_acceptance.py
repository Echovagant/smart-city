#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""scripts/measure-acceptance.py 的回归测试。

盯两件事：

1. **覆盖率产物的查找顺序**。工具自己写出来的默认位置找不到时，
   要回退到度量产物目录；命令行显式指定的路径优先级最高。
2. **宿主机忙时的帧率**。CPU 非空闲占比中位数 ≥ 60% 时，两行帧率判
   「不可信」，既不算达标也不算未达标，更不进未达标清单。

只用标准库 unittest。跑法：

    python scripts/tests/test_measure_acceptance.py
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve().parent.parent / "measure-acceptance.py"
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"


def _load_acceptance_module():
    """按文件路径加载 measure-acceptance.py（文件名带连字符，不是合法模块名）。"""
    spec = importlib.util.spec_from_file_location("measure_acceptance", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


acceptance = _load_acceptance_module()


BACKEND_COVERAGE = {"totals": {"percent_covered": 94.25}, "files": {}}
FRONTEND_COVERAGE = {
    "src/example.ts": {
        "s": {"1": 1, "2": 0},
        "f": {"1": 1},
        "b": {"1": [1, 0]},
        "statementMap": {"1": {"start": {"line": 1}}, "2": {"start": {"line": 2}}},
    }
}


def _row_line(output: str, label: str) -> str:
    """从表格输出里取出标签所在的那一行。"""
    for line in output.splitlines():
        if line.startswith("|") and label in line:
            return line
    raise AssertionError(f"表格里没有找到行：{label}\n{output}")


def _unmet_items(output: str):
    """取出「未达标项」清单里的条目（每条以 "  - " 开头）。"""
    items = []
    collecting = False
    for line in output.splitlines():
        if line.startswith("未达标项"):
            collecting = True
            continue
        if not collecting:
            continue
        if line.startswith("  - "):
            items.append(line.strip()[2:].strip())
        else:
            break
    return items


class CoveragePathOrderTest(unittest.TestCase):
    """覆盖率产物的默认路径指错了 —— 这里把查找顺序钉死。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.backend_default = self.root / "backend-python" / "coverage.json"
        self.backend_fallback = self.root / ".acceptance" / "backend-coverage.json"
        self.frontend_default = (
            self.root / "Data-driven-modeling" / "coverage" / "coverage-final.json"
        )
        self.frontend_fallback = (
            self.root / ".acceptance" / "frontend-coverage" / "coverage-final.json"
        )
        self.addCleanup(self.tmp.cleanup)

    def _write(self, path: Path, payload):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding="utf-8")

    def test_repo_default_wins_over_artifacts_dir(self):
        self._write(self.backend_default, BACKEND_COVERAGE)
        self._write(self.backend_fallback, {"totals": {"percent_covered": 1.0}})
        path, source = acceptance.resolve_coverage_artifact(
            None, [self.backend_default, self.backend_fallback]
        )
        self.assertEqual(path, self.backend_default)
        self.assertEqual(source, "工具默认路径")

    def test_falls_back_to_artifacts_dir(self):
        self._write(self.backend_fallback, BACKEND_COVERAGE)
        path, source = acceptance.resolve_coverage_artifact(
            None, [self.backend_default, self.backend_fallback]
        )
        self.assertEqual(path, self.backend_fallback)
        self.assertEqual(source, "度量产物目录")

    def test_explicit_path_wins(self):
        explicit = self.root / "somewhere" / "coverage.json"
        self._write(explicit, BACKEND_COVERAGE)
        self._write(self.backend_default, BACKEND_COVERAGE)
        path, source = acceptance.resolve_coverage_artifact(
            explicit, [self.backend_default, self.backend_fallback]
        )
        self.assertEqual(path, explicit)
        self.assertEqual(source, "命令行指定")

    def test_missing_everywhere_returns_primary_candidate(self):
        path, source = acceptance.resolve_coverage_artifact(
            None, [self.backend_default, self.backend_fallback]
        )
        self.assertEqual(path, self.backend_default)
        self.assertIn("未找到", source)


class AcceptanceRunTest(unittest.TestCase):
    """端到端跑一次 main()，看表格判定与未达标清单。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.artifacts = self.root / ".acceptance"
        self.artifacts.mkdir(parents=True, exist_ok=True)
        self.addCleanup(self.tmp.cleanup)

    def _run(self, extra_args=()) -> tuple[str, int]:
        argv = [
            "--repo-root", str(self.root),
            "--artifacts", str(self.artifacts),
            "--skip-http",
            *extra_args,
        ]
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = acceptance.main(argv)
        return buffer.getvalue(), code

    def _install_browser_fixture(self, name: str) -> None:
        target = self.artifacts / "browser-performance.json"
        target.write_text(
            (FIXTURE_DIR / name).read_text(encoding="utf-8"), encoding="utf-8"
        )

    def test_busy_host_flags_frame_rates_as_unreliable(self):
        self._install_browser_fixture("browser-performance-busy-host.json")
        output, code = self._run()
        self.assertEqual(code, 0)
        self.assertIn(acceptance.UNRELIABLE, _row_line(output, "帧率（静止）"))
        self.assertIn(acceptance.UNRELIABLE, _row_line(output, "帧率（相机运动）"))
        # 帧率一条都不许进未达标清单
        for item in _unmet_items(output):
            self.assertNotIn("帧率", item)

    def test_idle_host_keeps_pass_verdict(self):
        self._install_browser_fixture("browser-performance-idle-host.json")
        output, code = self._run()
        self.assertEqual(code, 0)
        self.assertIn(acceptance.PASS, _row_line(output, "帧率（静止）"))
        self.assertIn(acceptance.PASS, _row_line(output, "帧率（相机运动）"))

    def test_idle_host_keeps_fail_verdict(self):
        # 同样的产物，把帧率压到验收线以下：CPU 不忙时必须照旧判未达标。
        payload = json.loads(
            (FIXTURE_DIR / "browser-performance-idle-host.json").read_text(
                encoding="utf-8"
            )
        )
        payload["summary"]["fpsMotion"]["median"] = 12.5
        payload["summary"]["fpsMotion"]["values"] = [12.5, 12.5, 12.5]
        (self.artifacts / "browser-performance.json").write_text(
            json.dumps(payload), encoding="utf-8"
        )
        output, code = self._run()
        self.assertEqual(code, 0)
        self.assertIn(acceptance.FAIL, _row_line(output, "帧率（相机运动）"))
        self.assertTrue(any("帧率" in item for item in _unmet_items(output)))

    def test_missing_artifacts_report_not_provided(self):
        output, code = self._run()
        self.assertEqual(code, 0)
        self.assertIn("未提供", _row_line(output, "后端覆盖率"))
        self.assertIn("未提供", _row_line(output, "前端覆盖率"))
        self.assertIn("未提供", _row_line(output, "帧率（相机运动）"))

    def test_coverage_read_from_tool_default_paths(self):
        backend = self.root / "backend-python" / "coverage.json"
        backend.parent.mkdir(parents=True, exist_ok=True)
        backend.write_text(json.dumps(BACKEND_COVERAGE), encoding="utf-8")
        frontend = self.root / "Data-driven-modeling" / "coverage" / "coverage-final.json"
        frontend.parent.mkdir(parents=True, exist_ok=True)
        frontend.write_text(json.dumps(FRONTEND_COVERAGE), encoding="utf-8")

        output, code = self._run()
        self.assertEqual(code, 0)
        self.assertIn("94.25%", _row_line(output, "后端覆盖率"))
        self.assertIn("50.00%", _row_line(output, "前端覆盖率"))

    def test_coverage_falls_back_to_artifacts_dir(self):
        backend = self.artifacts / "backend-coverage.json"
        backend.write_text(json.dumps(BACKEND_COVERAGE), encoding="utf-8")
        frontend = self.artifacts / "frontend-coverage" / "coverage-final.json"
        frontend.parent.mkdir(parents=True, exist_ok=True)
        frontend.write_text(json.dumps(FRONTEND_COVERAGE), encoding="utf-8")

        output, code = self._run()
        self.assertEqual(code, 0)
        self.assertIn("94.25%", _row_line(output, "后端覆盖率"))
        self.assertIn("50.00%", _row_line(output, "前端覆盖率"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
