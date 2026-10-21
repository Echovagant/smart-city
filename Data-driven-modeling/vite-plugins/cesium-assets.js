// Vite plugin: serve & copy Cesium static assets (Workers, ThirdParty, Assets, Widgets).
//
// Cesium 用 window.CESIUM_BASE_URL (默认 "/Cesium/") 通过 buildModuleUrl
// 解析 worker 路径，例如 /Cesium/Workers/createVerticesFromHeightmap.js。
// Vite dev server 默认不 serve /Cesium/* 路径（会返回 index.html 兜底），
// 导致 worker 加载失败 ("Failed to load module script: text/html")。
//
// dev 阶段：中间件把 /Cesium/* 直接以文件 mime 映射回
//   node_modules/cesium/Build/Cesium/*
// 关键:不能走 server.transformRequest —— Vite 会把 .json 当 ES module 转译,
// 返回 "export const ..." 字符串,但 Cesium 内部 fetchJson 会 JSON.parse 它,
// 抛 "Unexpected token 'e' in export def..."。
// build 阶段：closeBundle 后把同样的目录拷贝到 dist/Cesium/，
//              再按入库的剪枝清单把「本应用永远用不到」的文件删掉。
//
// 剪枝（Plan C1）
// --------------
//   清单：Data-driven-modeling/cesium-runtime-manifest.json（入库，可 review、可 diff）
//   逃生舱：环境变量 CESIUM_RUNTIME=full → 一个都不剪，dist/Cesium 保持完整的 380 个文件。
//   自检：剪完后的实际文件集合必须与清单的 kept 集合一致，不一致直接让构建失败
//         （说明 Cesium 版本变了但清单没重新生成 —— 这时候必须重新生成清单，而不是
//          让一个悄悄多出来的文件混进产物）。
//
// 用法（vite.config.js）：
//   import cesiumAssets from './vite-plugins/cesium-assets.js'
//   plugins: [vue(), cesiumAssets()]
import { copyFileSync, mkdirSync, existsSync, readdirSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join, normalize, sep, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import process from 'node:process'
import { applyManifest } from './cesium-prune.mjs'

const CESIUM_BUILD_DIR = resolve(
  fileURLToPath(new URL('../node_modules/cesium/Build/Cesium', import.meta.url)),
)

const CESIUM_SUBDIRS = ['Workers', 'ThirdParty', 'Assets', 'Widgets']

const DEV_MOUNT = '/Cesium'

/** 入库的剪枝清单。 */
const RUNTIME_MANIFEST = resolve(
  fileURLToPath(new URL('../cesium-runtime-manifest.json', import.meta.url)),
)

/** 构建产物里的排查报告（写进 dist/Cesium/ 里，排查时一眼能看到剪了什么）。 */
const PRUNE_REPORT_NAME = 'pruned-manifest.json'

/** 逃生舱：CESIUM_RUNTIME=full → 不剪。 */
function pruningDisabled() {
  return (process.env.CESIUM_RUNTIME || '').toLowerCase() === 'full'
}

// 根据扩展名返回正确的 Content-Type。
// Cesium 内部 fetchJson 会检查 Content-Type 含 "application/json" 来决定
// 是否走 JSON.parse 路径；返回 text/html / application/javascript 都会被
// 识别为非 JSON 失败,或者被错误地 JSON.parse。Assets/Textures/* 是图片。
function mimeFor(filePath) {
  const ext = extname(filePath).toLowerCase()
  switch (ext) {
    case '.js':
    case '.mjs':
      return 'application/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.wasm':
      return 'application/wasm'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.svg':
      return 'image/svg+xml'
    case '.webp':
      return 'image/webp'
    case '.ico':
      return 'image/x-icon'
    case '.ktx2':
      return 'image/ktx2'
    case '.basis':
      return 'image/basis'
    case '.woff':
    case '.woff2':
      return 'font/' + (ext === '.woff2' ? 'woff2' : 'woff')
    case '.ttf':
      return 'font/ttf'
    case '.otf':
      return 'font/otf'
    case '.glb':
      return 'model/gltf-binary'
    case '.kml':
      return 'application/vnd.google-earth.kml+xml'
    case '.geojson':
      return 'application/geo+json'
    default:
      return 'application/octet-stream'
  }
}

function copyDirSync(src, dest) {
  if (!existsSync(src)) return
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry)
    const destPath = join(dest, entry)
    const s = statSync(srcPath)
    if (s.isDirectory()) {
      copyDirSync(srcPath, destPath)
    } else {
      copyFileSync(srcPath, destPath)
    }
  }
}

