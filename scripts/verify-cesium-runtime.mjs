#!/usr/bin/env node
/**
 * Cesium 运行时裁剪验证：10 个交互动作的回归 + 实际加载集比对。
 *
 * 用法
 * ----
 *     node scripts/verify-cesium-runtime.mjs [选项]
 *     node scripts/verify-cesium-runtime.mjs --compare <a.png> <b.png>
 *
 * 一次跑完会：确保生产构建存在 → 起后端（端口 8035）→ 起一个**独立的 headless
 * Chrome** → 跑完 10 个交互动作 → 全程记录所有 /Cesium/ 请求 → 断言
 * 「零 404」「被剪掉的文件零命中」「应用功能正常」→ 出一份 JSON 与一张截图。
 *
 * 观测口径（两个口径必须合起来用，缺一个都会漏）
 * ------------------------------------------------
 *   1. **CDP Network 事件**。能看到主线程与 **worker 内部**的请求。
 *      但 Chrome 的网络日志有条数上限，外部请求会把早期的 Cesium 请求挤掉，
 *      所以单靠它不完整。
 *   2. **页面内 performance.getEntriesByType('resource')**。没有条数上限，
 *      能拿到主线程加载的全部资源（Assets / Widgets 图片 / worker 入口脚本），
 *      但看不到 worker target 内部的 chunk 导入。
 *   ⇒ 取两者的**并集**才是完整的「实际加载集」。
 *
 * 抓 worker 请求的关键
 * ------------------
 *   必须发 `Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: true,
 *   flatten: true })`，并对**每个 attach 进来的 worker target** 单独
 *   `Network.enable` —— 否则抓不到 worker 的请求。
 *   这里用 waitForDebuggerOnStart: true（而不是 false）：worker 起来后立刻
 *   发请求，等我们 enable 好 Network 就已经错过第一批了。attach 进来后
 *   `Runtime.runIfWaitingForDebugger` 把它放行，两头都不耽误。
 *
 * 端口
 * ----
 *   默认 8035，**不用 8000**（本机 8000 被别的项目占着）。
 *
 * 后端子进程
 * ----------
 *   stdout/stderr **落文件**（fd 直连），不用没人读的 PIPE ——
 *   否则 uvicorn 会阻塞在写日志上，表现为请求超时 60 秒。
 *
 * 退出码
 * ------
 *   0  全部断言通过
 *   1  有断言失败（零 404 / 被剪文件零命中 / 功能正常 任一不满足）
 *
 * 依赖：只用 Node 内置能力（内置 WebSocket 直连 CDP，不需要 puppeteer）。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const DEFAULT_PORT = 8035
const DEFAULT_CDP_PORT = 9360
const DEFAULT_NAV_TIMEOUT_MS = 90_000
const DEFAULT_APP_READY_TIMEOUT_MS = 90_000
const WINDOW_SIZE = { width: 1280, height: 720 }
const CESIUM_URL_MARK = '/Cesium/'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// PNG 解码与像素比对（只用 Node 内置 zlib，不引第三方库）
// ---------------------------------------------------------------------------

/** 解一个 8 位、非隔行的 PNG（Chrome 截图就是这种）。 */
export function decodePng(buffer) {
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  while (pos + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(pos)
    const type = buffer.toString('ascii', pos + 4, pos + 8)
    const data = buffer.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`只支持 8 位 PNG，实际 ${bitDepth}`)
  if (interlace !== 0) throw new Error('不支持隔行 PNG')
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = channels
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  let rp = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rp]
    rp += 1
    const line = raw.subarray(rp, rp + stride)
    rp += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (filter === 1) v = (v + a) & 255
      else if (filter === 2) v = (v + b) & 255
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
      cur[x] = v
    }
  }
  return { width, height, channels, data: out }
}

/**
 * 比两张截图。
 *
 * 报告三组数：
 *   - 全图差异像素占比（判断「有没有肉眼可见的退化」）
 *   - 天空区（顶部 20%）的平均亮度与纯黑像素占比（天空盒缺失 → 天空变黑）
 *   - 最大通道差
 */
