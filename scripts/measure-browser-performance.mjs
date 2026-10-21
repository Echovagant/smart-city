#!/usr/bin/env node
/**
 * 浏览器端性能度量：首屏（LCP / loadEventEnd / 应用就绪）与 3D 渲染帧率。
 *
 * 用法
 * ----
 *     node scripts/measure-browser-performance.mjs [选项]
 *
 * 一次跑完会：构建生产产物（缺失时）→ 起后端单端口托管 dist/ →
 * 起一个**独立的 headless Chrome** → 连跑 N 轮（默认 3 轮）→
 * 打印对照计划书验收线的表格 → 把原始数据写成 JSON（供
 * scripts/measure-acceptance.py 并进总表）。
 *
 * 口径（写死，别在报告里含糊）
 * ----------------------------
 *   LCP            Chrome 的 Largest Contentful Paint，最后一次上报的值。
 *                  注意：**WebGL 画布不是 LCP 候选元素**，本应用是整屏
 *                  Cesium 画布，LCP 实际量到的是控制面板/文字块，
 *                  **不代表「3D 城市画出来了」**。所以另外报了 appReady。
 *   appReady       导航开始 → 页面里 `.status-hint`（"正在加载城市数据…"）
 *                  消失的时间。这是应用自己的「数据已到位」信号，
 *                  建筑/道路实体就是在这一刻挂到场景上的，
 *                  下一渲染帧（< 1 帧）城市就画出来了。
 *   loadEventEnd   导航 timing 里的 load 事件时间（含全部子资源）。
 *   fps            页面内 requestAnimationFrame 连续计数，fps = 帧数 / 采样秒数。
 *                  静止 = 相机不动；运动 = 用 CDP 派发真实鼠标拖拽让相机绕城心旋转。
 *
 * 三个坑，这里已经绕开
 * --------------------
 *   1. **不用 dev server 度量**。本脚本量的是 `npm run build` 的生产产物，
 *      由后端进程单端口托管（dist/ 存在时 GET / 就是页面），与部署形态一致。
 *      脚本会断言 GET / 返回的是 HTML 而不是后端 banner JSON——
 *      返回 JSON 说明 dist/ 没被后端找到，量的就不是生产形态。
 *   2. **不连别人开着的 Chrome**。每轮都新起一个独立 `--user-data-dir` +
 *      独立调试端口的 Chrome，只连自己起的那个。
 *   3. **底图来自高德 CDN（外部网络）**。首屏时间含外部网络等待，
 *      本脚本把外部请求**单独拆出来计数与计时**，报告里必须把两者分开讲。
 *
 * 另外：
 *   - 后端子进程的 stdout/stderr **落文件**（fd 直连），不用没人读的 PIPE——
 *     否则 uvicorn 日志填满管道缓冲，服务器会阻塞在写日志上。
 *   - 端口不写死 8000（本机 8000 被别的项目占着），默认 8035。
 *   - 每轮都**重启后端**（服务端有全量响应缓存，重启才能让每轮都是冷启动），
 *     并**禁用浏览器缓存**（Network.setCacheDisabled），
 *     这样三轮测的都是「第一次访问」，彼此可比。
 *
 * 退出码
 * ------
 *   0  测出了数据（哪怕有指标不达标——本脚本是报告，不是门禁）
 *   1  测不出数据（找不到 Chrome / 构建失败 / 后端起不来）
 *
 * 依赖
 * ----
 * 只用 Node 内置能力：内置 WebSocket（Node 22+）直连 CDP，不需要 puppeteer。
 * 需要 Node 22 以上（开发用 Node 24）。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch, cpus, hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------
const DEFAULT_PORT = 8035
const DEFAULT_CDP_PORT = 9340
const DEFAULT_RUNS = 3
const DEFAULT_SAMPLE_SECONDS = 3
const DEFAULT_NAV_TIMEOUT_MS = 90_000
const DEFAULT_APP_READY_TIMEOUT_MS = 90_000
const WINDOW_SIZE = { width: 1280, height: 720 }

/** 计划书《智慧城市3D可视化计划书.docx》的验收线。 */
const TARGET_FIRST_SCREEN_MS = 3000
const TARGET_FPS = 30

const PASS = '达标'
const FAIL = '未达标'
const UNKNOWN = '未提供'

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function displayWidth(text) {
  let width = 0
  for (const char of String(text)) {
    width += isWideCodePoint(char.codePointAt(0)) ? 2 : 1
  }
  return width
}

function isWideCodePoint(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
}

function pad(text, width, align = 'left') {
  const gap = Math.max(0, width - displayWidth(text))
  return align === 'right' ? ' '.repeat(gap) + text : text + ' '.repeat(gap)
}

function renderTable(header, rows) {
  const widths = header.map((cell, index) =>
    Math.max(
      displayWidth(cell),
      ...rows.map((row) => displayWidth(row[index] ?? '')),
      0
    )
  )
  const line = (left, mid, right) =>
    left + widths.map((width) => '-'.repeat(width + 2)).join(mid) + right
  const out = [line('+', '+', '+')]
  out.push('| ' + header.map((cell, i) => pad(cell, widths[i])).join(' | ') + ' |')
  out.push(line('+', '+', '+'))
  for (const row of rows) {
    out.push('| ' + row.map((cell, i) => pad(cell ?? '', widths[i])).join(' | ') + ' |')
  }
  out.push(line('+', '+', '+'))
  return out.join('\n')
}

function formatMs(value) {
  return value === null || value === undefined ? UNKNOWN : `${value.toFixed(0)} ms`
}

