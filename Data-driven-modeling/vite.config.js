/// <reference types="vitest" />
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import cesiumAssets from './vite-plugins/cesium-assets.js'

// 后端端口的唯一来源是 backend-python/.env 的 PORT；读不到时回落到 8000。
const DEFAULT_BACKEND_PORT = 8000
const BACKEND_ENV_FILE = fileURLToPath(new URL('../backend-python/.env', import.meta.url))

function readBackendPort() {
  let content
  try {
    content = readFileSync(BACKEND_ENV_FILE, 'utf-8')
  } catch {
    return DEFAULT_BACKEND_PORT
  }
  const match = content.match(/^\s*PORT\s*=\s*(.+?)\s*$/m)
  if (!match) return DEFAULT_BACKEND_PORT
  const port = Number.parseInt(match[1].replace(/^["']|["']$/g, ''), 10)
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_BACKEND_PORT
}

const backendPort = readBackendPort()

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [
    vue(),
    ...(mode !== 'test' ? [vueDevTools()] : []),
    // dev 时 serve /Cesium/Workers/* 等静态资源；build 时 copy 到 dist/Cesium/。
    // 解决 Cesium 内部通过 buildModuleUrl(/Cesium/Workers/...) 加载 worker 时
    // 收到 HTML 兜底页面的问题 ("Failed to load module script: text/html")。
    ...(mode !== 'test' ? [cesiumAssets()] : []),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'cesium': fileURLToPath(new URL('./node_modules/cesium', import.meta.url))
    }
  },
  server: {
    fs: {
      allow: ['.']
    },
    // 开发期把 /api/* 反代到 FastAPI 后端。
    // 端口读取自 backend-python/.env 的 PORT（与后端同一份配置），读不到时回落到 8000。
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${backendPort}`,
        changeOrigin: false,
      },
    },
  },
  // 移除CESIUM_BASE_URL定义，让Cesium自动处理资源路径
  publicDir: 'public',
  optimizeDeps: {
        exclude: ['cesium'],
        include: ['mersenne-twister', 'urijs', 'grapheme-splitter', 'bitmap-sdf', 'lerc', 'nosleep.js']
      },
  build: {
    // 生产构建默认不产出 sourcemap：默认构建的 Vite 产物从 20.5 MB 降到 3.9 MB
    // （约 5.2 倍，省下来的 16.6 MB 全是 .map），并把全部原始源码发布出去。
    // 需要线上排障时用 SOURCEMAP=true npm run build 打开。
    sourcemap: process.env.SOURCEMAP === 'true',
    commonjsOptions: {
      transformMixedEsModules: true
    },
    rollupOptions: {
      output: {
        manualChunks: {
          'cesium': ['cesium']
        }
      }
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/__tests__/**/*.test.{js,ts}'],
    coverage: {
      provider: 'v8',
      // all: true 让「没有被任何测试碰过」的文件也计入分母，
      // 否则覆盖率只反映被测文件、看不到真正的缺口。
      all: true,
      include: ['src/**/*.{js,ts,vue}'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.{js,ts}'],
      reporter: ['text', 'json', 'html'],
      // 覆盖率生成物默认落在 Data-driven-modeling/coverage/（已 gitignore）；
      // 需要把生成物放到仓库外时设 COVERAGE_DIR 环境变量。
      reportsDirectory: process.env.COVERAGE_DIR || 'coverage',
    },
  },
}))
