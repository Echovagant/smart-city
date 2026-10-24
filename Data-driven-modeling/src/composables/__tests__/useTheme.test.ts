import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CLAY, DEFAULT_THEME_ID, GRAPHITE } from '@/theme/themes'
import { CHART_COLORS, chartColor } from '@/theme/dashboard'
import { THEME_STORAGE_KEY, useTheme } from '../useTheme'

beforeEach(() => {
  window.localStorage.clear()
  const controller = useTheme()
  controller.setTheme(DEFAULT_THEME_ID)
  controller.resetOverrides()
})

describe('useTheme —— 主题控制器', () => {
  it('是模块级单例：两次调用拿到同一份状态', () => {
    const a = useTheme()
    const b = useTheme()
    expect(a.themeId).toBe(b.themeId)
    expect(a.overrides).toBe(b.overrides)
    expect(a.theme).toBe(b.theme)
  })

  it('默认主题是哑光白模', () => {
    const { themeId, theme } = useTheme()
    expect(themeId.value).toBe(DEFAULT_THEME_ID)
    expect(theme.value.id).toBe('clay')
  })

  it('setTheme 换主题（解析结果跟着变）', () => {
    const { themeId, theme, setTheme } = useTheme()
    setTheme('graphite')
    expect(themeId.value).toBe('graphite')
    expect(theme.value.id).toBe('graphite')
    expect(theme.value.palette.screen).toBe(GRAPHITE.palette.screen)
  })

  it('setTheme 遇到未知 id 直接忽略（保持当前主题）', () => {
    const { themeId, setTheme } = useTheme()
    setTheme('graphite')
    setTheme('不存在')
    expect(themeId.value).toBe('graphite')
  })

  it('setTheme **不清覆盖**（用户覆盖跨主题保留）', () => {
    const { setTheme, setOverride, theme } = useTheme()
    setOverride('roadMain', '#ff00ff')
    setTheme('graphite')
    expect(theme.value.roadColors.main).toBe('#ff00ff')
  })

  it('setOverride 设置一项覆盖，undefined 清除这一项', () => {
    const { overrides, setOverride, theme } = useTheme()
    setOverride('building', '#123456')
    expect(overrides.value.building).toBe('#123456')
    expect(theme.value.palette.building).toBe('#123456')

    setOverride('building', undefined)
    expect(overrides.value.building).toBeUndefined()
    expect(theme.value.palette.building).toBe(CLAY.palette.building)
  })

  it('setOverride 拒绝语义色与图表色（白名单只有四项）', () => {
    const { overrides, setOverride } = useTheme()
    setOverride('warning' as never, '#000000')
    setOverride('alert' as never, '#000000')
    setOverride('chartSeries' as never, ['#000000'] as never)
    expect(Object.keys(overrides.value)).toEqual([])
  })

  it('resetOverrides 清掉所有覆盖', () => {
    const { overrides, setOverride, resetOverrides, theme } = useTheme()
    setOverride('roadMain', '#ff00ff')
    setOverride('glowPower', 0.3)
    resetOverrides()
    expect(overrides.value).toEqual({})
    expect(theme.value.roadColors.main).toBe(CLAY.roadColors.main)
    expect(theme.value.glow.roadPower).toBe(CLAY.glow.roadPower)
  })
})

describe('useTheme —— CSS 变量', () => {
  it('首次调用就把主题写进 CSS 变量', () => {
    useTheme()
    expect(document.documentElement.style.getPropertyValue('--dc-screen')).toBe(
      CLAY.palette.screen,
    )
    expect(document.documentElement.style.getPropertyValue('--dc-accent')).toBe(
      CLAY.palette.accent,
    )
  })

  it('换主题后 CSS 变量跟着换', () => {
    const { setTheme } = useTheme()
    setTheme('graphite')
    expect(document.documentElement.style.getPropertyValue('--dc-screen')).toBe(
      GRAPHITE.palette.screen,
    )
    expect(document.documentElement.style.getPropertyValue('--dc-flow')).toBe(
      GRAPHITE.palette.flow,
    )
  })

  it('改覆盖后 CSS 变量也跟着变（建筑色是 CSS 变量之一）', () => {
    const { setOverride } = useTheme()
    setOverride('building', '#123456')
    expect(document.documentElement.style.getPropertyValue('--dc-building')).toBe('#123456')
  })
})

describe('useTheme —— 图表色序随主题变', () => {
  it('CHART_COLORS 不再是导入时定死的快照', () => {
    const { setTheme } = useTheme()
    setTheme('graphite')
    expect(CHART_COLORS).toEqual([...GRAPHITE.palette.chartSeries])
    expect(chartColor(0)).toBe(GRAPHITE.palette.chartSeries[0])
  })
})

describe('useTheme —— 持久化', () => {
  it('换主题与改覆盖都会写进 localStorage', () => {
    const { setTheme, setOverride } = useTheme()
    setTheme('graphite')
    setOverride('roadMain', '#ff00ff')
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!)).toEqual({ id: 'graphite', overrides: { roadMain: '#ff00ff' } })
  })

  it('刷新后仍然保持（重新加载模块 → 从 localStorage 恢复）', async () => {
    const { setTheme, setOverride } = useTheme()
    setTheme('graphite')
    setOverride('roadMain', '#ff00ff')

    // 模拟刷新：重置模块缓存，重新 import → 新的模块级单例
    vi.resetModules()
    const reloaded = await import('../useTheme')
    const controller = reloaded.useTheme()
    expect(controller.themeId.value).toBe('graphite')
    expect(controller.overrides.value).toEqual({ roadMain: '#ff00ff' })
    expect(controller.theme.value.roadColors.main).toBe('#ff00ff')
  })

  it('localStorage 里是坏 JSON 时回落到默认主题（不抛）', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, '{ 这不是 JSON')
    vi.resetModules()
    const reloaded = await import('../useTheme')
    const controller = reloaded.useTheme()
    expect(controller.themeId.value).toBe(DEFAULT_THEME_ID)
    expect(controller.overrides.value).toEqual({})
  })

  it('localStorage 里是未知主题 id / 脏覆盖时也能安全恢复', async () => {
    window.localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({ id: '不存在', overrides: { roadMain: 42, glowPower: 'x', alert: '#000' } }),
    )
    vi.resetModules()
    const reloaded = await import('../useTheme')
    const controller = reloaded.useTheme()
    expect(controller.themeId.value).toBe(DEFAULT_THEME_ID)
    expect(controller.overrides.value).toEqual({})
  })
})