function formatMb(bytes) {
  if (bytes === null || bytes === undefined) return UNKNOWN
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return UNKNOWN
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function median(values) {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function summarize(values) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (!clean.length) return { values: [], median: null, min: null, max: null, spread: null }
  const sorted = [...clean].sort((a, b) => a - b)
  return {
    values: clean,
    median: median(clean),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    spread: sorted[sorted.length - 1] - sorted[0],
  }
}

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const options = {
    repoRoot,
    port: DEFAULT_PORT,
    cdpPort: DEFAULT_CDP_PORT,
    runs: DEFAULT_RUNS,
    sampleSeconds: DEFAULT_SAMPLE_SECONDS,
    navigateTimeoutMs: DEFAULT_NAV_TIMEOUT_MS,
    appReadyTimeoutMs: DEFAULT_APP_READY_TIMEOUT_MS,
    headful: false,
    build: 'auto',
    cache: 'disabled',
    chrome: null,
    out: null,
    artifacts: null,
    keepProfile: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${arg} 缺少参数`)
      return argv[index]
    }
    switch (arg) {
      case '--repo-root': options.repoRoot = path.resolve(next()); break
      case '--port': options.port = Number(next()); break
      case '--cdp-port': options.cdpPort = Number(next()); break
      case '--runs': options.runs = Number(next()); break
      case '--sample-seconds': options.sampleSeconds = Number(next()); break
      case '--navigate-timeout-ms': options.navigateTimeoutMs = Number(next()); break
      case '--app-ready-timeout-ms': options.appReadyTimeoutMs = Number(next()); break
      case '--chrome': options.chrome = next(); break
      case '--out': options.out = path.resolve(next()); break
      case '--artifacts': options.artifacts = path.resolve(next()); break
      case '--headful': options.headful = true; break
      case '--keep-profile': options.keepProfile = true; break
      case '--build': options.build = 'always'; break
      case '--no-build': options.build = 'never'; break
      case '--cache': options.cache = next(); break
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
        break
      default:
        throw new Error(`未知参数：${arg}`)
    }
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error('--runs 必须是正整数')
  if (!Number.isInteger(options.port) || options.port < 1) throw new Error('--port 必须是正整数')
  if (!Number.isInteger(options.cdpPort) || options.cdpPort < 1) throw new Error('--cdp-port 必须是正整数')
  if (options.cache !== 'disabled' && options.cache !== 'enabled') {
    throw new Error('--cache 只能是 disabled 或 enabled')
  }
  options.artifacts = options.artifacts || path.join(options.repoRoot, '.acceptance')
  options.out = options.out || path.join(options.artifacts, 'browser-performance.json')
  return options
}

function printUsage() {
  process.stdout.write(`
浏览器端性能度量（首屏 + 帧率）

用法
  node scripts/measure-browser-performance.mjs [选项]

选项
  --repo-root <dir>          仓库根（默认按脚本位置推断）
  --port <n>                 后端端口（默认 ${DEFAULT_PORT}；本机 8000 被别的项目占着）
  --cdp-port <n>             Chrome 调试端口基准（默认 ${DEFAULT_CDP_PORT}；每轮 +1 递增）
  --runs <n>                 复跑轮数（默认 ${DEFAULT_RUNS}）
  --sample-seconds <n>       帧率采样秒数（默认 ${DEFAULT_SAMPLE_SECONDS}）
  --chrome <path>            指定 Chrome/Edge 可执行文件
  --headful                  起有界面的 Chrome（默认 headless=new）
  --build / --no-build       强制重建 / 禁止构建（默认：产物缺失才建）
  --cache <disabled|enabled> 是否禁用浏览器缓存（默认 disabled，每轮都测「第一次访问」）
  --out <path>               JSON 产物路径（默认 <仓库根>/.acceptance/browser-performance.json）
  --keep-profile             保留 Chrome 的临时 profile（排障用）
`.trim() + '\n')
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

function findChrome(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`指定的 Chrome 不存在：${explicit}`)
    return explicit
  }
  const localAppData = process.env.LOCALAPPDATA
  const candidates = [...CHROME_CANDIDATES]
  if (localAppData) {
    candidates.push(path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    candidates.push(path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

async function launchChrome({ binary, cdpPort, userDataDir, headful, logPath }) {
  const isLinux = process.platform === 'linux'
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    `--window-size=${WINDOW_SIZE.width},${WINDOW_SIZE.height}`,
    // headless 下没有 GPU，靠 SwiftShader 跑 WebGL；Chrome 128+ 需要显式放开。
    '--enable-unsafe-swiftshader',
  ]
  if (isLinux) {
    // 容器里 /dev/shm 通常只有 64MB，Chrome 写不下会崩。
    args.push('--disable-dev-shm-usage')
    // CI runner 有时以 root 跑，root 下 Chrome 的沙箱起不来。
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      args.push('--no-sandbox')
    }
  }
  if (!headful) args.unshift('--headless=new')
  args.push('about:blank')

  // Chrome 自己的输出落盘：崩了要能从日志里看出原因（丢弃就什么都查不到）。
  mkdirSync(path.dirname(logPath), { recursive: true })
  const logFd = openSync(logPath, 'w')
  const child = spawn(binary, args, {
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  })
  child.on('error', (error) => {
    process.stderr.write(`Chrome 启动失败：${error.message}\n`)
  })

  // 宿主机被抢占时，Chrome 起来得很慢——给足 60 秒，别让「机器忙」变成「测不出来」。
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
        signal: AbortSignal.timeout(5000),
      })
      if (response.ok) return { child, version: await response.json() }
    } catch {
      // 还没起来，继续等
    }
    if (child.exitCode !== null) {
      throw new Error(`Chrome 进程已退出（退出码 ${child.exitCode}）`)
    }
    await sleep(300)
  }
  child.kill()
  throw new Error(`Chrome 在 60 秒内没有开放调试端口 ${cdpPort}`)
}

/** 杀 Chrome 进程树。**必须等它真的死了**——否则下一轮会在上一轮还占着
 *  内存（SwiftShader 软渲染很吃内存）的情况下启动，Chrome 会莫名其妙崩掉。 */
async function stopChrome(child) {
  if (!child || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
        killer.on('close', resolve)
        killer.on('error', resolve)
      })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    // 进程可能已经自己退了
  }
}

// ---------------------------------------------------------------------------
// CDP 客户端（Node 内置 WebSocket 直连，不引入任何依赖）
// ---------------------------------------------------------------------------
class CdpClient {
  constructor(url) {
    this.url = url
    this.nextId = 0
    this.pending = new Map()
    this.handlers = new Map()
    this.socket = null
  }

  async connect() {
    this.socket = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const onError = (event) => reject(new Error(`WebSocket 连接失败：${event?.message || '未知错误'}`))
      this.socket.addEventListener('open', resolve, { once: true })
      this.socket.addEventListener('error', onError, { once: true })
    })
    this.socket.addEventListener('message', (event) => this._handleMessage(event.data))
    this.socket.addEventListener('close', () => {
      for (const entry of this.pending.values()) {
        entry.reject(new Error('CDP 连接已关闭'))
      }
      this.pending.clear()
    })
  }

  _handleMessage(raw) {
    let message
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) {
        entry.reject(new Error(`${entry.method} 失败：${message.error.message || JSON.stringify(message.error)}`))
      } else {
        entry.resolve(message.result || {})
      }
      return
    }
    const scoped = message.sessionId ? `${message.sessionId}:${message.method}` : message.method
    for (const handler of this.handlers.get(scoped) || []) handler(message.params || {}, message.sessionId)
    if (scoped !== message.method) {
      for (const handler of this.handlers.get(message.method) || []) handler(message.params || {}, message.sessionId)
    }
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.socket.send(JSON.stringify(payload))
    })
  }

  on(method, handler, sessionId) {
    const key = sessionId ? `${sessionId}:${method}` : method
    if (!this.handlers.has(key)) this.handlers.set(key, [])
    this.handlers.get(key).push(handler)
    return () => {
      const list = this.handlers.get(key) || []
      const index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
    }
  }

  once(method, sessionId, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`等待 ${method} 超时（${timeoutMs} ms）`))
      }, timeoutMs)
      const off = this.on(method, (params) => {
        clearTimeout(timer)
        off()
        resolve(params)
      }, sessionId)
    })
  }

  close() {
    try {
      this.socket?.close()
    } catch {
      // 忽略
    }
  }
}

// ---------------------------------------------------------------------------
// 后端进程
// ---------------------------------------------------------------------------
function findPython(repoRoot) {
  const venv = path.join(repoRoot, 'backend-python', '.venv')
  for (const relative of [['Scripts', 'python.exe'], ['bin', 'python']]) {
    const candidate = path.join(venv, ...relative)
    if (existsSync(candidate)) return candidate
  }
  return process.env.PYTHON || 'python'
}

async function startBackend({ repoRoot, port, logPath }) {
  const backendDir = path.join(repoRoot, 'backend-python')
  const python = findPython(repoRoot)
  mkdirSync(path.dirname(logPath), { recursive: true })
  // 关键：stdout/stderr 直连文件 fd。没人读的 PIPE 会让 uvicorn 卡在写日志上。
  const logFd = openSync(logPath, 'w')
  const child = spawn(python, ['main.py'], {
    cwd: backendDir,
    env: { ...process.env, PORT: String(port), PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  })
  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`后端进程启动即退出（退出码 ${child.exitCode}），日志见 ${logPath}`)
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) {
        // 确认根路径吐的是**构建产物**而不是后端 banner JSON。
        // 吐 JSON 说明 dist/ 没被找到，量的就不是生产形态。
        const root = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(5000) })
        const contentType = root.headers.get('content-type') || ''
        const body = await root.text()
        const servedHtml = contentType.includes('text/html')
        return {
          child,
          baseUrl,
          logPath,
          python,
          rootContentType: contentType,
          rootBytes: body.length,
          servedHtml,
        }
      }
    } catch {
      // 还没起来，继续等
    }
    await sleep(200)
  }
  await stopBackend(child)
  throw new Error(`后端在 40 秒内没有就绪，日志见 ${logPath}`)
}

async function stopBackend(child) {
  if (!child || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
        killer.on('close', resolve)
        killer.on('error', resolve)
      })
    } else {
      child.kill('SIGTERM')
    }
  } catch {
    // 忽略
  }
}

// ---------------------------------------------------------------------------
// 生产构建
// ---------------------------------------------------------------------------
function distIndex(repoRoot) {
  return path.join(repoRoot, 'Data-driven-modeling', 'dist', 'index.html')
}

async function ensureProductionBuild(options) {
  const indexPath = distIndex(options.repoRoot)
  const has = existsSync(indexPath)
  if (options.build === 'never') {
    if (!has) throw new Error(`--no-build 但找不到生产产物：${indexPath}（先跑 npm run build）`)
    return { built: false, indexPath }
  }
  if (options.build === 'auto' && has) return { built: false, indexPath }

  const frontendDir = path.join(options.repoRoot, 'Data-driven-modeling')
  const logPath = path.join(options.artifacts, 'server-logs', 'build.log')
  mkdirSync(path.dirname(logPath), { recursive: true })
  const logFd = openSync(logPath, 'w')
  process.stdout.write(`构建生产产物：npm run build（${frontendDir}）\n`)
  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
      cwd: frontendDir,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    })
    child.on('error', () => resolve(1))
    child.on('close', (code) => resolve(code ?? 1))
  })
  if (exitCode !== 0 || !existsSync(indexPath)) {
    throw new Error(`npm run build 失败（退出码 ${exitCode}），日志见 ${logPath}`)
  }
  return { built: true, indexPath }
}

// ---------------------------------------------------------------------------
// 页面内注入脚本（在任何页面脚本之前跑）
// ---------------------------------------------------------------------------
const PAGE_SCRIPT = `
(() => {
  const perf = {
    lcp: [],
    frameTimes: [],
    fpsOn: false,
    fpsLast: null,
  };
  window.__perf = perf;
  // 资源计时缓冲区默认只留 250 条。本应用首屏会打 200+ 个 Cesium 运行时文件
  // （其中一大半是 Web Worker 自己的脚本），缓冲区一满，最早的记录（含高德瓦片）
  // 会被挤掉——外部瓦片的传输量就会变成 0。这里把上限调大。
  try {
    performance.setResourceTimingBufferSize(3000);
  } catch (e) {
    perf.bufferError = String(e);
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        perf.lcp.push({
          startTime: entry.startTime,
          size: entry.size,
          tag: entry.element ? entry.element.tagName : null,
          url: entry.url || null,
        });
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {
    perf.lcpError = String(e);
  }
  const tick = (t) => {
    if (perf.fpsOn) perf.frameTimes.push(t);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  perf.fpsStart = () => {
    perf.frameTimes = [];
    perf.fpsOn = true;
  };
  perf.fpsStop = () => {
    perf.fpsOn = false;
    const times = perf.frameTimes;
    const elapsed = times.length > 1 ? times[times.length - 1] - times[0] : 0;
    const intervals = [];
    for (let i = 1; i < times.length; i += 1) intervals.push(times[i] - times[i - 1]);
    intervals.sort((a, b) => a - b);
    const pick = (fraction) =>
      intervals.length
        ? intervals[Math.min(intervals.length - 1, Math.max(0, Math.ceil(fraction * intervals.length) - 1))]
        : null;
    perf.fpsLast = {
      frames: times.length,
      elapsedMs: elapsed,
      fps: elapsed > 0 ? (times.length - 1) / (elapsed / 1000) : null,
      frameIntervalP50Ms: pick(0.5),
      frameIntervalP95Ms: pick(0.95),
      frameIntervalMaxMs: intervals.length ? intervals[intervals.length - 1] : null,
    };
    return perf.fpsLast;
  };
})();
`

// ---------------------------------------------------------------------------
// 一轮测量
// ---------------------------------------------------------------------------
async function measureRun(options, runIndex) {
  const port = options.port + runIndex
  const cdpPort = options.cdpPort + runIndex
  const logPath = path.join(options.artifacts, 'server-logs', `backend-${port}.log`)
  const profileDir = path.join(tmpdir(), `smart-city-e5-chrome-${process.pid}-${runIndex}`)
  const cpuStart = cpuSnapshot()

  // 整段（含后端与 Chrome 的启动）必须包在 try 里：
  // 否则「启动到一半就失败」会把进程漏在外面（重试时端口冲突 + 进程堆积）。
  let backend = null
  let chrome = null
  let cdp = null
  const network = { requests: new Map(), order: [], failed: [] }

  try {
    backend = await startBackend({ repoRoot: options.repoRoot, port, logPath })
    if (!backend.servedHtml) {
      throw new Error(
        `GET / 返回的是 ${backend.rootContentType || '未知类型'} 而不是 HTML——` +
        `后端没找到 dist/，量的就不是生产形态。日志见 ${logPath}`
      )
    }

    chrome = await launchChrome({
      binary: options.chromeBinary,
      cdpPort,
      userDataDir: profileDir,
      headful: options.headful,
      logPath: path.join(options.artifacts, 'server-logs', `chrome-${cdpPort}.log`),
    })

    cdp = new CdpClient(chrome.version.webSocketDebuggerUrl)

    await cdp.connect()
    // 用**已经存在**的那个 page target（启动参数里的 about:blank），
    // 而不是新建第二个标签：后台标签会被 Chrome 节流（资源加载被推迟、
    // load 事件迟迟不来），新建的标签有时是活动标签、有时不是——
    // 这会让「首屏」变成不可复跑的随机数。
    const { targetInfos } = await cdp.send('Target.getTargets')
    const existing = (targetInfos || []).find((info) => info.type === 'page')
    let targetId = existing?.targetId
    if (!targetId) {
      const created = await cdp.send('Target.createTarget', { url: 'about:blank' })
      targetId = created.targetId
    }
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })

    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: options.cache === 'disabled' }, sessionId)
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SCRIPT }, sessionId)
    // 明确把页面按「活动 + 有焦点」对待，避开后台节流。
    await cdp.send('Target.activateTarget', { targetId }).catch(() => {})
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {})
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {})

    cdp.on('Network.requestWillBeSent', (params) => {
      network.requests.set(params.requestId, {
        url: params.request.url,
        method: params.request.method,
        startTimestamp: params.timestamp,
        startTimeMs: params.wallTime ? params.wallTime * 1000 : null,
        type: params.type,
        status: null,
        mimeType: null,
        encodedDataLength: 0,
        durationMs: null,
        failed: false,
      })
      network.order.push(params.requestId)
    }, sessionId)

    cdp.on('Network.responseReceived', (params) => {
      const entry = network.requests.get(params.requestId)
      if (!entry) return
      entry.status = params.response.status
      entry.mimeType = params.response.mimeType
      entry.fromCache = params.response.fromDiskCache || params.response.fromPrefetchCache || false
      entry.durationMs = (params.timestamp - entry.startTimestamp) * 1000
    }, sessionId)

    cdp.on('Network.loadingFinished', (params) => {
      const entry = network.requests.get(params.requestId)
      if (!entry) return
      entry.encodedDataLength = params.encodedDataLength
    }, sessionId)

    cdp.on('Network.loadingFailed', (params) => {
      const entry = network.requests.get(params.requestId)
      if (entry) {
        entry.failed = true
        entry.failedReason = params.errorText
        entry.durationMs = (params.timestamp - entry.startTimestamp) * 1000
      }
      network.failed.push({ requestId: params.requestId, errorText: params.errorText })
    }, sessionId)

    // --- 预热：先访问同源的 /health（几十字节）-----------------------------
    // **为什么要预热**：全新 Chrome 实例的「第一个导航」要等好几秒才拿到首字节
    // （网络栈/renderer 冷启动，实测 1.3–8.8 s，宿主越忙越久），
    // 而同一个实例里的后续导航只要几毫秒。这个冷启动延迟**不是产品的加载成本**，
    // 但它会被算进首屏时间，让数字变成「浏览器冷启动 + 页面加载」的混合体，
    // 而且冷启动那部分在共享机器上波动极大。
    // 所以：先拿一次 /health 导航把浏览器拉起来（它的首字节延迟单独记为
    // 「冷启动」），**再**测应用页面的导航 —— 浏览器缓存全程禁用，
    // 应用资源仍然是「第一次下载」，量到的就是产品自身的加载成本。
    const warmLoad = cdp
      .once('Page.loadEventFired', sessionId, 30_000)
      .then(() => true)
      .catch(() => false)
    await cdp.send('Page.navigate', { url: `${backend.baseUrl}/health` }, sessionId)
    await warmLoad
    const warmNavRaw = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const n = performance.getEntriesByType('navigation')[0];
        return n ? JSON.stringify({ rs: n.responseStart, re: n.responseEnd }) : null;
      })()`
    )
    const coldStart = warmNavRaw ? JSON.parse(warmNavRaw) : null
    // 预热请求不计入传输量统计。
    network.requests.clear()
    network.order.length = 0
    network.failed.length = 0

    // load 事件与「应用就绪」并行等：load 是**报告项**不是前置条件，
    // 万一它迟到也不该让整轮测量作废。
    const loadFired = cdp
      .once('Page.loadEventFired', sessionId, options.navigateTimeoutMs)
      .then(() => true)
      .catch(() => false)
    await cdp.send('Page.navigate', { url: backend.baseUrl + '/' }, sessionId)

    // --- 应用就绪：加载横幅出现后再消失 -------------------------------------
    const appReady = await waitForAppReady(cdp, sessionId, options.appReadyTimeoutMs, network)
    const loadOk = await loadFired

    // --- 静止帧率 -----------------------------------------------------------
    await evaluate(cdp, sessionId, 'window.__perf.fpsStart()')
    await sleep(options.sampleSeconds * 1000)
    const staticSample = await evaluate(cdp, sessionId, 'window.__perf.fpsStop()')

    // 运动前的画面留证：拖拽前后两帧不同，才说明「相机真的动了、画面重绘了」。
    const shotBefore = await captureScreenshot(
      cdp,
      sessionId,
      path.join(options.artifacts, 'screenshots', `run-${runIndex + 1}-before-motion.png`)
    )

    // --- 运动帧率（CDP 派发真实鼠标拖拽 → 相机绕城心旋转）-----------------
    const viewport = await evaluate(cdp, sessionId, '({ w: window.innerWidth, h: window.innerHeight })')
    await evaluate(cdp, sessionId, 'window.__perf.fpsStart()')
    const tilesBefore = countTileRequests(network)
    await dragCamera(cdp, sessionId, viewport, options.sampleSeconds * 1000)
    const motionSample = await evaluate(cdp, sessionId, 'window.__perf.fpsStop()')
    const tilesAfter = countTileRequests(network)

    const shotAfter = await captureScreenshot(
      cdp,
      sessionId,
      path.join(options.artifacts, 'screenshots', `run-${runIndex + 1}-after-motion.png`)
    )

    // --- 收数 --------------------------------------------------------------
    const pageData = JSON.parse(
      await evaluate(cdp, sessionId, `JSON.stringify({
        nav: (() => {
          const n = performance.getEntriesByType('navigation')[0];
          if (!n) return null;
          return {
            domContentLoadedEventEnd: n.domContentLoadedEventEnd,
            loadEventEnd: n.loadEventEnd,
            domInteractive: n.domInteractive,
            responseStart: n.responseStart,
            responseEnd: n.responseEnd,
            transferSize: n.transferSize,
            encodedBodySize: n.encodedBodySize,
            decodedBodySize: n.decodedBodySize,
            type: n.type,
          };
        })(),
        paint: performance.getEntriesByType('paint').map((p) => ({ name: p.name, startTime: p.startTime })),
        lcp: window.__perf.lcp,
        resources: performance.getEntriesByType('resource').map((r) => ({
          name: r.name,
          startTime: r.startTime,
          responseEnd: r.responseEnd,
          transferSize: r.transferSize,
          encodedBodySize: r.encodedBodySize,
          decodedBodySize: r.decodedBodySize,
          initiatorType: r.initiatorType,
        })),
      })`)
    )

    await cdp.send('Target.closeTarget', { targetId })

    return {
      run: runIndex + 1,
      port,
      cdpPort,
      chromeVersion: chrome.version?.Browser || null,
      lcpMs: lastLcp(pageData.lcp),
      lcpEntries: pageData.lcp,
      lcpElement: lastLcpTag(pageData.lcp),
      firstPaintMs: paintTime(pageData.paint, 'first-paint'),
      firstContentfulPaintMs: paintTime(pageData.paint, 'first-contentful-paint'),
      loadEventEndMs: pageData.nav ? pageData.nav.loadEventEnd : null,
      loadEventFired: loadOk,
      navResponseStartMs: pageData.nav ? pageData.nav.responseStart : null,
      navResponseEndMs: pageData.nav ? pageData.nav.responseEnd : null,
      domInteractiveMs: pageData.nav ? pageData.nav.domInteractive : null,
      coldStartFirstByteMs: coldStart ? coldStart.rs : null,
      coldStartWallMs: coldStart ? coldStart.re : null,
      domContentLoadedEventEndMs: pageData.nav ? pageData.nav.domContentLoadedEventEnd : null,
      appReadyMs: appReady.appReadyMs,
      appReadyDetail: appReady,
      fpsStatic: staticSample ? staticSample.fps : null,
      fpsStaticFrames: staticSample ? staticSample.frames : null,
      fpsStaticElapsedMs: staticSample ? staticSample.elapsedMs : null,
      fpsStaticFrameIntervalP50Ms: staticSample ? staticSample.frameIntervalP50Ms : null,
      fpsStaticFrameIntervalP95Ms: staticSample ? staticSample.frameIntervalP95Ms : null,
      fpsStaticFrameIntervalMaxMs: staticSample ? staticSample.frameIntervalMaxMs : null,
      fpsMotion: motionSample ? motionSample.fps : null,
      fpsMotionFrames: motionSample ? motionSample.frames : null,
      fpsMotionElapsedMs: motionSample ? motionSample.elapsedMs : null,
      fpsMotionFrameIntervalP50Ms: motionSample ? motionSample.frameIntervalP50Ms : null,
      fpsMotionFrameIntervalP95Ms: motionSample ? motionSample.frameIntervalP95Ms : null,
      fpsMotionFrameIntervalMaxMs: motionSample ? motionSample.frameIntervalMaxMs : null,
      sampleSeconds: options.sampleSeconds,
      systemCpuBusyPercent: cpuBusyBetween(cpuStart, cpuSnapshot()),
      motionTilesRequested: tilesAfter - tilesBefore,
      motionWitness: {
        beforeBytes: shotBefore.buffer.length,
        afterBytes: shotAfter.buffer.length,
        frameChanged: !shotBefore.buffer.equals(shotAfter.buffer),
        beforePath: shotBefore.path,
        afterPath: shotAfter.path,
      },
      transfer: categorize(pageData.resources, network),
      networkSummary: networkSummary(network),
      resources: pageData.resources,
    }
  } finally {
    cdp?.close()
    // 顺序要紧：先等 Chrome 真的死，再删它的 profile 目录。
    if (chrome) await stopChrome(chrome.child)
    if (backend) await stopBackend(backend.child)
    if (!options.keepProfile) {
      try {
        rmSync(profileDir, { recursive: true, force: true })
      } catch {
        // 临时目录清不掉不影响测量结果
      }
    }
  }
}

async function evaluate(cdp, sessionId, expression) {
  let lastError = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: false },
        sessionId
      )
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || '页面内求值抛错')
      }
      return result.result?.value
    } catch (error) {
      lastError = error
      // 导航刚完成时执行上下文可能还没建好/已被销毁，稍等再试。
      await sleep(150)
    }
  }
  throw lastError
}

