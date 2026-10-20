<#
.SYNOPSIS
    一键验证：运行后端与前端的全部测试套件。

.DESCRIPTION
    - 后端：backend-python\.venv\Scripts\python.exe -m pytest -q
    - 前端：npm run test:run（vitest --run，非 watch 模式）

    两个套件都会执行（一个失败不跳过另一个）；任一失败，脚本以非零码退出，
    并打印失败的是哪一个。脚本不会启动任何服务，也不会安装任何依赖。

.EXAMPLE
    .\verify.ps1
#>
$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $repoRoot 'backend-python'
$frontendDir = Join-Path $repoRoot 'Data-driven-modeling'
$pythonExe = Join-Path $backendDir '.venv\Scripts\python.exe'

if (-not (Test-Path $pythonExe)) {
    Write-Host "[FAIL] 找不到后端虚拟环境解释器: $pythonExe" -ForegroundColor Red
    Write-Host "       请先创建它: python -m venv backend-python\.venv" -ForegroundColor Red
    exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host '[FAIL] 找不到 npm，无法运行前端测试。' -ForegroundColor Red
    exit 1
}

Write-Host '=== 后端测试 (pytest) ===' -ForegroundColor Cyan
Write-Host "    工作目录: $backendDir"
Push-Location $backendDir
try {
    & $pythonExe -m pytest -q
    $backendExit = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($null -eq $backendExit) { $backendExit = 0 }
if ($backendExit -ne 0) {
    Write-Host "[FAIL] 后端测试失败 (退出码 $backendExit)" -ForegroundColor Red
} else {
    Write-Host '[OK]   后端测试通过' -ForegroundColor Green
}

Write-Host ''
Write-Host '=== 前端测试 (vitest --run) ===' -ForegroundColor Cyan
Write-Host "    工作目录: $frontendDir"
Push-Location $frontendDir
try {
    & npm run test:run
    $frontendExit = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($null -eq $frontendExit) { $frontendExit = 0 }
if ($frontendExit -ne 0) {
    Write-Host "[FAIL] 前端测试失败 (退出码 $frontendExit)" -ForegroundColor Red
} else {
    Write-Host '[OK]   前端测试通过' -ForegroundColor Green
}

Write-Host ''
if ($backendExit -ne 0 -or $frontendExit -ne 0) {
    $failed = @()
    if ($backendExit -ne 0) { $failed += '后端 pytest' }
    if ($frontendExit -ne 0) { $failed += '前端 vitest' }
    Write-Host "验证失败: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}

Write-Host '验证通过: 后端与前端测试全部成功。' -ForegroundColor Green
exit 0
