import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'

export default defineConfig([
  {
    name: 'app/files-to-lint',
    files: ['**/*.{js,mjs,jsx,vue}'],
  },

  globalIgnores([
    '**/dist/**',
    '**/dist-ssr/**',
    '**/coverage/**',
    '**/Cesium/**', // 构建期从 node_modules 复制出来的 Cesium 静态资源，不是源码
  ]),

  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  {
    // Vitest 通过 vite-node 运行时为测试模块注入 __dirname / __filename，
    // 但 ESLint 的 no-undef 看不到它们，这里按测试运行环境补上。
    name: 'app/test-globals',
    files: ['**/__tests__/**/*.{js,mjs,jsx,ts,tsx}', '**/*.{test,spec}.{js,mjs,jsx,ts,tsx}'],
    languageOptions: {
      globals: {
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },

  js.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  skipFormatting,
])