async function waitForAppReady(cdp, sessionId, timeoutMs, network) {
  const deadline = Date.now() + timeoutMs
  let sawLoading = false
  let firstSeenAt = null
  while (Date.now() < deadline) {
    const state = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const hint = document.querySelector('.status-hint');
        return {
          loading: !!hint,
          canvas: !!document.querySelector('.cesium-container canvas'),
          now: performance.now(),
        };
      })()`
    )
    if (state && state.loading) {
      if (!sawLoading) {
        sawLoading = true
        firstSeenAt = state.now
      }
    } else if (state && state.canvas) {
      // 横幅消失 = 数据到位。但如果横幅压根没被轮询到（数据回得太快），
      // 用「已经有一个 /api/* 响应回来了」当兜底判据。
      const apiAnswered = network ? apiResponseCount(network) > 0 : false
      if (sawLoading || apiAnswered) {
        return {
          appReadyMs: state.now,
          loadingBannerSeenMs: firstSeenAt,
          canvasPresent: state.canvas,
          method: sawLoading
            ? '加载横幅「正在加载城市数据…」出现后消失的时刻'
            : '未观测到加载横幅，以首个 /api/* 响应到达为准',
        }
      }
    }
    await sleep(50)
  }
  return {
    appReadyMs: null,
    loadingBannerSeenMs: firstSeenAt,
    canvasPresent: null,
    method: '超时未观测到应用就绪',
    timedOut: true,
  }
}

function apiResponseCount(network) {
  let count = 0
  for (const [, entry] of network.requests) {
    if (entry.url.includes('/api/') && entry.status !== null) count += 1
  }
  return count
}

/** 整机 CPU 占用采样：这台是共享开发机，得把「机器当时多忙」记进原始数据。 */
function cpuSnapshot() {
  return cpus().map((cpu) => ({ ...cpu.times }))
}

function cpuBusyBetween(start, end) {
  let idle = 0
  let total = 0
  for (let index = 0; index < start.length; index += 1) {
    for (const key of Object.keys(start[index])) {
      const delta = end[index][key] - start[index][key]
      if (delta <= 0) continue
      total += delta
      if (key === 'idle') idle += delta
    }
  }
  if (total <= 0) return null
  return (1 - idle / total) * 100
}

async function dragCamera(cdp, sessionId, viewport, durationMs) {
  const centerX = Math.round((viewport?.w || WINDOW_SIZE.width) / 2)
  const centerY = Math.round((viewport?.h || WINDOW_SIZE.height) / 2)
  const radius = 160
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: centerX, y: centerY, button: 'left', buttons: 1, clickCount: 1 },
    sessionId
  )
  const deadline = Date.now() + durationMs
  let angle = 0
  while (Date.now() < deadline) {
    angle += 0.22
    const x = centerX + Math.round(Math.cos(angle) * radius)
    const y = centerY + Math.round(Math.sin(angle) * radius * 0.35)
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x, y, button: 'left', buttons: 1 },
      sessionId
    )
    await sleep(50)
  }
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: centerX, y: centerY, button: 'left', buttons: 0, clickCount: 1 },
    sessionId
  )
}

async function captureScreenshot(cdp, sessionId, outPath) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  const buffer = Buffer.from(data, 'base64')
  mkdirSync(path.dirname(outPath), { recursive: true })
  writeFileSync(outPath, buffer)
  return { buffer, path: outPath }
}

function lastLcp(entries) {
  if (!Array.isArray(entries) || !entries.length) return null
  return entries[entries.length - 1].startTime
}

function lastLcpTag(entries) {
  if (!Array.isArray(entries) || !entries.length) return null
  return entries[entries.length - 1].tag
}

function paintTime(paintEntries, name) {
  if (!Array.isArray(paintEntries)) return null
  const hit = paintEntries.find((entry) => entry.name === name)
  return hit ? hit.startTime : null
}

function isGaodeTile(url) {
  return /(^|\.)is\.autonavi\.com/i.test(url) || /autonavi\.com/i.test(url)
}

/** 把请求按「应用产物 / Cesium 运行时 / 后端 API / 外部（高德瓦片）」分四类。 */
function categorize(resources, network) {
  const buckets = {
    app: newBucket(),
    cesium: newBucket(),
    api: newBucket(),
    external: newBucket(),
  }
  const origin = `http://127.0.0.1`
  for (const resource of resources) {
    const url = resource.name
    let key = 'external'
    if (url.startsWith(origin)) {
      if (url.includes('/Cesium/')) key = 'cesium'
      else if (url.includes('/api/')) key = 'api'
      else key = 'app'
    }
    const bucket = buckets[key]
    bucket.count += 1
    bucket.transferBytes += resource.transferSize || 0
    bucket.encodedBytes += resource.encodedBodySize || 0
    bucket.decodedBytes += resource.decodedBodySize || 0
    bucket.totalResponseMs += (resource.responseEnd || 0) - (resource.startTime || 0)
  }
  // 瓦片的「等待时间」用 Network 事件算（含 DNS/连接/首字节），资源计时算不到。
  let tileCount = 0
  let tileDurationMs = 0
  let tileBytes = 0
  let allDurationMs = 0
  for (const [, entry] of network.requests) {
    if (typeof entry.durationMs === 'number') allDurationMs += entry.durationMs
    if (!isGaodeTile(entry.url)) continue
    tileCount += 1
    tileDurationMs += entry.durationMs || 0
    tileBytes += entry.encodedDataLength || 0
  }
  buckets.external.tileCount = tileCount
  buckets.external.tileDurationMs = tileDurationMs
  buckets.external.tileBytes = tileBytes
  buckets.external.allRequestDurationMs = allDurationMs
  buckets.external.tileTimeShare = allDurationMs > 0 ? tileDurationMs / allDurationMs : null
  // 跨域资源没有 Timing-Allow-Origin，资源计时里拿不到字节数；
  // 瓦片的线上字节数以 Network 域的 encodedDataLength 为准。
  buckets.external.transferBytes = tileBytes
  buckets.external.encodedBytes = tileBytes
  return {
    app: finishBucket(buckets.app),
    cesium: finishBucket(buckets.cesium),
    api: finishBucket(buckets.api),
    external: finishBucket(buckets.external),
  }
}

