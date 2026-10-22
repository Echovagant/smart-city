import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import * as Cesium from 'cesium'
import {
  DARK_PALETTE,
  GRID_COLOR,
  PANEL_BACKGROUND,
  ROAD_COLORS,
  applyThemeVariables,
  createFlowDashMaterial,
  createGlowMaterial,
  createPrimitiveGlowMaterial,
  cssColor,
  flowDashLength,
  resolveTrafficTone,
} from '../dark'

beforeAll(() => {
  // jsdom 里没有 ImageBitmap / OffscreenCanvas / VideoFrame，
  // 而 Cesium 构造 Material 时（Material.js 的 getUniformType）会直接
  // `instanceof` 这些类型 → ReferenceError。
  // 补几个空壳类让材质能造出来；断言只关心 type 与 uniforms，不碰位图。
  vi.stubGlobal('ImageBitmap', class ImageBitmapStub {})
  vi.stubGlobal('OffscreenCanvas', class OffscreenCanvasStub {})
  vi.stubGlobal('VideoFrame', class VideoFrameStub {})
})

afterAll(() => {
  vi.unstubAllGlobals()
})

// 本文件直接用**真实的 Cesium**：要断言的就是「glowPower 是不是 ConstantProperty」，
// 用 mock 断言就变成了「断言我自己的 mock」。
describe('深色大屏色板', () => {
  it('色板是计划书定的那一套深色科技色', () => {
    expect(DARK_PALETTE.screen).toBe('#050a14')
    expect(DARK_PALETTE.panel).toBe('#0d1a2e')
    expect(DARK_PALETTE.accent).toBe('#165dff')
    expect(DARK_PALETTE.flow).toBe('#22d3ee')
    expect(DARK_PALETTE.warning).toBe('#f59e0b')
    expect(DARK_PALETTE.alert).toBe('#f43f5e')
    expect(DARK_PALETTE.text).toBe('#e2e8f0')
  })

  it('图表序列色是蓝青系，且一档橙红都没有', () => {
    // 普通分类（人行道 / 历史建筑 / 商业与办公）不是告警 ——
    // 把它们画成橙色，看图的人会读成一条告警。橙/红只留给 severity。
    expect(DARK_PALETTE.chartSeries).toHaveLength(6)
    expect(DARK_PALETTE.chartSeries).not.toContain(DARK_PALETTE.warning)
    expect(DARK_PALETTE.chartSeries).not.toContain(DARK_PALETTE.alert)
    for (const color of DARK_PALETTE.chartSeries) {
      expect(color).toMatch(/^#/)
      // 蓝青系：蓝色分量必须高于红色分量
      const r = parseInt(color.slice(1, 3), 16)
      const b = parseInt(color.slice(5, 7), 16)
      expect(b).toBeGreaterThan(r)
    }
  })

  it('道路四级配色是深色系（主干道最亮，人行道最暗）', () => {
    expect(ROAD_COLORS.main).toBe('#3b82f6')
    expect(ROAD_COLORS.secondary).toBe('#2f6bb0')
    expect(ROAD_COLORS.local).toBe('#1f4d85')
    expect(ROAD_COLORS.footway).toBe('#16375f')
    // 兜底分级必须与其它档位**不同色**，否则「表外 highway」与「人行道」分不开
    expect(ROAD_COLORS.fallback).not.toBe(ROAD_COLORS.footway)
    expect(GRID_COLOR).toBe(DARK_PALETTE.secondary)
    expect(PANEL_BACKGROUND).toContain('rgba(')
  })

  it('cssColor 转出带 alpha 的 Cesium 颜色', () => {
    const color = cssColor('#22d3ee', 0.5)
    expect(color).toBeInstanceOf(Cesium.Color)
    expect(color.alpha).toBeCloseTo(0.5, 5)
    expect(cssColor('#22d3ee').alpha).toBeCloseTo(1, 5)
  })
})

describe('材质工厂', () => {
  it('createGlowMaterial 的 glowPower 必须是 ConstantProperty', () => {
    // **回归测试（帧率 98→30 的根因）**：
    // PolylineGlowMaterialProperty.isConstant 会问 Property.isConstant(glowPower)。
    // 裸数字没有 isConstant 属性 → 判为「非常量」→ Cesium 认定这条线是 dynamic
    // → 贴地的线每帧重建 GroundPolylinePrimitive，2260 条路直接把帧率打到 30。
    // 这里钉住「必须是 ConstantProperty」，将来有人改回裸数字会立刻红。
    const material = createGlowMaterial('#3b82f6', 0.12, 0.9)

    expect(material.glowPower).toBeInstanceOf(Cesium.ConstantProperty)
    expect((material.glowPower as { isConstant: boolean }).isConstant).toBe(true)
    expect(material.glowPower?.getValue()).toBeCloseTo(0.12, 5)

    // 整个材质也必须是常量：颜色（ColorMaterialProperty → ConstantProperty）
    // 与 glowPower 都是常量，材质才判为常量
    expect(material.isConstant).toBe(true)
  })

  it('createGlowMaterial 的颜色就是给的那个色', () => {
    const material = createGlowMaterial('#16375f', 0.12)
    const color = material.color?.getValue()
    expect(color?.red).toBeCloseTo(0x16 / 255, 3)
    expect(color?.green).toBeCloseTo(0x37 / 255, 3)
    expect(color?.blue).toBeCloseTo(0x5f / 255, 3)
  })

  it('createPrimitiveGlowMaterial 造出 PolylineGlow 材质（Primitive 用的是 Material 不是 MaterialProperty）', () => {
    const material = createPrimitiveGlowMaterial('#165dff', 0.25, 0.15)
    expect(material).toBeInstanceOf(Cesium.Material)
    expect(material.type).toBe('PolylineGlow')
    expect(material.uniforms.glowPower).toBeCloseTo(0.25, 5)
    expect(material.uniforms.color.alpha).toBeCloseTo(0.15, 5)
  })

  it('createFlowDashMaterial 造出 PolylineDash 材质：数据流色 + 透明缺口 + 基准 dash 长度', () => {
    const material = createFlowDashMaterial('#22d3ee', 24)
    expect(material).toBeInstanceOf(Cesium.Material)
    expect(material.type).toBe('PolylineDash')
    expect(material.uniforms.dashLength).toBe(24)
    expect(material.uniforms.dashPattern).toBe(255)
    expect(material.uniforms.gapColor.alpha).toBe(0)
    expect(material.uniforms.color.green).toBeGreaterThan(material.uniforms.color.red)
  })
})

describe('flowDashLength —— 流动光效的相位推进', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('随时间推进，返回值始终落在基准值的 0.6~1.4 倍之间', () => {
    vi.useFakeTimers()
    const base = 24
    const period = 6
    for (let second = 0; second < 30; second += 1) {
      vi.setSystemTime(second * 1000)
      const value = flowDashLength(base, period)
      expect(value).toBeGreaterThanOrEqual(base * 0.6)
      expect(value).toBeLessThanOrEqual(base * 1.4)
    }
  })

  it('时间推进时 dash 长度真的会变（不然流动就死了）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const first = flowDashLength(24, 6)
    vi.setSystemTime(1500)
    const second = flowDashLength(24, 6)
    expect(second).not.toBe(first)
  })

  it('一个周期之后回到同一个值（三角波是周期性的）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const first = flowDashLength(24, 6)
    vi.setSystemTime(6000)
    const second = flowDashLength(24, 6)
    // 假定时器下 performance.now() 与系统时间有微小的偏移，放宽到小数点后两位
    expect(second).toBeCloseTo(first, 2)
  })
})

