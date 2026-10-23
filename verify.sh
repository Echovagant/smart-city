#!/usr/bin/env bash
# 一键验证：运行后端与前端的全部测试套件。
#
#   - 后端：backend-python/.venv 下的解释器执行 -m pytest -q
#   - 前端：npm run test:run（vitest --run，非 watch 模式）
#   - 工具链：python scripts/tests/test_measure_acceptance.py（度量脚本的回归测试）
#
# 三个套件都会执行（一个失败不跳过另一个）；任一失败，脚本以非零码退出，
# 并打印失败的是哪一个。脚本不会启动任何服务，也不会安装任何依赖。
#
# 用法：./verify.sh
#
# **必须用 bash 跑**：下面第 13 行的 `set -o pipefail` 是 bash 扩展，
# dash（Ubuntu 上的 /bin/sh）不认它，会报 "Illegal option -o pipefail"。
# 所以这里先自检：不是 bash 就用 bash 重新执行自己，
# 这样 `sh verify.sh` 这种调用方式也不会炸（CI 里就踩过这个坑）。

if [ -z "${BASH_VERSION:-}" ]; then
    exec bash "$0" "$@"
fi

set -uo pipefail

repo_root="$(cd "$(dirname "$0")" && pwd)"
backend_dir="$repo_root/backend-python"
frontend_dir="$repo_root/Data-driven-modeling"

if [ -x "$backend_dir/.venv/bin/python" ]; then
    python_bin="$backend_dir/.venv/bin/python"
elif [ -x "$backend_dir/.venv/Scripts/python.exe" ]; then
    python_bin="$backend_dir/.venv/Scripts/python.exe"
else
    echo "[FAIL] 找不到后端虚拟环境解释器: $backend_dir/.venv" >&2
    echo "       请先创建它: python -m venv backend-python/.venv" >&2
    exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
    echo '[FAIL] 找不到 npm，无法运行前端测试。' >&2
    exit 1
fi

echo '=== 后端测试 (pytest) ==='
echo "    工作目录: $backend_dir"
backend_exit=0
(cd "$backend_dir" && "$python_bin" -m pytest -q) || backend_exit=$?
if [ "$backend_exit" -ne 0 ]; then
    echo "[FAIL] 后端测试失败 (退出码 $backend_exit)"
else
    echo '[OK]   后端测试通过'
fi

echo ''
echo '=== 前端测试 (vitest --run) ==='
echo "    工作目录: $frontend_dir"
frontend_exit=0
(cd "$frontend_dir" && npm run test:run) || frontend_exit=$?
if [ "$frontend_exit" -ne 0 ]; then
    echo "[FAIL] 前端测试失败 (退出码 $frontend_exit)"
else
    echo '[OK]   前端测试通过'
fi

echo ''
echo '=== 工具链测试 (scripts/tests) ==='
echo "    工作目录: $repo_root"
scripts_exit=0
(cd "$repo_root" && "$python_bin" scripts/tests/test_measure_acceptance.py) || scripts_exit=$?
if [ "$scripts_exit" -ne 0 ]; then
    echo "[FAIL] 工具链测试失败 (退出码 $scripts_exit)"
else
    echo '[OK]   工具链测试通过'
fi

echo ''
if [ "$backend_exit" -ne 0 ] || [ "$frontend_exit" -ne 0 ] || [ "$scripts_exit" -ne 0 ]; then
    failed=''
    [ "$backend_exit" -ne 0 ] && failed="${failed}后端 pytest, "
    [ "$frontend_exit" -ne 0 ] && failed="${failed}前端 vitest, "
    [ "$scripts_exit" -ne 0 ] && failed="${failed}工具链 unittest, "
    echo "验证失败: ${failed%, }" >&2
    exit 1
fi

echo '验证通过: 后端、前端与工具链测试全部成功。'
exit 0