function newBucket() {
  return { count: 0, transferBytes: 0, encodedBytes: 0, decodedBytes: 0, totalResponseMs: 0 }
}

function finishBucket(bucket) {
  return {
    count: bucket.count,
    transferBytes: bucket.transferBytes,
    encodedBytes: bucket.encodedBytes,
    decodedBytes: bucket.decodedBytes,
    totalResponseMs: Math.round(bucket.totalResponseMs),
    ...(bucket.tileCount !== undefined
      ? {
          tileCount: bucket.tileCount,
          tileDurationMs: Math.round(bucket.tileDurationMs),
          tileBytes: bucket.tileBytes,
          allRequestDurationMs: Math.round(bucket.allRequestDurationMs),
          tileTimeShare: bucket.tileTimeShare,
        }
      : {}),
  }
}

function networkSummary(network) {
  let total = 0
  let failed = 0
  for (const [, entry] of network.requests) {
    total += 1
    if (entry.failed) failed += 1
  }
  return { totalRequests: total, failedRequests: failed }
}

function countTileRequests(network) {
  let count = 0
  for (const [, entry] of network.requests) {
    if (isGaodeTile(entry.url)) count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const options = parseArgs(process.argv.slice(2))
  mkdirSync(options.artifacts, { recursive: true })

  const chromeBinary = findChrome(options.chrome)
  if (!chromeBinary) {
    throw new Error(
      '本机找不到 Chrome/Edge 可执行文件，无法做浏览器端度量。' +
      '请安装 Chrome 后重跑，或用 --chrome <path> 指定路径。'
    )
  }
  options.chromeBinary = chromeBinary

  const build = await ensureProductionBuild(options)
  process.stdout.write(
    `生产产物：${build.indexPath}${build.built ? '（本轮新建）' : '（已存在，未重建）'}\n`
  )
  process.stdout.write(`Chrome   ：${chromeBinary}（${options.headful ? 'headful' : 'headless=new'}）\n`)
  process.stdout.write(`轮次     ：${options.runs} 轮，每轮重启后端 + 新起 Chrome\n\n`)

  const runs = []
  const failures = []
  for (let index = 0; index < options.runs; index += 1) {
    process.stdout.write(`第 ${index + 1}/${options.runs} 轮：启动中…\n`)
    // 共享机器上 Chrome 偶尔会中途崩掉（内存/CPU 争用）。重试一次，
    // 免得整轮测量因为一次偶发崩溃就白跑。
    let result = null
    let lastError = null
    for (let attempt = 1; attempt <= 2 && !result; attempt += 1) {
      try {
        result = await measureRun(options, index)
      } catch (error) {
        lastError = error
        if (attempt < 2) {
          process.stdout.write(`  第 ${index + 1} 轮第 ${attempt} 次尝试失败（${error.message}），重试…\n`)
          await sleep(2000)
        }
      }
    }
    if (result) {
      runs.push(result)
      process.stdout.write(
        `第 ${index + 1}/${options.runs} 轮完成：冷启动 ${formatMs(result.coldStartFirstByteMs)}、` +
          `LCP ${formatMs(result.lcpMs)}、load ${formatMs(result.loadEventEndMs)}、` +
          `应用就绪 ${formatMs(result.appReadyMs)}、` +
          `静止 ${result.fpsStatic ? result.fpsStatic.toFixed(1) : UNKNOWN} fps、` +
          `运动 ${result.fpsMotion ? result.fpsMotion.toFixed(1) : UNKNOWN} fps\n`
      )
    } else {
      failures.push({ run: index + 1, error: lastError ? lastError.message : '未知错误' })
      process.stdout.write(`第 ${index + 1}/${options.runs} 轮失败：${lastError?.message}\n`)
    }
  }
  if (!runs.length) {
    throw new Error(
      `${options.runs} 轮全部失败：` +
        failures.map((item) => `第 ${item.run} 轮 ${item.error}`).join('；')
    )
  }

  const summary = {
    lcpMs: summarize(runs.map((run) => run.lcpMs)),
    loadEventEndMs: summarize(runs.map((run) => run.loadEventEndMs)),
    appReadyMs: summarize(runs.map((run) => run.appReadyMs)),
    fpsStatic: summarize(runs.map((run) => run.fpsStatic)),
    fpsMotion: summarize(runs.map((run) => run.fpsMotion)),
    transferBytes: summarize(runs.map((run) => run.transfer.app.transferBytes + run.transfer.cesium.transferBytes + run.transfer.api.transferBytes)),
    decodedBytes: summarize(runs.map((run) => run.transfer.app.decodedBytes + run.transfer.cesium.decodedBytes + run.transfer.api.decodedBytes)),
    externalTileCount: summarize(runs.map((run) => run.transfer.external.tileCount)),
    externalTileDurationMs: summarize(runs.map((run) => run.transfer.external.tileDurationMs)),
    coldStartFirstByteMs: summarize(runs.map((run) => run.coldStartFirstByteMs)),
  }

  const payload = {
    schema: 'e5-browser-performance/1',
    generatedAt: new Date().toISOString(),
    environment: {
      chromeBinary,
      chromeVersion: runs[0]?.chromeVersion || null,
      headless: !options.headful,
      node: process.version,
      platform: `${process.platform} ${arch()}`,
      hostname: hostname(),
      cpuModel: cpus()[0]?.model || null,
      cpuCount: cpus().length,
      viewport: `${viewportOf(runs)}`,
      cacheDisabled: options.cache === 'disabled',
      sampleSeconds: options.sampleSeconds,
      runs: options.runs,
      successfulRuns: runs.length,
      failedRuns: failures,
    },
    targets: { firstScreenMs: TARGET_FIRST_SCREEN_MS, fps: TARGET_FPS },
    summary,
    runs,
  }
  writeFileSync(options.out, JSON.stringify(payload, null, 2), 'utf8')

  printReport(payload, options)
  process.stdout.write(`\n原始数据：${options.out}\n`)
  process.stdout.write('退出码 0 —— 本轮是报告，不是门禁。\n')
  return 0
}

function viewportOf(runs) {
  return `${WINDOW_SIZE.width}x${WINDOW_SIZE.height}`
}

function printReport(payload, options) {
  const { summary, runs } = payload
  const medianLcp = summary.lcpMs.median
  const medianLoad = summary.loadEventEndMs.median
  const medianReady = summary.appReadyMs.median
  const medianColdStart = summary.coldStartFirstByteMs.median
  const medianStatic = summary.fpsStatic.median
  const medianMotion = summary.fpsMotion.median

  const rows = [
    [
      '首屏（LargestContentfulPaint）',
      `< ${TARGET_FIRST_SCREEN_MS} ms`,
      formatMs(medianLcp),
      medianLcp !== null && medianLcp < TARGET_FIRST_SCREEN_MS ? PASS : FAIL,
    ],
    [
      '页面 load 事件（loadEventEnd）',
      `< ${TARGET_FIRST_SCREEN_MS} ms`,
      formatMs(medianLoad),
      medianLoad !== null && medianLoad < TARGET_FIRST_SCREEN_MS ? PASS : FAIL,
    ],
    [
      '应用就绪（数据到位 → 城市入场景）',
      `参考（无验收线）`,
      formatMs(medianReady),
      '参考',
    ],
    [
      '冷启动（全新浏览器首个导航的首字节）',
      `参考（浏览器开销，不是产品成本）`,
      formatMs(medianColdStart),
      '参考',
    ],
    [
      '帧率（静止）',
      `>= ${TARGET_FPS} fps`,
      medianStatic !== null ? `${medianStatic.toFixed(1)} fps` : UNKNOWN,
      medianStatic !== null && medianStatic >= TARGET_FPS ? PASS : FAIL,
    ],
    [
      '帧率（相机运动）',
      `>= ${TARGET_FPS} fps`,
      medianMotion !== null ? `${medianMotion.toFixed(1)} fps` : UNKNOWN,
      medianMotion !== null && medianMotion >= TARGET_FPS ? PASS : FAIL,
    ],
  ]

  process.stdout.write('='.repeat(78) + '\n')
  process.stdout.write('智慧城市平台 · 浏览器端性能度量（生产构建 + 真实浏览器）\n')
  process.stdout.write('='.repeat(78) + '\n')
  process.stdout.write(
    `Chrome   ：${payload.environment.chromeVersion || payload.environment.chromeBinary}` +
      `（${payload.environment.headless ? 'headless=new' : 'headful'}）\n`
  )
  process.stdout.write(`采样     ：${options.runs} 轮，每轮帧率采样 ${options.sampleSeconds} 秒\n`)
  process.stdout.write(`缓存     ：${payload.environment.cacheDisabled ? '已禁用（每轮都是首次访问）' : '启用'}\n`)
  process.stdout.write(`机器     ：${payload.environment.cpuModel || '未知 CPU'} / ${payload.environment.cpuCount} 核\n\n`)
  process.stdout.write(renderTable(['指标', '计划书验收线', '实测（中位数）', '判定'], rows) + '\n\n')

  const perRunRows = runs.map((run) => [
    String(run.run),
    formatMs(run.coldStartFirstByteMs),
    formatMs(run.lcpMs),
    formatMs(run.loadEventEndMs),
    formatMs(run.appReadyMs),
    run.fpsStatic ? run.fpsStatic.toFixed(1) : UNKNOWN,
    run.fpsMotion ? run.fpsMotion.toFixed(1) : UNKNOWN,
    String(run.transfer.external.tileCount ?? 0),
    `${run.transfer.external.tileDurationMs} ms`,
    run.systemCpuBusyPercent !== null && run.systemCpuBusyPercent !== undefined
      ? `${run.systemCpuBusyPercent.toFixed(0)}%`
      : UNKNOWN,
  ])
  process.stdout.write('逐轮明细（冷启动 = 全新浏览器首个导航的首字节；外部 = 高德瓦片；CPU = 测量期间整机非空闲时间占比）\n')
  process.stdout.write(
    renderTable(
      ['轮', '冷启动', 'LCP', 'load', '应用就绪', '静止 fps', '运动 fps', '瓦片数', '瓦片耗时', 'CPU'],
      perRunRows
    ) + '\n\n'
  )

  const spreadRows = [
    ['冷启动首字节', formatMs(summary.coldStartFirstByteMs.min), formatMs(summary.coldStartFirstByteMs.median), formatMs(summary.coldStartFirstByteMs.max), formatMs(summary.coldStartFirstByteMs.spread)],
    ['首屏 LCP', formatMs(summary.lcpMs.min), formatMs(summary.lcpMs.median), formatMs(summary.lcpMs.max), formatMs(summary.lcpMs.spread)],
    ['load 事件', formatMs(summary.loadEventEndMs.min), formatMs(summary.loadEventEndMs.median), formatMs(summary.loadEventEndMs.max), formatMs(summary.loadEventEndMs.spread)],
    ['应用就绪', formatMs(summary.appReadyMs.min), formatMs(summary.appReadyMs.median), formatMs(summary.appReadyMs.max), formatMs(summary.appReadyMs.spread)],
    ['静止 fps', summary.fpsStatic.min?.toFixed(1), summary.fpsStatic.median?.toFixed(1), summary.fpsStatic.max?.toFixed(1), summary.fpsStatic.spread?.toFixed(1)],
    ['运动 fps', summary.fpsMotion.min?.toFixed(1), summary.fpsMotion.median?.toFixed(1), summary.fpsMotion.max?.toFixed(1), summary.fpsMotion.spread?.toFixed(1)],
  ]
  process.stdout.write('波动（min / 中位数 / max / 极差）\n')
  process.stdout.write(renderTable(['指标', 'min', '中位数', 'max', '极差'], spreadRows) + '\n\n')

  const first = runs[0]
  process.stdout.write('首屏传输量（按来源拆分，数字取各轮中位数）\n')
  const transferRows = []
  for (const key of ['app', 'cesium', 'api', 'external']) {
    const counts = summarize(runs.map((run) => run.transfer[key].count))
    const transferred = summarize(runs.map((run) => run.transfer[key].transferBytes))
    const decoded = summarize(runs.map((run) => run.transfer[key].decodedBytes))
    transferRows.push([
      { app: '应用产物（HTML/JS/CSS）', cesium: 'Cesium 运行时（/Cesium/）', api: '后端 API（/api/*）', external: '外部（高德瓦片）' }[key],
      String(counts.median ?? 0),
      formatBytes(transferred.median),
      formatBytes(decoded.median),
    ])
  }
  process.stdout.write(renderTable(['来源', '请求数', '传输量（线上字节）', '解码后体积'], transferRows) + '\n\n')

  if (first) {
    const tileShare = first.transfer.external.tileTimeShare
    process.stdout.write(
      `外部网络：高德瓦片 ${first.transfer.external.tileCount} 个，` +
        `累计等待 ${first.transfer.external.tileDurationMs} ms，` +
        `占首屏全部请求耗时 ${tileShare !== null ? (tileShare * 100).toFixed(1) + '%' : '未知'}（第 1 轮）。\n`
    )
    process.stdout.write(
      '          瓦片来自 webrd0{1..4}.is.autonavi.com（外部网络），' +
        '这部分耗时**不是**前端代码的成本，解读首屏数字时必须单独摘出来。\n'
    )
    const lcpTag = first.lcpElement
    if (lcpTag) {
      process.stdout.write(
        `口径提醒：LCP 命中的元素是 <${lcpTag.toLowerCase()}>。` +
          'WebGL 画布不是 LCP 候选元素，所以 LCP 量的是页面文字块，' +
          '不是「3D 城市画出来了」——后者看「应用就绪」一行。\n'
      )
    }
    if (first.motionWitness) {
      process.stdout.write(
        `运动取证：拖拽前后两帧${first.motionWitness.frameChanged ? '**不同**（相机确实动了、画面重绘了）' : '相同（相机可能没动，fps 数字不可信）'}，` +
          `截图见 ${first.motionWitness.beforePath} 与 ${first.motionWitness.afterPath}。\n`
      )
    }
    process.stdout.write(
      `帧间隔   ：第 1 轮静止 p50 ${fmt(first.fpsStaticFrameIntervalP50Ms)} / p95 ${fmt(first.fpsStaticFrameIntervalP95Ms)} / max ${fmt(first.fpsStaticFrameIntervalMaxMs)}；` +
        `运动 p50 ${fmt(first.fpsMotionFrameIntervalP50Ms)} / p95 ${fmt(first.fpsMotionFrameIntervalP95Ms)} / max ${fmt(first.fpsMotionFrameIntervalMaxMs)}。\n`
    )
  }
  process.stdout.write(
    '口径提醒：headless Chrome 的帧源**不受显示器刷新率锁**（没有 vsync），' +
      '所以这里的 fps 是「渲染器每秒能产出多少帧」，不是「屏幕上每秒显示多少帧」。\n'
  )
  process.stdout.write(
    '口径提醒：首屏数字量的是**浏览器已就绪之后**的页面加载（脚本先访问一次同源的 /health\n' +
      '        把全新 Chrome 的网络栈/renderer 拉起来，那段冷启动延迟单独记在「冷启动」一行）。\n' +
      '        不这样拆的话，量到的是「浏览器冷启动 + 页面加载」的混合体，而冷启动那部分在共享\n' +
      '        机器上会在 1.3–8.8 s 之间乱跳，根本不可复跑。\n'
  )
  const busyRuns = runs.filter(
    (run) => typeof run.systemCpuBusyPercent === 'number' && run.systemCpuBusyPercent >= 60
  )
  if (busyRuns.length) {
    process.stdout.write(
      `⚠ 宿主机争用：${busyRuns.length}/${runs.length} 轮测量期间整机 CPU 非空闲 ≥ 60%` +
        `（最高 ${Math.max(...busyRuns.map((run) => run.systemCpuBusyPercent)).toFixed(0)}%）。` +
        '共享机器上的首屏数字会被显著抬高——**别把机器忙当成产品慢**。\n'
    )
  }
  process.stdout.write('\n')
}

function fmt(value) {
  return value === null || value === undefined ? UNKNOWN : `${value.toFixed(1)} ms`
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`\n度量失败：${error.message}\n`)
    process.exit(1)
  })