export default function cesiumAssets(options = {}) {
  const mount = options.mount || DEV_MOUNT
  // build.outDir 必须在 configResolved 里捕获：Rollup/Vite 插件上下文没有
  // this.info 这个字段，旧代码用 this.info?.config?.build?.outDir 永远得到
  // undefined，退化成 resolve(dirname('dist')) === 项目根目录，把 Cesium 资源
  // 写到了 <project>/Cesium/ 而不是 <project>/dist/Cesium/。
  let resolvedOutDir = null
  return {
    name: 'cesium-assets',
    configResolved(config) {
      resolvedOutDir = config.build.outDir
    },
    // dev: 中间件把 /Cesium/<sub>/<file> 直接以文件形式返回。
    // 不能用 server.transformRequest —— 它会按 JS module 转译 .json。
    configureServer(server) {
      server.middlewares.use(mount, async (req, res, next) => {
        try {
          const url = req.url || '/'
          const [pathPart] = url.split('?')
          const safeRel = normalize(pathPart).replace(/^[/\\]+/, '')
          if (safeRel.includes('..')) {
            res.statusCode = 400
            return res.end('bad path')
          }
          const filePath = join(CESIUM_BUILD_DIR, safeRel)
          const resolved = normalize(filePath)
          if (
            resolved !== CESIUM_BUILD_DIR &&
            !resolved.startsWith(CESIUM_BUILD_DIR + sep)
          ) {
            res.statusCode = 403
            return res.end('forbidden')
          }
          if (!existsSync(resolved) || !statSync(resolved).isFile()) {
            res.statusCode = 404
            return res.end(`cesium asset not found: ${safeRel}`)
          }
          // 关键:直接以原始文件返回,设置正确的 Content-Type 和 Cache-Control。
          // 用 stream + 正确的 mime,而不是 transformRequest (会按 JS module 转译)。
          res.setHeader('Content-Type', mimeFor(resolved))
          res.setHeader('Cache-Control', 'public, max-age=3600')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.statusCode = 200
          await pipeline(createReadStream(resolved), res)
        } catch (e) {
          next(e)
        }
      })
    },
    // build: closeBundle 后复制到 dist/Cesium/，再按清单剪枝
    closeBundle() {
      const outBase = resolve(resolvedOutDir || 'dist')
      const outDir = join(outBase, 'Cesium')
      // 先清空：dist/Cesium 完全由这个插件拥有。
      // 不清的话，上一版 Cesium 残留的文件会混进产物，让「产物 == 清单」的自检失真。
      rmSync(outDir, { recursive: true, force: true })
      for (const sub of CESIUM_SUBDIRS) {
        const src = join(CESIUM_BUILD_DIR, sub)
        const dest = join(outDir, sub)
        if (existsSync(src)) {
          copyDirSync(src, dest)
          console.log(`[cesium-assets] copied ${sub}/ -> ${dest}`)
        }
      }
      pruneRuntime(outDir)
    },
  }
}

/**
 * 按入库的剪枝清单裁掉 dist/Cesium 里本应用永远用不到的文件。
 *
 * 逃生舱：CESIUM_RUNTIME=full → 一个都不剪。
 */
function pruneRuntime(outDir) {
  if (pruningDisabled()) {
    console.log('[cesium-assets] CESIUM_RUNTIME=full → 不剪枝，dist/Cesium 保持完整运行时')
    return
  }
  if (!existsSync(RUNTIME_MANIFEST)) {
    console.warn(
      `[cesium-assets] 找不到剪枝清单 ${RUNTIME_MANIFEST}，本次不剪枝。` +
        '生成方式：node vite-plugins/cesium-prune.mjs --write',
    )
    return
  }

  const manifest = JSON.parse(readFileSync(RUNTIME_MANIFEST, 'utf8'))
  const report = applyManifest({ runtimeRoot: outDir, manifest })

  // 自检：产物里的文件集合必须与清单的 kept 集合一致。
  const unexpected = report.unexpected.filter((rel) => rel !== PRUNE_REPORT_NAME)
  const missingKept = report.missingKept
  if (unexpected.length || missingKept.length) {
    throw new Error(
      '[cesium-assets] 剪枝结果与清单不一致 —— Cesium 版本或应用功能变了，剪枝清单需要重新生成。\n' +
        `  多出来的文件：${unexpected.slice(0, 10).join(', ')}${unexpected.length > 10 ? ' …' : ''}\n` +
        `  清单里却没有的文件：${missingKept.slice(0, 10).join(', ')}${missingKept.length > 10 ? ' …' : ''}\n` +
        '  重新生成：node vite-plugins/cesium-prune.mjs --write',
    )
  }

  writeFileSync(
    join(outDir, PRUNE_REPORT_NAME),
    JSON.stringify(
      {
        schema: 'smart-city/cesium-prune-report/1',
        generatedAt: new Date().toISOString(),
        cesiumVersion: manifest.cesiumVersion,
        source: manifest.generatedFrom,
        prunedFiles: report.pruned,
        prunedBytes: report.prunedBytes,
        keptFiles: report.remaining,
        keptBytes: report.remainingBytes,
        layers: manifest.layers,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  console.log(
    `[cesium-assets] 剪掉 ${report.pruned} 个文件 / ${report.prunedBytes} 字节，` +
      `dist/Cesium 剩 ${report.remaining} 个 / ${report.remainingBytes} 字节`,
  )
}
