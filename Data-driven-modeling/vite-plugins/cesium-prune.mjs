// Cesium 运行时静态可达性分析器。
//
// Cesium 的运行时文件（Workers/ThirdParty/Assets/Widgets）一共只有 4 种加载方式，
// 全部能从打包产物 dist/assets/cesium-*.js 里挖出来：
//
//   1. 路径字面量    rn("Assets/Textures/waterNormalsSmall.jpg")
//   2. 模板串        rn(`Assets/Textures/maki/${name}.png`)
//   3. 目录字面量    rn("Assets/Textures/NaturalEarthII")   ← 没有尾斜杠，其下文件全部可达
//   4. worker 名     new si("decodeDraco")                  ← 裸名，前缀 "Workers/" 是独立常量
//
// 两个必须记住的坑：
//   - minify 之后 buildModuleUrl 变成 rn，**不能按函数名匹配**，只能按字符串内容匹配。
//   - worker 名是**裸名**，"Workers/" 前缀在 bundle 里只出现一次，
//     按完整路径 "Workers/xxx.js" 搜一个都搜不到。
//
// 产物：
//   - analyzeCesiumRuntime()  纯函数：bundle + 运行时目录 → 可达/不可达分类
//   - buildManifest()          分类 → 可 review 的剪枝清单
//   - applyManifest()          按清单删文件 + 生成构建产物里的排查报告
//
// 本文件同时是一个 CLI：node vite-plugins/cesium-prune.mjs [--write]

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

/** Cesium 运行时的四个顶层目录（与 vite-plugins/cesium-assets.js 的拷贝范围一致）。 */
export const RUNTIME_DIRS = ['Workers', 'ThirdParty', 'Assets', 'Widgets']

const JS_EXT = '.js'
const WORKERS_DIR = 'Workers'

// ---------------------------------------------------------------------------
// bundle 词法：抽字符串字面量
// ---------------------------------------------------------------------------

/**
 * 抽出 bundle 里的所有「引号字符串字面量」与「模板字符串」。
 *
 * 实现要点：minify 后的 bundle 里，GLSL 着色器源码是以模板字符串内嵌的，
 * 里面既有 ${...} 也有成对的引号。所以不能简单地全局正则扫引号 ——
 * 那会把着色器里的 " 当成字符串开头，把后面真正的字面量吞掉。
 * 这里改成手写扫描器：识别注释、单/双引号字符串、模板串（含 ${} 嵌套）。
 *
 * 正则字面量（/.../）无法在不引入完整 JS parser 的前提下可靠区分，
 * 这里按「/ 前一个有效字符不是标识符/数字/)/]/}」的经典启发式跳过；
 * 跳错的唯一后果是可能漏掉极少量字面量。漏掉的字面量只会让某个文件
 * 被误判成「不可达」，所以剪枝的兜底由运行时实测提供
 * （scripts/verify-cesium-runtime.mjs）。
 */
