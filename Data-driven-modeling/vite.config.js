/// <reference types="vitest" />
import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [
    vue(),
    ...(mode !== 'test' ? [vueDevTools()] : []),
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
    // 后端端口来自 backend-python/.env 的 PORT，默认 8001。
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8001',
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
    sourcemap: true,
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
  },
}))