export function diffPngs(bufferA, bufferB, { threshold = 12 } = {}) {
  const A = decodePng(bufferA)
  const B = decodePng(bufferB)
  if (A.width !== B.width || A.height !== B.height) {
    return { comparable: false, reason: `尺寸不同：${A.width}x${A.height} vs ${B.width}x${B.height}` }
  }
  const total = A.width * A.height
  const skyRows = Math.max(1, Math.floor(A.height * 0.2))
  let differing = 0
  let sumDelta = 0
  let maxDelta = 0
  let skyLumA = 0
  let skyLumB = 0
  let skyBlackA = 0
  let skyBlackB = 0
  let skyPixels = 0
  const ch = Math.min(A.channels, B.channels)

  for (let y = 0; y < A.height; y += 1) {
    const inSky = y < skyRows
    for (let x = 0; x < A.width; x += 1) {
      const ia = (y * A.width + x) * A.channels
      const ib = (y * B.width + x) * B.channels
      let delta = 0
      for (let c = 0; c < ch; c += 1) {
        delta = Math.max(delta, Math.abs(A.data[ia + c] - B.data[ib + c]))
      }
      sumDelta += delta
      if (delta > maxDelta) maxDelta = delta
      if (delta > threshold) differing += 1
      if (inSky) {
        const lumA = (A.data[ia] * 299 + A.data[ia + 1] * 587 + A.data[ia + 2] * 114) / 1000
        const lumB = (B.data[ib] * 299 + B.data[ib + 1] * 587 + B.data[ib + 2] * 114) / 1000
        skyLumA += lumA
        skyLumB += lumB
        if (lumA < 6) skyBlackA += 1
        if (lumB < 6) skyBlackB += 1
        skyPixels += 1
      }
    }
  }
  return {
    comparable: true,
    width: A.width,
    height: A.height,
    totalPixels: total,
    differingPixels: differing,
    differingRatio: differing / total,
    meanChannelDelta: sumDelta / total,
    maxChannelDelta: maxDelta,
    threshold,
    sky: {
      rows: skyRows,
      pixels: skyPixels,
      meanLuminanceA: skyLumA / skyPixels,
      meanLuminanceB: skyLumB / skyPixels,
      blackRatioA: skyBlackA / skyPixels,
      blackRatioB: skyBlackB / skyPixels,
    },
  }
}

// ---------------------------------------------------------------------------
// CDP 客户端
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
      for (const entry of this.pending.values()) entry.reject(new Error('CDP 连接已关闭'))
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
      /* 忽略 */
    }
  }
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
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
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
    '--enable-unsafe-swiftshader',
  ]
  if (process.platform === 'linux') {
    args.push('--disable-dev-shm-usage')
  }
  if (!headful) args.unshift('--headless=new')
  args.push('about:blank')

  mkdirSync(path.dirname(logPath), { recursive: true })
  const logFd = openSync(logPath, 'w')
  const child = spawn(binary, args, { stdio: ['ignore', logFd, logFd], windowsHide: true })
  child.on('error', (error) => process.stderr.write(`Chrome 启动失败：${error.message}\n`))

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
        signal: AbortSignal.timeout(5000),
      })
      if (response.ok) return { child, version: await response.json() }
    } catch {
      /* 还没起来 */
    }
    if (child.exitCode !== null) throw new Error(`Chrome 进程已退出（退出码 ${child.exitCode}）`)
    await sleep(300)
  }
  child.kill()
  throw new Error(`Chrome 在 60 秒内没有开放调试端口 ${cdpPort}`)
}

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
    /* 忽略 */
  }
}

// ---------------------------------------------------------------------------
// 后端
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
        const root = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(5000) })
        const contentType = root.headers.get('content-type') || ''
        const body = await root.text()
        return {
          child,
          baseUrl,
          logPath,
          rootContentType: contentType,
          servedHtml: contentType.includes('text/html'),
          rootBytes: body.length,
        }
      }
    } catch {
      /* 还没起来 */
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
      /* 忽略 */
    }
}

// ---------------------------------------------------------------------------
// 页面交互
// ---------------------------------------------------------------------------

async function evaluate(cdp, sessionId, expression) {
  let lastError = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: false },
        sessionId,
      )
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || '页面内求值抛错')
      }
      return result.result?.value
    } catch (error) {
      lastError = error
      await sleep(150)
    }
  }
  throw lastError
}

