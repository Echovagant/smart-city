"""防止未使用的重依赖回流到 requirements.txt。

背景：geopandas / pandas 两个包曾被声明为后端依赖，但后端代码
只 import 了 shapely。它们让 venv 多背了约 127 MB（geopandas 会拖入
fiona + pyproj + numpy + pandas），而本机到部分源站的链路慢，这几行是新手
装环境耗时的主要来源。本测试保证「声明了但没人 import」的包不会再回来。

numpy 不算死依赖：shapely 2.0.4 声明 numpy<3,>=1.14，numpy 是它的传递
依赖。所以这里约束的是 numpy 的版本（numpy<2），不是移除它。
"""
import ast
import re
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
REQUIREMENTS = BACKEND_DIR / "requirements.txt"
REQUIREMENTS_DEV = BACKEND_DIR / "requirements-dev.txt"

# 声明了但不会出现在 import 语句里的包 —— 它们是别的包的传递依赖，
# 或由测试框架隐式使用，不是死依赖。
ALLOWED_WITHOUT_DIRECT_IMPORT = {
    "python-dotenv",  # pydantic-settings 会读 .env，它自己不 import dotenv
    "httpx",          # starlette 的 TestClient 在底层用它
    "pytest",         # 测试框架本身
    # pytest-cov 是 pytest 插件，靠命令行 --cov 启用，不会出现在 import 语句里。
    # 它只在开发期用（产出覆盖率报告），不进生产镜像。
    "pytest-cov",
    # shapely 2.0.4 声明 numpy<3,>=1.14 —— numpy 是它的传递依赖，不是死依赖。
    # 这里显式钉住 numpy<2：shapely 2.0.4 与 numpy 2.x 不兼容
    # （TypeError: ufunc 'create_collection' not supported for the input types）。
    "numpy",
}


def _declared_packages(path: Path) -> set[str]:
    names = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # 去掉版本号与 extras / 环境标记
        name = re.split(r"[<>=!~\[; ]", line, maxsplit=1)[0].strip()
        if name:
            names.add(name.lower().replace("_", "-"))
    return names


def _imported_modules() -> set[str]:
    modules = set()
    for py_file in BACKEND_DIR.rglob("*.py"):
        if "__pycache__" in py_file.parts or ".venv" in py_file.parts:
            continue
        tree = ast.parse(py_file.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    modules.add(alias.name.split(".")[0].lower().replace("_", "-"))
            elif isinstance(node, ast.ImportFrom):
                if node.level == 0 and node.module:
                    modules.add(node.module.split(".")[0].lower().replace("_", "-"))
    return modules


def test_no_unused_heavy_dependencies_are_declared():
    """requirements.txt 里的每个包都必须被 import，或在白名单里。"""
    declared = _declared_packages(REQUIREMENTS) | _declared_packages(REQUIREMENTS_DEV)
    imported = _imported_modules()
    unused = declared - imported - ALLOWED_WITHOUT_DIRECT_IMPORT
    assert not unused, (
        f"requirements 里声明了但后端从未 import 的包：{sorted(unused)}。"
        "要么删掉它们，要么在后端真的用上。"
    )


def test_removed_heavy_dependencies_stay_removed():
    """geopandas / pandas 曾是死依赖，任何人加回来都会让 venv 胖 127 MB。

    numpy 不在此列：它是 shapely 2.0.4 的传递依赖，需要被约束在 numpy<2，
    而不是被移除。
    """
    declared = _declared_packages(REQUIREMENTS) | _declared_packages(REQUIREMENTS_DEV)
    for package in ("geopandas", "pandas"):
        assert package not in declared, (
            f"{package} 不该再出现在依赖声明里 —— 后端只 import shapely。"
        )


@pytest.mark.parametrize("package", ["fastapi", "uvicorn", "pydantic", "pydantic-settings", "shapely"])
def test_actually_required_packages_are_still_declared(package):
    """反向保护：真正在用的包不能被误删。"""
    assert package in _declared_packages(REQUIREMENTS), f"{package} 是后端在用的依赖，不该被删"