describe('resolveTrafficTone —— 拥堵分档', () => {
  it('按拥堵指数分档：畅通 / 预警 / 告警', () => {
    expect(resolveTrafficTone(0.1, '畅通')).toBe('ok')
    expect(resolveTrafficTone(0.4, '轻微拥堵')).toBe('warn')
    expect(resolveTrafficTone(0.6, '拥堵')).toBe('alert')
    expect(resolveTrafficTone(0.9, '严重拥堵')).toBe('alert')
  })

  it('没有指数时退回中文标签', () => {
    expect(resolveTrafficTone(null, '畅通')).toBe('ok')
    expect(resolveTrafficTone(null, '轻微拥堵')).toBe('warn')
    expect(resolveTrafficTone(null, '严重拥堵')).toBe('alert')
    expect(resolveTrafficTone(null, '拥堵')).toBe('alert')
  })

  it('既没有指数也没有标签时按畅通处理', () => {
    expect(resolveTrafficTone(null, null)).toBe('ok')
    expect(resolveTrafficTone(null, undefined)).toBe('ok')
  })
})

describe('applyThemeVariables —— 把色板写进 CSS 自定义属性', () => {
  it('面板样式表用 var(--dc-*) 就能拿到同一份配色', () => {
    const root = document.createElement('div')
    applyThemeVariables(root)

    expect(root.style.getPropertyValue('--dc-screen')).toBe(DARK_PALETTE.screen)
    expect(root.style.getPropertyValue('--dc-panel')).toBe(DARK_PALETTE.panel)
    expect(root.style.getPropertyValue('--dc-panel-bg')).toBe(PANEL_BACKGROUND)
    expect(root.style.getPropertyValue('--dc-accent')).toBe(DARK_PALETTE.accent)
    expect(root.style.getPropertyValue('--dc-flow')).toBe(DARK_PALETTE.flow)
    expect(root.style.getPropertyValue('--dc-warning')).toBe(DARK_PALETTE.warning)
    expect(root.style.getPropertyValue('--dc-alert')).toBe(DARK_PALETTE.alert)
    expect(root.style.getPropertyValue('--dc-text')).toBe(DARK_PALETTE.text)
  })

  it('不传目标时写到 documentElement 上', () => {
    applyThemeVariables()
    expect(document.documentElement.style.getPropertyValue('--dc-screen')).toBe(DARK_PALETTE.screen)
    // 清掉，别影响别的用例
    document.documentElement.style.removeProperty('--dc-screen')
  })
})