async function waitForAppReady(cdp, sessionId, timeoutMs, network) {
  const deadline = Date.now() + timeoutMs
  let sawLoading = false
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
      })()`,
    )
    if (state && state.loading) {
      sawLoading = true
    } else if (state && state.canvas) {
      // 横幅消失 = 数据到位。但如果横幅压根没被轮询到（数据回得太快），
      // 用「已经有一个 /api/* 响应回来了」当兜底判据。
      const apiAnswered = network ? network.apiResponses > 0 : false
      if (sawLoading || apiAnswered) {
        return {
          appReadyMs: state.now,
          method: sawLoading
            ? '加载横幅出现后消失'
            : '未观测到加载横幅，以首个 /api/* 响应到达为准',
        }
      }
    }
    await sleep(50)
  }
  return { appReadyMs: null, method: '超时未观测到应用就绪', timedOut: true }
}

async function captureScreenshot(cdp, sessionId) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  return Buffer.from(data, 'base64')
}

/** 按按钮文字点击控制面板上的按钮。返回点击前后的按钮文字。 */
async function clickButton(cdp, sessionId, matcher) {
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const buttons = Array.from(document.querySelectorAll('.control-panel button'));
      const target = buttons.find((b) => ${matcher});
      if (!target) return { ok: false, buttons: buttons.map((b) => b.textContent.trim()) };
      const before = target.textContent.trim();
      target.click();
      return { ok: true, before };
    })()`,
  )
}

async function buttonTexts(cdp, sessionId) {
  return evaluate(
    cdp,
    sessionId,
    `Array.from(document.querySelectorAll('.control-panel button')).map((b) => b.textContent.trim())`,
  )
}

async function dragMouse(cdp, sessionId, { button, dx, dy, steps = 12, stepDelayMs = 30 }) {
  const viewport = await evaluate(cdp, sessionId, '({ w: window.innerWidth, h: window.innerHeight })')
  const centerX = Math.round((viewport?.w || WINDOW_SIZE.width) / 2)
  const centerY = Math.round((viewport?.h || WINDOW_SIZE.height) / 2)
  const buttons = button === 'right' ? 2 : 1
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: centerX, y: centerY, button, buttons, clickCount: 1 },
    sessionId,
  )
  for (let index = 1; index <= steps; index += 1) {
    await cdp.send(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseMoved',
        x: centerX + Math.round((dx * index) / steps),
        y: centerY + Math.round((dy * index) / steps),
        button,
        buttons,
      },
      sessionId,
    )
    await sleep(stepDelayMs)
  }
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: centerX, y: centerY, button, buttons: 0, clickCount: 1 },
    sessionId,
  )
}

async function wheel(cdp, sessionId, { deltaY, modifiers = 0, times = 1 }) {
  const viewport = await evaluate(cdp, sessionId, '({ w: window.innerWidth, h: window.innerHeight })')
  const x = Math.round((viewport?.w || WINDOW_SIZE.width) / 2)
  const y = Math.round((viewport?.h || WINDOW_SIZE.height) / 2)
  for (let index = 0; index < times; index += 1) {
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers },
      sessionId,
    )
    await sleep(120)
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const options = {
    repoRoot,
    port: DEFAULT_PORT,
    cdpPort: DEFAULT_CDP_PORT,
    headful: false,
    build: 'auto',
    label: 'run',
    manifest: null,
    out: null,
    screenshot: null,
    artifacts: null,
    compare: null,
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
      case '--headful': options.headful = true; break
      case '--build': options.build = 'always'; break
      case '--no-build': options.build = 'never'; break
      case '--label': options.label = next(); break
      case '--manifest': options.manifest = path.resolve(next()); break
      case '--out': options.out = path.resolve(next()); break
      case '--screenshot': options.screenshot = path.resolve(next()); break
      case '--artifacts': options.artifacts = path.resolve(next()); break
      case '--compare':
        options.compare = [path.resolve(next()), path.resolve(next())]
        break
      default:
        throw new Error(`未知参数：${arg}`)
    }
  }
  options.artifacts = options.artifacts || path.join(options.repoRoot, '.acceptance')
  options.out = options.out || path.join(options.artifacts, `cesium-runtime-${options.label}.json`)
  options.screenshot =
    options.screenshot || path.join(options.artifacts, 'screenshots', `cesium-${options.label}.png`)
  options.manifest =
    options.manifest || path.join(options.repoRoot, 'Data-driven-modeling', 'cesium-runtime-manifest.json')
  return options
}

function listFilesRecursive(root) {
  const out = []
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(abs, rel)
      else out.push(rel)
    }
  }
  walk(root, '')
  return out
}

