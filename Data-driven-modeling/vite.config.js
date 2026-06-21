import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
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
    // 暂时移除代理配置，使用直接URL访问
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
  }
})