export function lexBundle(text) {
  const quoted = new Set()
  const templates = []

  let i = 0
  const n = text.length
  let prevMeaningful = ''

  const isRegexPosition = () => {
    if (!prevMeaningful) return true
    return !/[A-Za-z0-9_$)\]}]/.test(prevMeaningful)
  }

  while (i < n) {
    const c = text[i]

    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (c === '/' && isRegexPosition()) {
      let j = i + 1
      let inClass = false
      let closed = false
      while (j < n) {
        const ch = text[j]
        if (ch === '\\') {
          j += 2
          continue
        }
        if (ch === '\n') break
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) {
          closed = true
          break
        }
        j += 1
      }
      if (closed) {
        prevMeaningful = '/'
        i = j + 1
        continue
      }
    }
    if (c === '"' || c === "'") {
      const quote = c
      let j = i + 1
      let value = ''
      while (j < n) {
        if (text[j] === '\\') {
          value += text[j + 1] ?? ''
          j += 2
          continue
        }
        if (text[j] === quote) break
        value += text[j]
        j += 1
      }
      quoted.add(value)
      prevMeaningful = quote
      i = j + 1
      continue
    }
    if (c === '`') {
      const parts = []
      let j = i + 1
      let lit = ''
      while (j < n) {
        const ch = text[j]
        if (ch === '\\') {
          lit += text[j] + (text[j + 1] ?? '')
          j += 2
          continue
        }
        if (ch === '`') break
        if (ch === '$' && text[j + 1] === '{') {
          parts.push({ kind: 'lit', text: lit })
          lit = ''
          let depth = 1
          let k = j + 2
          const exprStart = k
          while (k < n && depth > 0) {
            const e = text[k]
            if (e === '"' || e === "'") {
              const q = e
              k += 1
              while (k < n && text[k] !== q) {
                if (text[k] === '\\') k += 1
                k += 1
              }
            } else if (e === '{') depth += 1
            else if (e === '}') {
              depth -= 1
              if (depth === 0) break
            }
            k += 1
          }
          parts.push({ kind: 'expr', text: text.slice(exprStart, k) })
          j = k + 1
          continue
        }
        lit += ch
        j += 1
      }
      templates.push(parts)
      // 模板串的 ${...} 表达式里可能还藏着真正的路径字面量。
      // 例：NavigationHelp 的 HTML 模板里有 rn("Widgets/Images/NavigationHelp/MouseLeft.svg")，
      // 这 9 个 SVG 只有把表达式里的字面量挖出来才算「静态可达」。
      for (const part of parts) {
        if (part.kind !== 'expr') continue
        const inner = lexBundle(part.text)
        for (const value of inner.quoted) quoted.add(value)
        for (const tpl of inner.templates) templates.push(tpl)
      }
      prevMeaningful = '`'
      i = j + 1
      continue
    }

    prevMeaningful = c
    i += 1
  }

  return { quoted, templates }
}

// ---------------------------------------------------------------------------
// 运行时文件树
// ---------------------------------------------------------------------------

/**
 * 递归列出运行时目录下的所有文件（返回 posix 风格的相对路径 + 字节数）。
 *
 * 只走那四个顶层目录 —— Cesium 的 Build/Cesium 根目录下还有 Cesium.js / index.cjs /
 * index.js 三个文件，它们**不会**被拷进 dist/Cesium，剪枝清单里也不该出现它们。
 */
export function listRuntimeFiles(runtimeRoot, subdirs = RUNTIME_DIRS) {
  const files = []
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(abs, rel)
      else files.push({ path: rel, bytes: statSync(abs).size, abs })
    }
  }
  for (const sub of subdirs) walk(join(runtimeRoot, sub), sub)
  return files
}

// ---------------------------------------------------------------------------
// 可达性分析
// ---------------------------------------------------------------------------

function reachabilityOf(rel, ctx) {
  if (ctx.quoted.has(rel)) return { reachable: true, reason: '路径字面量精确命中' }

  for (const dir of ctx.dirLiterals) {
    if (rel.startsWith(dir + '/')) return { reachable: true, reason: `目录字面量 "${dir}" 的子文件` }
  }

  for (const prefix of ctx.templatePrefixes) {
    if (rel.startsWith(prefix)) return { reachable: true, reason: `模板串静态前缀 "${prefix}"` }
  }

  if (rel.startsWith(WORKERS_DIR + '/') && rel.endsWith(JS_EXT)) {
    const bare = rel.slice(WORKERS_DIR.length + 1, -JS_EXT.length)
    if (ctx.quoted.has(bare)) return { reachable: true, reason: `worker 裸名 "${bare}"` }
  }

  return { reachable: false, reason: '四种加载机制均未命中' }
}

/**
 * 分析 Cesium 运行时的静态可达性。
 *
 * @param {object} options
 * @param {string} options.bundlePath  打包产物里的 cesium-*.js
 * @param {string} options.runtimeRoot dist/Cesium 目录
 */
