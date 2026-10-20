import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// 本文件只保留**一条**源码文本断言：.glb 资源引用守卫。
//
// 为什么这一条可以合法地读源码文本：「这个字符串永远不许出现」本质上是
// 对文本本身的断言，看不见字符串就没有别的办法测——它守的是
// "public/models/*.glb 根本不存在，一旦有人写了 uri: '/models/x.glb'
//  Cesium 会在运行时静默加载失败" 这类回归。
//
// 其余行为断言一律放在 src/components/__tests__/SmartCity.lifecycle.test.js，
// 那里有唯一的 Cesium mock，直接 mount 组件后断言可观察效果。
//
// 路径解析说明：这里不能用 `new URL('../components/SmartCity.vue', import.meta.url)`。
// jsdom 环境下的全局 URL 是 jsdom 的 whatwg-url 实现，它不把 file: 当作
// "特殊协议"，会把 file: 基准下的相对路径解析成 http://localhost:3000/...，
// 导致 fileURLToPath 抛 "The URL must be of scheme file"。
// 直接对 import.meta.url 本身做 fileURLToPath 就绕开了这个问题。
const componentPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../components/SmartCity.vue',
)
const source = readFileSync(componentPath, 'utf-8')

describe('SmartCity.vue asset wiring', () => {
  it('does not reference any .glb asset (primitives only)', () => {
    expect(source).not.toMatch(/uri:\s*['"]\/models\/[^'"]+\.glb['"]/)
  })
})
