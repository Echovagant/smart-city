import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'
import tseslint from 'typescript-eslint'

export default defineConfig([
  {
    name: 'app/files-to-lint',
    files: ['**/*.{js,mjs,jsx,ts,tsx,vue}'],
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

  // ---- TypeScript ----
  //
  // 类型检查由 vue-tsc 负责（npm run typecheck），这里只用**不带类型信息**的
  // recommended 套件——不要两处都做类型感知规则。
  //
  // typescript-eslint 的 base 配置没有 files，会把 TS parser 套到所有文件上
  // （包括 .js 与 .vue）。这里补上 files 限定：只有 TS 文件才用 TS parser。
  //
  // 另外两条带 files 的配置要把 **.vue** 也算进去：
  // eslint-recommended 那条会把核心规则（含 no-undef）对 TS 关掉——
  // .vue 里的 <script lang="ts"> 同样需要：类型名（比如 FrameRequestCallback）
  // 在运行时并不存在，no-undef 会误报；recommended 那条则让 .vue 也受
  // typescript-eslint 的规则约束。
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: config.files ? [...config.files, '**/*.vue'] : ['**/*.ts', '**/*.tsx'],
  })),

  {
    // .vue 仍然由 vue-eslint-parser 解析；<script lang="ts"> 内部要交给
    // TS parser —— vue-eslint-parser 通过 parserOptions.parser 指定内层 parser。
    name: 'app/vue-typescript',
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
])
