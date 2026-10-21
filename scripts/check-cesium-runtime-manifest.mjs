#!/usr/bin/env node
/**
 * 检查「构建产物里的 Cesium 运行时」与「入库的剪枝清单」是否一致。
 *
 * 用法
 * ----
 *     node scripts/check-cesium-runtime-manifest.mjs
 *
 * 检查两件事
 * ----------
 *   1. `dist/Cesium/` 里实际存在的文件集合 == 清单的 kept 集合
 *      （`dist/Cesium/pruned-manifest.json` 是构建时写的排查报告，不算运行时文件，排除）。
 *   2. 实际文件数 == 清单里的 kept.count
 *
 * 为什么要在 CI 里做这件事
 * ----------------------
 *   剪枝清单是**入库**的（Data-driven-modeling/cesium-runtime-manifest.json）。
 *   一旦 Cesium 升级、或者应用改了功能，剪枝清单就可能过期 ——
 *   而过期的清单会让构建产物与清单对不上（多一个文件，或少一个文件）。
 *   这一步就是那个「清单过期」的哨兵。
 *
 * 退出码：0 = 一致；1 = 不一致。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = path.join(repoRoot, 'Data-driven-modeling', 'cesium-runtime-manifest.json')
const runtimeRoot = path.join(repoRoot, 'Data-driven-modeling', 'dist', 'Cesium')

/** 构建时写在 dist/Cesium 里的排查报告，不是运行时文件。 */
const REPORT_NAME = 'pruned-manifest.json'

function listRuntimeFiles(root) {
  const files = []
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(abs, rel)
      else files.push(rel)
    }
  }
  walk(root, '')
  return files
}

function main() {
  if (!existsSync(manifestPath)) {
    console.error(`找不到剪枝清单：${manifestPath}`)
    return 1
  }
  if (!existsSync(runtimeRoot)) {
    console.error(`找不到构建产物：${runtimeRoot}（先跑 npm run build）`)
    return 1
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const actual = listRuntimeFiles(runtimeRoot).filter((rel) => rel !== REPORT_NAME)
  const expected = [...(manifest.kept?.files || [])].sort()

  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  const extra = actual.filter((rel) => !expectedSet.has(rel))
  const missing = expected.filter((rel) => !actualSet.has(rel))

  console.log(`剪枝清单        ：${manifestPath}`)
  console.log(`清单 kept 数量  ：${expected.length}`)
  console.log(`产物实际数量    ：${actual.length}`)
  console.log(`剪掉的文件数量  ：${manifest.prune?.count ?? 0}`)

  if (extra.length || missing.length) {
    console.error('\n产物与剪枝清单不一致：')
    if (extra.length) {
      console.error(`  产物里多出来的（清单没说要剪）：${extra.slice(0, 20).join(', ')}`)
    }
    if (missing.length) {
      console.error(`  清单里说该留、产物里却没了：${missing.slice(0, 20).join(', ')}`)
    }
    console.error('\n多半是 Cesium 版本变了或应用功能变了 —— 重新生成清单：')
    console.error('  cd Data-driven-modeling && node vite-plugins/cesium-prune.mjs --write')
    return 1
  }

  if (actual.length !== (manifest.kept?.count ?? actual.length)) {
    console.error(`kept.count 写的是 ${manifest.kept?.count}，实际是 ${actual.length}`)
    return 1
  }

  console.log('\n一致。')
  return 0
}

process.exit(main())
