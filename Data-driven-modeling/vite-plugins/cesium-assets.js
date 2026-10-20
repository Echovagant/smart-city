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
// build 阶段：closeBundle 后把同样的目录拷贝到 dist/Cesium/。
//
// 用法（vite.config.js）：
//   import cesiumAssets from './vite-plugins/cesium-assets.js'
//   plugins: [vue(), cesiumAssets()]
import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join, normalize, sep, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReadStream } from 'node:fs'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'

const CESIUM_BUILD_DIR = resolve(
  fileURLToPath(new URL('../node_modules/cesium/Build/Cesium', import.meta.url)),
)

const CESIUM_SUBDIRS = ['Workers', 'ThirdParty', 'Assets', 'Widgets']

const DEV_MOUNT = '/Cesium'

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
  return {
    name: 'cesium-assets',
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
    // build: closeBundle 后复制到 dist/Cesium/
    closeBundle() {
      const outBase = resolve(
        dirname(this.info?.config?.build?.outDir || 'dist'),
      )
      const outDir = join(outBase, 'Cesium')
      for (const sub of CESIUM_SUBDIRS) {
        const src = join(CESIUM_BUILD_DIR, sub)
        const dest = join(outDir, sub)
        if (existsSync(src)) {
          copyDirSync(src, dest)
          console.log(`[cesium-assets] copied ${sub}/ -> ${dest}`)
        }
      }
    },
  }
}
