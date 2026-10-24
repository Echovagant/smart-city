import { describe, it, expect } from 'vitest'
import {
  CLAY,
  DEFAULT_THEME_ID,
  DEEP_SEA,
  DEEP_SPACE,
  GRAPHITE,
  THEMES,
  resolveTheme,
  themeById,
} from '../themes'

describe('主题契约', () => {
  it('四套主题，id 唯一', () => {
    expect(THEMES).toHaveLength(4)
    // 顺序即界面里的展示顺序，第一个是默认主题（哑光白模）。
    expect(THEMES.map(theme => theme.id)).toEqual(['clay', 'deep-space', 'graphite', 'deep-sea'])
    expect(new Set(THEMES.map(theme => theme.id)).size).toBe(THEMES.length)
  })

  it('哑光白模：建筑比道路亮，权重与其它主题相反', () => {
    const clay = themeById('clay')
    // 建筑是主体：对地面的对比度要明显高于道路
    const luminance = (hex: string): number => {
      const value = hex.replace('#', '')
      const channel = (index: number): number => {
        const c = parseInt(value.slice(index, index + 2), 16) / 255
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
    }
    const contrast = (a: string, b: string): number => {
      const la = luminance(a)
      const lb = luminance(b)
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
    }
    // 建筑 vs 地面 > 4.5:1（建筑体块自己就说话）
    expect(contrast(clay.palette.building, clay.palette.screen)).toBeGreaterThan(4.5)
    // 道路 vs 建筑 > 2:1（道路退到建筑后面）
    expect(contrast(clay.roadColors.main, clay.palette.building)).toBeGreaterThan(2)
    // 流动光效层压得很淡（它是全场最刺眼的元素）
    expect(clay.glow.flowAlpha).toBeLessThan(0.2)
    // 描边与界面强调色分开
    expect(clay.palette.buildingEdge).not.toBe(clay.palette.accent)
  })

  it('默认主题是哑光白模', () => {
    expect(DEFAULT_THEME_ID).toBe('clay')
    expect(themeById(DEFAULT_THEME_ID)).toBe(CLAY)
  })

  it('themeById 取不到就回落到默认主题（不返回 null）', () => {
    expect(themeById('graphite')).toBe(GRAPHITE)
    expect(themeById('deep-sea')).toBe(DEEP_SEA)
    expect(themeById('不存在')).toBe(CLAY)
    expect(themeById('')).toBe(CLAY)
  })

  it('四套主题的形状完全一致（切主题不碰几何）', () => {
    const shape = (theme: typeof DEEP_SPACE) => ({
      palette: Object.keys(theme.palette).sort(),
      roadColors: Object.keys(theme.roadColors).sort(),
      glow: Object.keys(theme.glow).sort(),
      fog: Object.keys(theme.fog).sort(),
    })
    expect(shape(GRAPHITE)).toEqual(shape(DEEP_SPACE))
    expect(shape(DEEP_SEA)).toEqual(shape(DEEP_SPACE))
    expect(shape(CLAY)).toEqual(shape(DEEP_SPACE))
  })

  it('深度雾：far 必须大于 near，回落段为正，强度在 0~1 之间', () => {
    for (const theme of THEMES) {
      expect(theme.fog.far).toBeGreaterThan(theme.fog.near)
      expect(theme.fog.near).toBeGreaterThan(0)
      expect(theme.fog.falloff).toBeGreaterThan(0)
      expect(theme.fog.strength).toBeGreaterThan(0)
      expect(theme.fog.strength).toBeLessThanOrEqual(1)
    }
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