export function analyzeCesiumRuntime({ bundlePath, runtimeRoot }) {
  const bundleText = readFileSync(bundlePath, 'utf8')
  const { quoted, templates } = lexBundle(bundleText)
  const files = listRuntimeFiles(runtimeRoot)

  const dirLiterals = new Set()
  const templatePrefixes = new Set()

  for (const literal of quoted) {
    if (!literal.includes('/')) continue
    if (literal.endsWith('/')) continue
    if (files.some((f) => f.path.startsWith(literal + '/'))) dirLiterals.add(literal)
  }

  for (const parts of templates) {
    if (!parts.some((p) => p.kind === 'expr')) continue
    let prefix = ''
    for (const part of parts) {
      if (part.kind === 'expr') break
      prefix += part.text
    }
    if (prefix) templatePrefixes.add(prefix)
  }

  const ctx = { quoted, dirLiterals, templatePrefixes }

  const perFile = new Map()
  for (const file of files) perFile.set(file.path, { ...file, ...reachabilityOf(file.path, ctx) })

  // worker 的相对 import 闭包
  // 说明：Cesium 的 worker 之间有两种引用
  //   静态：import{a as k}from"./chunk-XXX.js";
  //   动态：{"./combineGeometry.js":()=>import("./combineGeometry.js"), ...}
  // 两者都被 relativeImportsOf 覆盖。
  const importsOf = new Map()
  const importClosure = new Map()

  const directImports = (path) => {
    if (!importsOf.has(path)) {
      const abs = join(runtimeRoot, ...path.split('/'))
      const specs = existsSync(abs) ? relativeImportsOf(readFileSync(abs, 'utf8')) : []
      importsOf.set(path, specs)
    }
    return importsOf.get(path)
  }

  const resolveSpec = (fromPath, spec) =>
    posix.normalize(posix.join(posix.dirname(fromPath), spec))

  // 深度优先：一个 worker 的闭包 = 它直接 import 的文件 + 这些文件的闭包
  const visit = (path, closure) => {
    if (closure.has(path)) return
    closure.add(path)
    for (const spec of directImports(path)) {
      const resolved = resolveSpec(path, spec)
      const target = perFile.get(resolved)
      if (target && !target.reachable) {
        target.reachable = true
        target.reason = `由 "${path}" 的 import 引入`
      }
      visit(resolved, closure)
    }
  }

  const seeds = []
  for (const file of perFile.values()) {
    if (file.reachable && file.path.startsWith(WORKERS_DIR + '/') && file.path.endsWith(JS_EXT)) {
      seeds.push(file.path)
    }
  }
  for (const seed of seeds) {
    const closure = new Set()
    visit(seed, closure)
    importClosure.set(seed, closure)
  }

  const reachable = []
  const unreachable = []
  for (const file of perFile.values()) {
    if (file.reachable) reachable.push(file)
    else unreachable.push(file)
  }

  const sumBytes = (list) => list.reduce((acc, item) => acc + item.bytes, 0)

  return {
    bundlePath,
    runtimeRoot,
    cesiumVersion: readCesiumVersion(runtimeRoot),
    stats: {
      total: files.length,
      totalBytes: sumBytes(files),
      reachable: reachable.length,
      reachableBytes: sumBytes(reachable),
      unreachable: unreachable.length,
      unreachableBytes: sumBytes(unreachable),
    },
    reachable: reachable.map((f) => ({ path: f.path, bytes: f.bytes, reason: f.reason })),
    unreachable: unreachable.map((f) => ({ path: f.path, bytes: f.bytes, reason: f.reason })),
    dirLiterals: [...dirLiterals].sort(),
    templatePrefixes: [...templatePrefixes].filter((p) => p.includes('/')).sort(),
    workerSeeds: [...importClosure.keys()].sort(),
    importClosure,
  }
}

/**
 * 抽出一个 JS 文件里的**静态** import 说明符（./x.js / ../y.js）。
 *
 * 注意 Cesium 的 worker 是 minify 过的，import 语句长这样：
 *     import{a as k}from"./chunk-XXX.js";
 *     import"./chunk-XXX.js";
 * 也就是 `from` 前面**没有空格**（`}from`），用 `import\s*...from\s*` 这种
 * 常规写法会一个都匹配不上 —— 这是分析器最容易踩的坑。
 *
 * 这里直接按「带引号的相对路径字面量」来收：在 Cesium 的 worker 里，
 * 相对路径字面量只可能出现在 import / 动态 import 里。
 *
 * **但动态 import 不算可达边**。Workers/createGeometry.js 里有一张动态 import 映射表：
 *     {"./combineGeometry.js":()=>import("./combineGeometry.js"), ...}
 * 表里列了 Cesium 全部几何 worker。把它算成可达边，会把
 * createCircleGeometry / createSphereGeometry 这些「本应用根本不会创建的几何」
 * 也算成可达，静态不可达集合就会从 49 个缩到 41 个 —— 与基线对不上。
 * 动态 import 是**按需**发生的：只有真的创建那种几何时才会去 import，
 * 所以它在语义上等价于「静态不可达，直到有人真的用它」。
 *
 * 因此先把 import(...) 的内容挖掉，再按相对路径字面量收静态 import。
 */
