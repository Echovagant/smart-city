import { describe, it, expect } from 'vitest'
import {
  DEFAULT_THEME_ID,
  DEEP_SEA,
  DEEP_SPACE,
  GRAPHITE,
  THEMES,
  resolveTheme,
  themeById,
} from '../themes'

describe('主题契约', () => {
  it('三套主题，id 唯一', () => {
    expect(THEMES).toHaveLength(3)
    expect(THEMES.map(theme => theme.id)).toEqual(['deep-space', 'graphite', 'deep-sea'])
    expect(new Set(THEMES.map(theme => theme.id)).size).toBe(THEMES.length)
  })

  it('默认主题是深空蓝', () => {
    expect(DEFAULT_THEME_ID).toBe('deep-space')
    expect(themeById(DEFAULT_THEME_ID)).toBe(DEEP_SPACE)
  })

  it('themeById 取不到就回落到默认主题（不返回 null）', () => {
    expect(themeById('graphite')).toBe(GRAPHITE)
    expect(themeById('deep-sea')).toBe(DEEP_SEA)
    expect(themeById('不存在')).toBe(DEEP_SPACE)
    expect(themeById('')).toBe(DEEP_SPACE)
  })

  it('三套主题的形状完全一致（切主题不碰几何）', () => {
    const shape = (theme: typeof DEEP_SPACE) => ({
      palette: Object.keys(theme.palette).sort(),
      roadColors: Object.keys(theme.roadColors).sort(),
      glow: Object.keys(theme.glow).sort(),
    })
    expect(shape(GRAPHITE)).toEqual(shape(DEEP_SPACE))
    expect(shape(DEEP_SEA)).toEqual(shape(DEEP_SPACE))
  })
})

describe('resolveTheme —— 主题 + 覆盖 → 最终配色', () => {
  it('没有覆盖时原样返回主题', () => {
    expect(resolveTheme('graphite')).toBe(GRAPHITE)
    expect(resolveTheme('graphite', {})).toBe(GRAPHITE)
    // 全是 undefined 的覆盖也算「没有覆盖」
    expect(resolveTheme('graphite', { roadMain: undefined })).toBe(GRAPHITE)
  })

  it('覆盖只动它指定的那几项，其余保持主题原值', () => {
    const resolved = resolveTheme('deep-space', { roadMain: '#ff00ff' })
    expect(resolved.roadColors.main).toBe('#ff00ff')
    expect(resolved.roadColors.secondary).toBe(DEEP_SPACE.roadColors.secondary)
    expect(resolved.palette.building).toBe(DEEP_SPACE.palette.building)
    expect(resolved.glow).toEqual(DEEP_SPACE.glow)
    // 不改原主题
    expect(DEEP_SPACE.roadColors.main).not.toBe('#ff00ff')
  })

  it('建筑色 / 辉光强度 / 路面不透明度都能覆盖', () => {
    const resolved = resolveTheme('deep-space', {
      building: '#123456',
      glowPower: 0.42,
      roadAlpha: 0.5,
    })
    expect(resolved.palette.building).toBe('#123456')
    expect(resolved.glow.roadPower).toBe(0.42)
    expect(resolved.glow.roadAlpha).toBe(0.5)
  })

  it('覆盖**动不了**语义色（橙 / 红是语义线）', () => {
    // 运行时守卫：哪怕有人手改存盘塞进 warning / alert，也不生效
    const resolved = resolveTheme('deep-space', {
      warning: '#000000',
      alert: '#000000',
    } as never)
    expect(resolved.palette.warning).toBe(DEEP_SPACE.palette.warning)
    expect(resolved.palette.alert).toBe(DEEP_SPACE.palette.alert)
  })

  it('图表色序不随覆盖变（6 档整体插值，不是逐档乱调）', () => {
    const resolved = resolveTheme('deep-space', { roadMain: '#ff00ff' })
    expect(resolved.palette.chartSeries).toEqual(DEEP_SPACE.palette.chartSeries)
  })
})

describe('语义色锁定', () => {
  it('三套主题的 warning / alert 完全一致', () => {
    expect(GRAPHITE.palette.warning).toBe(DEEP_SPACE.palette.warning)
    expect(DEEP_SEA.palette.warning).toBe(DEEP_SPACE.palette.warning)
    expect(GRAPHITE.palette.alert).toBe(DEEP_SPACE.palette.alert)
    expect(DEEP_SEA.palette.alert).toBe(DEEP_SPACE.palette.alert)
  })

  it('图表 6 档里没有橙红（分类不是告警）', () => {
    for (const theme of THEMES) {
      expect(theme.palette.chartSeries).not.toContain(theme.palette.warning)
      expect(theme.palette.chartSeries).not.toContain(theme.palette.alert)
    }
  })
})