async function ensureProductionBuild(options) {
  const indexPath = path.join(options.repoRoot, 'Data-driven-modeling', 'dist', 'index.html')
  const has = existsSync(indexPath)
  if (options.build === 'never') {
    if (!has) throw new Error(`--no-build 但找不到生产产物：${indexPath}`)
    return { built: false, indexPath }
  }
  if (options.build === 'auto' && has) return { built: false, indexPath }
  const frontendDir = path.join(options.repoRoot, 'Data-driven-modeling')
  const logPath = path.join(options.artifacts, 'server-logs', 'verify-build.log')
  mkdirSync(path.dirname(logPath), { recursive: true })
  const logFd = openSync(logPath, 'w')
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

async function runVerification(options) {
  mkdirSync(options.artifacts, { recursive: true })
  const chromeBinary = findChrome(process.env.CHROME_PATH)
  if (!chromeBinary) throw new Error('本机找不到 Chrome/Edge 可执行文件')

  const build = await ensureProductionBuild(options)
  process.stdout.write(`生产产物：${build.indexPath}${build.built ? '（本轮新建）' : '（已存在）'}\n`)

  const logPath = path.join(options.artifacts, 'server-logs', `verify-backend-${options.port}.log`)
  const profileDir = path.join(tmpdir(), `smart-city-c1-chrome-${process.pid}`)

  let backend = null
  let chrome = null
  let cdp = null

  const network = {
    /** URL → { status, failed, errorText, source } */
    entries: new Map(),
    cdpEventCount: 0,
    apiResponses: 0,
    workerTargets: [],
  }
  const consoleMessages = []
  const pageErrors = []

  try {
    backend = await startBackend({ repoRoot: options.repoRoot, port: options.port, logPath })
    if (!backend.servedHtml) {
      throw new Error(
        `GET / 返回的是 ${backend.rootContentType || '未知类型'} 而不是 HTML —— 后端没找到 dist/。日志见 ${logPath}`,
      )
    }
    process.stdout.write(`后端    ：${backend.baseUrl}\n`)

    chrome = await launchChrome({
      binary: chromeBinary,
      cdpPort: options.cdpPort,
      userDataDir: profileDir,
      headful: options.headful,
      logPath: path.join(options.artifacts, 'server-logs', `verify-chrome-${options.cdpPort}.log`),
    })
    cdp = new CdpClient(chrome.version.webSocketDebuggerUrl)
    await cdp.connect()

    // --- 关键：worker 自动 attach -----------------------------------------
    // 不发这一条，worker 内部的请求一个都抓不到。
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    })

    const attachHandler = async (params) => {
      const { sessionId, targetInfo } = params
      network.workerTargets.push(targetInfo?.type || 'unknown')
      try {
        await cdp.send('Network.enable', {}, sessionId)
        await cdp.send('Runtime.enable', {}, sessionId)
        // 嵌套 worker（worker 里再起 worker）也要接上
        await cdp.send(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
          sessionId,
        )
      } catch {
        /* 目标可能已经关掉了 */
      }
      try {
        await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId)
      } catch {
        /* 忽略 */
      }
    }
    cdp.on('Target.attachedToTarget', attachHandler)

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
    await cdp.send('Log.enable', {}, sessionId)
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId)
    await cdp.send('Target.activateTarget', { targetId }).catch(() => {})
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {})
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {})

    // --- 记录请求（页面 session 与所有 worker session 都监听）--------------
    const onRequest = (params) => {
      network.cdpEventCount += 1
      const url = params.request?.url || ''
      if (!url.includes(CESIUM_URL_MARK)) return
      const previous = network.entries.get(url) || { url, status: null, failed: false, errorText: null }
      network.entries.set(url, previous)
    }
    const onResponse = (params) => {
      const url = params.response?.url || ''
      if (url.includes('/api/')) network.apiResponses += 1
      if (!url.includes(CESIUM_URL_MARK)) return
      const previous = network.entries.get(url) || { url, status: null, failed: false, errorText: null }
      previous.status = params.response.status
      network.entries.set(url, previous)
    }
    const onFailed = (params) => {
      const url = params.request?.url || ''
      if (!url.includes(CESIUM_URL_MARK)) return
      const previous = network.entries.get(url) || { url, status: null, failed: false, errorText: null }
      previous.failed = true
      previous.errorText = params.errorText
      network.entries.set(url, previous)
    }
    // 注意：事件订阅只挂**不带 sessionId** 的那一路。
    // 本客户端在处理带 sessionId 的消息时，除了派发 scoped 处理器，
    // 还会把同一个方法名（不带 sessionId）的处理器也调一遍 ——
    // 所以不挂 scoped 的那一路，就等于同时收到页面与所有 worker 的事件。
    cdp.on('Network.requestWillBeSent', onRequest)
    cdp.on('Network.responseReceived', onResponse)
    cdp.on('Network.loadingFailed', onFailed)

    cdp.on('Runtime.consoleAPICalled', (params) => {
      const text = (params.args || [])
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(' ')
      consoleMessages.push({ type: params.type, text })
    })
    cdp.on('Runtime.exceptionThrown', (params) => {
      pageErrors.push(params.exceptionDetails?.exception?.description || '未知异常')
    })
    cdp.on('Log.entryAdded', (params) => {
      if (params.entry?.level === 'error') {
        pageErrors.push(`[log] ${params.entry.text}`)
      }
    })

    // --- 预热：把浏览器冷启动开销从首屏里摘出去 ---------------------------
    const warmLoad = cdp
      .once('Page.loadEventFired', sessionId, 30_000)
      .then(() => true)
      .catch(() => false)
    await cdp.send('Page.navigate', { url: `${backend.baseUrl}/health` }, sessionId)
    await warmLoad

    // --- R1 首屏 ----------------------------------------------------------
    const loadFired = cdp
      .once('Page.loadEventFired', sessionId, DEFAULT_NAV_TIMEOUT_MS)
      .then(() => true)
      .catch(() => false)
    await cdp.send('Page.navigate', { url: `${backend.baseUrl}/` }, sessionId)
    const appReady = await waitForAppReady(cdp, sessionId, DEFAULT_APP_READY_TIMEOUT_MS, network)
    const loadOk = await loadFired
    // flyTo 2 秒，等相机落位
    await sleep(4000)

    const actions = []
    const record = (id, name, detail) => {
      actions.push({ id, name, ...detail })
      process.stdout.write(`  ${id} ${name}：${detail.note ?? '完成'}\n`)
    }

    // 基准截图（traffic 关掉 → 场景静止 → 截图可复现）
    await clickButton(cdp, sessionId, `b.textContent.includes('停止交通')`)
    await sleep(1500)
    const canonicalShot = await captureScreenshot(cdp, sessionId)
    mkdirSync(path.dirname(options.screenshot), { recursive: true })
    writeFileSync(options.screenshot, canonicalShot)
    const buttonsAfterHideTraffic = await buttonTexts(cdp, sessionId)
    await clickButton(cdp, sessionId, `b.textContent.includes('启动交通')`)
    await sleep(1500)

    record('R1', '首屏加载 → 应用就绪', {
      appReadyMs: appReady.appReadyMs,
      loadEventFired: loadOk,
      method: appReady.method,
      note: appReady.appReadyMs ? `${Math.round(appReady.appReadyMs)} ms` : '超时',
    })

    // --- R2 建筑显隐 ------------------------------------------------------
    const beforeBuildings = await captureScreenshot(cdp, sessionId)
    const clickBuildings = await clickButton(cdp, sessionId, `b.textContent.includes('隐藏建筑')`)
    await sleep(1200)
    const afterBuildings = await captureScreenshot(cdp, sessionId)
    const buildingsDiff = diffPngs(beforeBuildings, afterBuildings)
    await clickButton(cdp, sessionId, `b.textContent.includes('显示建筑')`)
    await sleep(800)
    record('R2', '建筑显隐开关（关 → 开）', {
      clicked: clickBuildings.ok,
      buttonBefore: clickBuildings.before,
      buttonAfter: buttonsAfterHideTraffic.join(' | '),
      pixelDiffRatio: buildingsDiff.differingRatio,
      note: `像素差 ${(buildingsDiff.differingRatio * 100).toFixed(2)}%`,
    })

    // --- R3 道路显隐 ------------------------------------------------------
    const beforeRoads = await captureScreenshot(cdp, sessionId)
    const clickRoads = await clickButton(cdp, sessionId, `b.textContent.includes('隐藏道路')`)
    await sleep(1200)
    const afterRoads = await captureScreenshot(cdp, sessionId)
    const roadsDiff = diffPngs(beforeRoads, afterRoads)
    await clickButton(cdp, sessionId, `b.textContent.includes('显示道路')`)
    await sleep(800)
    record('R3', '道路显隐开关（关 → 开）', {
      clicked: clickRoads.ok,
      buttonBefore: clickRoads.before,
      pixelDiffRatio: roadsDiff.differingRatio,
      note: `像素差 ${(roadsDiff.differingRatio * 100).toFixed(2)}%`,
    })

    // --- R4 交通显隐 ------------------------------------------------------
    const beforeTraffic = await captureScreenshot(cdp, sessionId)
    const clickTraffic = await clickButton(cdp, sessionId, `b.textContent.includes('停止交通')`)
    await sleep(1200)
    const afterTraffic = await captureScreenshot(cdp, sessionId)
    const trafficDiff = diffPngs(beforeTraffic, afterTraffic)
    await clickButton(cdp, sessionId, `b.textContent.includes('启动交通')`)
    await sleep(1200)
    record('R4', '交通显隐开关（关 → 开）', {
      clicked: clickTraffic.ok,
      buttonBefore: clickTraffic.before,
      pixelDiffRatio: trafficDiff.differingRatio,
      note: `像素差 ${(trafficDiff.differingRatio * 100).toFixed(2)}%`,
    })

    // --- R5 鸟瞰 → 平视 ---------------------------------------------------
    const beforeStreet = await captureScreenshot(cdp, sessionId)
    const clickView = await clickButton(cdp, sessionId, `b.textContent.includes('切换平视')`)
    await sleep(3500)
    const afterStreet = await captureScreenshot(cdp, sessionId)
    const streetDiff = diffPngs(beforeStreet, afterStreet)
    const buttonsInStreet = await buttonTexts(cdp, sessionId)
    record('R5', '鸟瞰 → 平视（相机飞行）', {
      clicked: clickView.ok,
      buttonBefore: clickView.before,
      buttonsAfter: buttonsInStreet,
      pixelDiffRatio: streetDiff.differingRatio,
      note: `像素差 ${(streetDiff.differingRatio * 100).toFixed(2)}%`,
    })

    // --- R6 平视 → 鸟瞰 ---------------------------------------------------
    const beforeOverhead = await captureScreenshot(cdp, sessionId)
    const clickView2 = await clickButton(cdp, sessionId, `b.textContent.includes('切换鸟瞰')`)
    await sleep(3500)
    const afterOverhead = await captureScreenshot(cdp, sessionId)
    const overheadDiff = diffPngs(beforeOverhead, afterOverhead)
    record('R6', '平视 → 鸟瞰（相机飞行）', {
      clicked: clickView2.ok,
      buttonBefore: clickView2.before,
      pixelDiffRatio: overheadDiff.differingRatio,
      note: `像素差 ${(overheadDiff.differingRatio * 100).toFixed(2)}%`,
    })

    // --- R7 左键拖拽（平移）----------------------------------------------
    const beforeDrag = await captureScreenshot(cdp, sessionId)
    await dragMouse(cdp, sessionId, { button: 'left', dx: 180, dy: 60 })
    await sleep(1500)
    const afterDrag = await captureScreenshot(cdp, sessionId)
    const dragDiff = diffPngs(beforeDrag, afterDrag)
    record('R7', '左键拖拽（平移）', {
      pixelDiffRatio: dragDiff.differingRatio,
      note: `像素差 ${(dragDiff.differingRatio * 100).toFixed(2)}%`,
    })

    // --- R8 滚轮缩放 ×5 ---------------------------------------------------
    const beforeZoom = await captureScreenshot(cdp, sessionId)
    await wheel(cdp, sessionId, { deltaY: -240, times: 5 })
    await sleep(1500)
    const afterZoom = await captureScreenshot(cdp, sessionId)
    const zoomDiff = diffPngs(beforeZoom, afterZoom)
    record('R8', '滚轮缩放 ×5', {
      pixelDiffRatio: zoomDiff.differingRatio,
      note: `像素差 ${(zoomDiff.differingRatio * 100).toFixed(2)}%`,
    })

    // --- R9 Ctrl+滚轮（倾斜）---------------------------------------------
    const beforeTilt = await captureScreenshot(cdp, sessionId)
    await wheel(cdp, sessionId, { deltaY: -240, modifiers: 2, times: 5 })
    await sleep(1500)
    const afterTilt = await captureScreenshot(cdp, sessionId)
    const tiltDiff = diffPngs(beforeTilt, afterTilt)
    record('R9', 'Ctrl+滚轮（倾斜）', {
      pixelDiffRatio: tiltDiff.differingRatio,
      note: `像素差 ${(tiltDiff.differingRatio * 100).toFixed(2)}%`,
    })

    // --- R10 右键拖拽（视角旋转 → 相机转到地平线以上，SkyBox 的触发路径）----
    const beforeRight = await captureScreenshot(cdp, sessionId)
    await dragMouse(cdp, sessionId, { button: 'right', dx: -220, dy: -140, steps: 16 })
    await sleep(2000)
    const afterRight = await captureScreenshot(cdp, sessionId)
    const rightDiff = diffPngs(beforeRight, afterRight)
    record('R10', '右键拖拽（视角旋转）', {
      pixelDiffRatio: rightDiff.differingRatio,
      note: `像素差 ${(rightDiff.differingRatio * 100).toFixed(2)}%`,
    })

    const finalShot = await captureScreenshot(cdp, sessionId)
    const finalShotPath = options.screenshot.replace(/\.png$/, '-final.png')
    writeFileSync(finalShotPath, finalShot)

    // --- 观测口径 2：页面内资源计时（无条数上限）--------------------------
    const resourceEntries = await evaluate(
      cdp,
      sessionId,
      `performance.getEntriesByType('resource').map((r) => r.name)`,
    )

    // --- 合并两个口径 -----------------------------------------------------
    const cdpPaths = new Map()
    for (const [url, entry] of network.entries) {
      const pathPart = new URL(url).pathname
      const rel = pathPart.replace(/^\/Cesium\//, '')
      cdpPaths.set(rel, entry)
    }
    const resourcePaths = new Set()
    for (const name of resourceEntries || []) {
      if (!name.includes(CESIUM_URL_MARK)) continue
      const rel = new URL(name).pathname.replace(/^\/Cesium\//, '')
      resourcePaths.add(rel)
    }
    const observed = new Set([...cdpPaths.keys(), ...resourcePaths])

    // --- 断言 -------------------------------------------------------------
    const failures = []
    const failedRequests = []
    for (const [rel, entry] of cdpPaths) {
      const bad = entry.failed || (entry.status !== null && entry.status >= 400)
      if (bad) failedRequests.push({ path: rel, status: entry.status, error: entry.errorText })
    }
    if (failedRequests.length) {
      failures.push(`有 ${failedRequests.length} 个 /Cesium/ 请求失败（404 或加载失败）`)
    }

    // 被剪掉的文件零命中
    let pruneHits = []
    let prunedSet = new Set()
    if (existsSync(options.manifest)) {
      const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'))
      prunedSet = new Set(manifest.prune?.files || [])
      pruneHits = [...prunedSet].filter((rel) => observed.has(rel))
      if (pruneHits.length) {
        failures.push(`被剪掉的文件在回归中被请求了 ${pruneHits.length} 个`)
      }
    }

    // 应用功能正常
    const trafficStatus = await evaluate(
      cdp,
      sessionId,
      `(document.querySelector('.traffic-status')?.textContent || '').trim()`,
    )
    const errorBanner = await evaluate(
      cdp,
      sessionId,
      `(document.querySelector('.status-error')?.textContent || '').trim()`,
    )
    const viewerLog = consoleMessages.find((entry) => entry.text.includes('Viewer created'))
    const apiCounts = await fetchApiCounts(backend.baseUrl)
    const trafficEntities = 10 // 2 交通灯 + 4 车辆 + 4 路灯（本应用固定创建）

    if (!trafficStatus) failures.push('控制面板上的实时交通读数为空')
    if (errorBanner) failures.push(`页面出现数据加载错误横幅：${errorBanner}`)
    if (!viewerLog) failures.push('没有看到 Viewer 创建成功的日志')
    if (!apiCounts.buildings || !apiCounts.roads) failures.push('后端返回的建筑/道路要素数为 0')
    if (buildingsDiff.differingRatio <= 0) failures.push('隐藏建筑后画面没有任何变化（建筑实体可能没入场景）')
    if (roadsDiff.differingRatio <= 0) failures.push('隐藏道路后画面没有任何变化（道路实体可能没入场景）')
    if (trafficDiff.differingRatio <= 0) failures.push('隐藏交通后画面没有任何变化（交通实体可能没入场景）')
    if (!appReady.appReadyMs) failures.push('应用未就绪')

    const payload = {
      schema: 'smart-city/cesium-runtime-verify/1',
      label: options.label,
      generatedAt: new Date().toISOString(),
      environment: {
        chromeVersion: chrome.version?.Browser || null,
        node: process.version,
        platform: process.platform,
        backend: backend.baseUrl,
        port: options.port,
        cdpPort: options.cdpPort,
      },
      runtimeTree: {
        distCesiumFiles: listFilesRecursive(path.join(options.repoRoot, 'Data-driven-modeling', 'dist', 'Cesium')).length,
      },
      actions,
      observation: {
        cdpEventCount: network.cdpEventCount,
        cdpCesiumFiles: cdpPaths.size,
        resourceTimingCesiumFiles: resourcePaths.size,
        unionCesiumFiles: observed.size,
        workerTargets: network.workerTargets.length,
        failedRequests,
        files: [...observed].sort(),
      },
      pruning: {
        manifest: existsSync(options.manifest) ? options.manifest : null,
        prunedFileCount: prunedSet.size,
        prunedHitCount: pruneHits.length,
        prunedHits: pruneHits,
      },
      app: {
        appReadyMs: appReady.appReadyMs,
        trafficStatus,
        errorBanner,
        viewerCreated: Boolean(viewerLog),
        apiCounts,
        trafficEntityCount: trafficEntities,
        consoleMessages: consoleMessages.slice(0, 40),
        pageErrors,
      },
      screenshots: { canonical: options.screenshot, final: finalShotPath },
      failures,
      passed: failures.length === 0,
    }

    writeFileSync(options.out, JSON.stringify(payload, null, 2), 'utf8')

    process.stdout.write('\n' + '='.repeat(70) + '\n')
    process.stdout.write(`Cesium 运行时裁剪验证（${options.label}）\n`)
    process.stdout.write('='.repeat(70) + '\n')
    process.stdout.write(`实际加载集（两个口径的并集）：${observed.size} 个 Cesium 文件\n`)
    process.stdout.write(
      `  CDP Network ${cdpPaths.size} 个 / 资源计时 ${resourcePaths.size} 个 / worker target ${network.workerTargets.length} 个\n`,
    )
    process.stdout.write(`剪枝清单 ${prunedSet.size} 个文件，其中被请求 ${pruneHits.length} 个\n`)
    process.stdout.write(`失败请求 ${failedRequests.length} 个\n`)
    process.stdout.write(`应用功能：交通读数「${trafficStatus}」/ 建筑 ${apiCounts.buildings} 要素 / 道路 ${apiCounts.roads} 要素\n`)
    process.stdout.write(`截图：${options.screenshot}\n`)
    process.stdout.write(`原始数据：${options.out}\n`)
    if (failures.length) {
      process.stdout.write('\n未通过：\n')
      for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
      if (failedRequests.length) {
        for (const item of failedRequests) {
          process.stdout.write(`    ${item.path} status=${item.status} error=${item.error}\n`)
        }
      }
    } else {
      process.stdout.write('\n全部断言通过。\n')
    }
    return payload.passed ? 0 : 1
  } finally {
    cdp?.close()
    if (chrome) await stopChrome(chrome.child)
    if (backend) await stopBackend(backend.child)
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响结果 */
    }
  }
}

async function fetchApiCounts(baseUrl) {
  const counts = { buildings: 0, roads: 0 }
  try {
    const buildings = await fetch(`${baseUrl}/api/buildings`, { signal: AbortSignal.timeout(30_000) })
    const buildingsJson = await buildings.json()
    counts.buildings = (buildingsJson.features || []).length
  } catch {
    /* 保持 0 */
  }
  try {
    const roads = await fetch(`${baseUrl}/api/roads`, { signal: AbortSignal.timeout(30_000) })
    const roadsJson = await roads.json()
    counts.roads = (roadsJson.features || []).length
  } catch {
    /* 保持 0 */
  }
  return counts
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
if (argv[0] === '--compare') {
  const [a, b] = [argv[1], argv[2]]
  if (!a || !b) {
    console.error('用法：node scripts/verify-cesium-runtime.mjs --compare <a.png> <b.png>')
    process.exit(1)
  }
  const diff = diffPngs(readFileSync(a), readFileSync(b))
  console.log(JSON.stringify({ a, b, ...diff }, null, 2))
  process.exit(diff.comparable ? 0 : 1)
} else {
  const options = parseArgs(argv)
  runVerification(options)
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`验证脚本失败：${error.stack || error.message}\n`)
      process.exit(1)
    })
}