function relativeImportsOf(text) {
  const specs = new Set()
  const re = /["'](\.{1,2}\/[^"']+)["']/g
  let m
  while ((m = re.exec(text)) !== null) {
    // 只认「紧跟在 import / from 后面」的说明符。
    // 这样动态 import 映射表的键（形如 {"./x.js":()=>import("./x.js")}）
    // 会被排除掉 —— 键的前面是 { 或 ,，不是 import / from。
    const before = text.slice(Math.max(0, m.index - 12), m.index)
    if (!/(?:^|[^A-Za-z0-9_$])(?:import|from)\s*$/.test(before)) continue
    specs.add(m[1])
  }
  return [...specs]
}

/** 从运行时目录旁边的 node_modules 里读出 Cesium 版本。 */
function readCesiumVersion(runtimeRoot) {
  const candidates = [
    resolve(runtimeRoot, '..', '..', '..', 'node_modules', 'cesium', 'package.json'),
    resolve(runtimeRoot, '..', '..', 'node_modules', 'cesium', 'package.json'),
    resolve(runtimeRoot, '..', '..', '..', '..', 'node_modules', 'cesium', 'package.json'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, 'utf8')).version ?? null
      } catch {
        return null
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// T2 分组规则
// ---------------------------------------------------------------------------

/**
 * T2 分组规则。每一组是一个「本应用未启用的 Cesium 特性」，
 * 剪不剪由 enabled 决定（验证不过就置 false，整组保留）。
 */
export const T2_GROUPS = [
  {
    id: 'G1',
    name: 'IAU2006_XYS 极轴定向表',
    rule: '**实测被加载**（IAU2006_XYS_18.json，按当前历元选中的那张表）⇒ 整组保留',
    enabledByDefault: false,
    match: (path) => path.startsWith('Assets/IAU2006_XYS/'),
  },
  {
    id: 'G2',
    name: 'ThirdParty 3D Tiles / splats 解码器',
    rule: 'Draco / KTX2 / Basis / splats 的 wasm，只服务 3D Tiles 与 splats；本应用只加载 GeoJSON',
    enabledByDefault: true,
    match: (path) =>
      path === 'ThirdParty/draco_decoder.wasm' ||
      path === 'ThirdParty/basis_transcoder.wasm' ||
      path === 'ThirdParty/wasm_splats_bg.wasm' ||
      path === 'ThirdParty/zip-module.wasm' ||
      path === 'ThirdParty/Workers/zip-web-worker.js' ||
      path === 'ThirdParty/Workers/package.json' ||
      path === 'ThirdParty/google-earth-dbroot-parser.js',
  },
  {
    id: 'G3',
    name: 'maki 地点标注图标',
    rule: 'maki 是 Cesium 自带的点标注图标集；本应用没有任何点标注',
    enabledByDefault: true,
    match: (path) => path.startsWith('Assets/Textures/maki/'),
  },
  {
    id: 'G4',
    name: 'NaturalEarthII TMS 底图',
    rule: 'TMS 底图瓦片；本应用底图是高德 UrlTemplateImageryProvider',
    enabledByDefault: true,
    match: (path) => path.startsWith('Assets/Textures/NaturalEarthII/'),
  },
  {
    id: 'G5',
    name: 'SkyBox 天空盒',
    rule: '**实测被加载**（相机转到地平线以上时 6 张 tycho2t3_80_*.jpg 全部加载）⇒ 整组保留',
    enabledByDefault: false,
    match: (path) => path.startsWith('Assets/Textures/SkyBox/'),
  },
  {
    id: 'G7',
    name: 'Widgets/Images 里本应用用不到的图标',
    rule: '底图选择器 / 地形选择器 / 时间轴的图标；本应用 baseLayerPicker: false、timeline: false，这些 widget 根本不构造。NavigationHelp 的 9 个 SVG 必须保留（NavigationHelpButton 会用）',
    enabledByDefault: true,
    match: (path) =>
      path.startsWith('Widgets/Images/') && !path.startsWith('Widgets/Images/NavigationHelp/'),
  },
]

// ---------------------------------------------------------------------------
// 剪枝清单
// ---------------------------------------------------------------------------

/**
 * 仓库根目录。本文件在 `<repo>/Data-driven-modeling/vite-plugins/` 下，
 * 所以仓库根是它的上两级 —— 从模块自身推导，不依赖调用方传参。
 */
function repoRoot() {
  return resolve(fileURLToPath(new URL('../..', import.meta.url)))
}

/**
 * 把绝对路径表达成**仓库相对**路径（正斜杠）。
 *
 * 为什么必须是仓库相对：清单是**入库**的。写绝对路径会
 *   1) 把本机用户名与目录结构带进仓库；
 *   2) 把 worktree 路径（`.worktrees/c1/…`）写死，别的机器上根本不存在；
 *   3) 每次重新生成清单这一行都会变 —— 即使剪枝内容一个字节都没变，
 *      diff 里也凭空多出一行噪音，削弱「清单是可 review 的事实」这个卖点。
 *
 * 拿不到仓库相对表达（路径不在仓库内）就返回 null —— 与其写一个错的绝对路径，
 * 不如承认「这一项写不了」。
 */
function repoRelativePath(absolutePath) {
  if (!absolutePath) return null
  const rel = relative(repoRoot(), absolutePath)
  if (!rel || rel.startsWith('..') || posix.isAbsolute(rel) || rel.includes(':')) return null
  return rel.replace(/\\/g, '/')
}

/**
 * 把分析结果 + 分组规则变成一份可 review 的剪枝清单。
 *
 * @param {object} analysis analyzeCesiumRuntime() 的结果
 * @param {object} options
 * @param {Record<string, boolean>} options.enabled     T2 分组的开关
 * @param {string[]} options.observedLoaded            运行时实测加载过的文件（不能剪）
 */
export function buildManifest(analysis, options = {}) {
  const enabled = options.enabled ?? {}
  const observedLoaded = new Set(options.observedLoaded ?? [])

  const t1Files = analysis.unreachable.map((f) => f.path)
  const t1Bytes = analysis.unreachable.reduce((acc, f) => acc + f.bytes, 0)

  const sizeOf = (path) => {
    const found =
      analysis.reachable.find((f) => f.path === path) || analysis.unreachable.find((f) => f.path === path)
    return found ? found.bytes : 0
  }

  const groups = {}
  for (const group of T2_GROUPS) {
    const hits = analysis.reachable.filter((f) => group.match(f.path)).map((f) => f.path)
    groups[group.id] = {
      name: group.name,
      rule: group.rule,
      enabled: enabled[group.id] ?? group.enabledByDefault,
      files: hits,
      bytes: hits.reduce((acc, path) => acc + sizeOf(path), 0),
    }
  }

  // --- G6：worker + 独占 chunk -------------------------------------------
  const g6 = computeG6(analysis, { observedLoaded })
  groups.G6 = g6

  // --- 汇总 ---------------------------------------------------------------
  const pruneSet = new Set(t1Files)
  for (const group of Object.values(groups)) {
    if (!group.enabled) continue
    for (const path of group.files) pruneSet.add(path)
  }
  // 实测加载过的文件一律不剪（双保险）
  for (const path of observedLoaded) pruneSet.delete(path)

  const allPaths = [...analysis.reachable, ...analysis.unreachable].map((f) => f.path)
  const kept = allPaths.filter((p) => !pruneSet.has(p)).sort()

  const generatedFrom = repoRelativePath(analysis.bundlePath)

  return {
    schema: 'smart-city/cesium-runtime-manifest/1',
    // 仓库相对路径（拿不到就不写这个字段，绝不写绝对路径）
    ...(generatedFrom ? { generatedFrom } : {}),
    cesiumVersion: analysis.cesiumVersion,
    layers: {
      T1: {
        rule: '静态不可达：四种加载机制（路径字面量 / 模板串 / 目录字面量 / worker 裸名 + import 闭包）全部不命中',
        files: t1Files,
        bytes: t1Bytes,
      },
      T2: {
        rule: '静态可达，但属本应用未启用的 Cesium 特性；逐组剪、逐组验证；验证不过的整组保留',
        groups,
      },
    },
    kept: {
      count: kept.length,
      bytes: kept.reduce((acc, path) => acc + sizeOf(path), 0),
      files: kept,
    },
    prune: {
      count: pruneSet.size,
      bytes: [...pruneSet].reduce((acc, path) => acc + sizeOf(path), 0),
      files: [...pruneSet].sort(),
    },
  }
}

/**
 * G6：剪掉「运行时实测从未加载」的 worker，以及**只被这些 worker 引用**的 chunk。
 *
 * 判据有三条，缺一不可：
 *   a) 静态可达（静态不可达的由 T1 负责）；
 *   b) **运行时实测从未加载**（scripts/verify-cesium-runtime.mjs 跑完 10 个交互
 *      动作后的实际加载集里没有它）；
 *   c) 不在任何**被保留** worker 的 import 闭包里。
 *
 * 为什么「实测未加载」就等于「用不到」：
 *   Cesium 的 worker 只有两种被拉起来的方式 ——
 *     · 裸名出现在 bundle 里（TaskProcessor 的构造参数），加载与否取决于特性有没有被用；
 *     · createGeometry.js 里的动态 import 映射表，只有真的创建那种几何时才会 import。
 *   本应用只创建 Polygon（建筑）、Box / Cylinder（交通图元）、GroundPolyline（道路），
 *   其余几何类型与 3D Tiles / 地形 / 向量瓦片 / splats / I3S / GoogleEarth 的 worker
 *   实测从未被请求过。
 *
 * 关键约束（最容易踩）：
 *   1. 剪掉的 worker 不能出现在任何**被保留** worker 的 import 闭包里；
 *   2. 只有**独占**于被剪 worker 的 chunk 才能一起剪 —— 共享 chunk 必须保留。
 */
function computeG6(analysis, { observedLoaded }) {
  const workerPaths = analysis.reachable
    .filter((f) => f.path.startsWith(WORKERS_DIR + '/') && f.path.endsWith(JS_EXT))
    .map((f) => f.path)

  // 实测加载过的 worker 一律保留
  const keptWorkers = workerPaths.filter((p) => observedLoaded.has(p))
  const keptClosure = new Set()
  for (const worker of keptWorkers) {
    for (const dep of analysis.importClosure.get(worker) ?? []) keptClosure.add(dep)
  }

  const prunedSet = new Set()
  const prunedWorkers = []
  const exclusiveChunks = []
  for (const worker of workerPaths) {
    if (observedLoaded.has(worker)) continue
    // 被保留 worker 的闭包里出现过的 worker 不能剪（保守优先）
    if (keptClosure.has(worker)) continue
    prunedWorkers.push(worker)
    prunedSet.add(worker)
    for (const dep of analysis.importClosure.get(worker) ?? []) {
      if (keptClosure.has(dep)) continue
      if (observedLoaded.has(dep)) continue
      if (!prunedSet.has(dep)) exclusiveChunks.push(dep)
      prunedSet.add(dep)
    }
  }

  const sizeOf = (path) => {
    const found =
      analysis.reachable.find((f) => f.path === path) || analysis.unreachable.find((f) => f.path === path)
    return found ? found.bytes : 0
  }

  const files = [...prunedSet].sort()
  return {
    name: '运行时实测从未加载的 worker（未启用的特性 + 用不到的几何类型）',
    rule:
      '静态可达、但跑完 10 个交互动作后实测从未被请求的 worker；' +
      '它们要么服务于本应用未启用的特性（3D Tiles / Draco / KTX2 / splats / 量化地形 / 向量瓦片 / I3S / GoogleEarth），' +
      '要么是只有真的创建那种几何时才会被 createGeometry.js 动态 import 的几何 worker' +
      '（本应用只创建 Polygon / Box / Cylinder / GroundPolyline）。' +
      '只被这些 worker 引用的 chunk 一并剪掉；被任何实测加载过的 worker 引用的 chunk 一律保留。',
    enabled: true,
    workers: prunedWorkers,
    exclusiveChunks: exclusiveChunks.sort(),
    files,
    bytes: files.reduce((acc, path) => acc + sizeOf(path), 0),
  }
}

// ---------------------------------------------------------------------------
// 执行剪枝
// ---------------------------------------------------------------------------

/**
 * 按清单删掉运行时文件，并生成构建产物里的排查报告。
 */
export function applyManifest({ runtimeRoot, manifest }) {
  const pruned = []
  const missing = []
  let prunedBytes = 0
  for (const rel of manifest.prune.files) {
    const abs = join(runtimeRoot, ...rel.split('/'))
    if (!existsSync(abs)) {
      missing.push(rel)
      continue
    }
    prunedBytes += statSync(abs).size
    rmSync(abs, { force: true })
    pruned.push(rel)
  }
  pruneEmptyDirs(runtimeRoot)

  const remaining = listRuntimeFiles(runtimeRoot)
  const keptPaths = new Set(manifest.kept.files)
  const unexpected = remaining.filter((f) => !keptPaths.has(f.path)).map((f) => f.path)
  const missingKept = [...keptPaths].filter((p) => !remaining.some((f) => f.path === p))

  return {
    pruned: pruned.length,
    prunedBytes,
    missing,
    remaining: remaining.length,
    remainingBytes: remaining.reduce((acc, f) => acc + f.bytes, 0),
    unexpected,
    missingKept,
    files: pruned,
  }
}

function pruneEmptyDirs(root) {
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const abs = join(root, entry.name)
    pruneEmptyDirs(abs)
    if (readdirSync(abs).length === 0) rmSync(abs, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function frontendDir() {
  return resolve(fileURLToPath(new URL('..', import.meta.url)))
}

function findBundle(distDir) {
  const assetsDir = join(distDir, 'assets')
  if (!existsSync(assetsDir)) return null
  const name = readdirSync(assetsDir).find((f) => f.startsWith('cesium-') && f.endsWith('.js'))
  return name ? join(assetsDir, name) : null
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2)
  const get = (flag, fallback) => {
    const index = args.indexOf(flag)
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback
  }
  const distDir = resolve(get('--dist', join(frontendDir(), 'dist')))
  // 分析对象是**未经剪枝的原始运行时**（node_modules/cesium/Build/Cesium），
  // 不是 dist/Cesium —— 后者已经被上一次构建剪过一轮，拿它分析会得到退化结果。
  const runtimeRoot = resolve(
    get('--runtime', join(frontendDir(), 'node_modules', 'cesium', 'Build', 'Cesium')),
  )
  const bundlePath = findBundle(distDir)
  if (!bundlePath) {
    console.error('找不到 dist/assets/cesium-*.js，先跑 npm run build')
    process.exit(1)
  }
  const analysis = analyzeCesiumRuntime({ bundlePath, runtimeRoot })
  console.log('Cesium 版本 :', analysis.cesiumVersion)
  console.log('运行时目录 :', runtimeRoot)
  console.log('运行时文件  :', analysis.stats.total, '个 /', analysis.stats.totalBytes, '字节')
  console.log('静态可达    :', analysis.stats.reachable, '个 /', analysis.stats.reachableBytes, '字节')
  console.log('静态不可达  :', analysis.stats.unreachable, '个 /', analysis.stats.unreachableBytes, '字节')
  console.log('\n--- 静态不可达清单 ---')
  for (const file of analysis.unreachable) console.log('  ', file.path, file.bytes)

  if (args.includes('--write')) {
    const out = resolve(get('--out', join(frontendDir(), 'cesium-runtime-manifest.json')))
    const observedFile = get('--observed', null)
    if (!observedFile || !existsSync(observedFile)) {
      // G6（实测未加载的 worker）的判据**完全依赖**运行时观测集。
      // 少了它，剪枝会把所有 worker 都当成「没用过」—— 清单会被写坏。
      // 所以这里直接拒绝写，而不是默默产出一份过度剪枝的清单。
      console.error(
        '\n要写清单必须给 --observed <实际加载集文件>（每行一个 Cesium 运行时相对路径）。\n' +
          '  产出方式：node scripts/verify-cesium-runtime.mjs --label before --no-build\n' +
          '  然后从 .acceptance/cesium-runtime-before.json 的 observation.files 取出来。\n' +
          '  没有它就无法判定 G6，清单会被写坏 —— 已中止。',
      )
      process.exit(1)
    }
    const observedLoaded = readFileSync(observedFile, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
    const manifest = buildManifest(analysis, { observedLoaded })
    writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    console.log('\n清单已写入', out)
    console.log('剪', manifest.prune.count, '个 /', manifest.prune.bytes, '字节')
    console.log('留', manifest.kept.count, '个 /', manifest.kept.bytes, '字节')
  }
}
