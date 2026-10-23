import type { ThemeDefinition, ThemeOverrides } from './types'

/**
 * 三套默认主题。
 *
 * 色值不是随手挑的：每一档都对着背景算过相对亮度（WCAG 亮度比），
 * 目标是「主路网不刺眼、面板文字仍然清晰、语义色保持不变」。
 *
 * 三套的差别只在**色相家族**（蓝 → 中性灰 → 青）与整体亮度，
 * 形状完全一致 —— 所以切主题时不需要碰任何几何。
 */

/** A「深空蓝」：默认主题，收敛版。长时间值守最省眼。 */
export const DEEP_SPACE: ThemeDefinition = {
  id: 'deep-space',
  label: '深空蓝',
  description: '默认。收敛后的蓝青夜幕，适合长时间值守。',
  palette: {
    screen: '#04070f',
    panel: '#0b1526',
    accent: '#1e40af',
    flow: '#0e7490',
    secondary: '#24507f',
    warning: '#f59e0b',
    alert: '#f43f5e',
    text: '#cbd5e1',
    building: '#0b1526',
    buildingRoof: '#101f38',
    chartSeries: ['#1e40af', '#0369a1', '#0e7490', '#2b5fa8', '#38bdf8', '#60a5fa'],
  },
  roadColors: {
    main: '#2b5fa8',
    secondary: '#24507f',
    local: '#1b3f63',
    footway: '#143050',
    fallback: '#122943',
  },
  glow: {
    roadPower: 0.1,
    roadAlpha: 0.78,
    buildingPower: 0.18,
    gridAlpha: 0.12,
  },
}

/** B「石墨灰」：中性低饱和，环境光强 / 白墙投影时用。 */
export const GRAPHITE: ThemeDefinition = {
  id: 'graphite',
  label: '石墨灰',
  description: '中性低饱和，适合明亮环境或投影。',
  palette: {
    screen: '#0a0b0e',
    panel: '#15181e',
    accent: '#4a6fa5',
    flow: '#5b8fa8',
    secondary: '#3c4a5e',
    warning: '#f59e0b',
    alert: '#f43f5e',
    text: '#c8ccd4',
    building: '#15181e',
    buildingRoof: '#1c2027',
    chartSeries: ['#3c4a5e', '#4a6fa5', '#5b8fa8', '#6f7f99', '#7d8ca6', '#8fa3bd'],
  },
  roadColors: {
    main: '#43556e',
    secondary: '#37475c',
    local: '#2b3849',
    footway: '#212c39',
    fallback: '#1b2530',
  },
  glow: {
    roadPower: 0.08,
    roadAlpha: 0.7,
    buildingPower: 0.15,
    gridAlpha: 0.1,
  },
}

/** C「深海青」：冷青夜航风。 */
export const DEEP_SEA: ThemeDefinition = {
  id: 'deep-sea',
  label: '深海青',
  description: '冷青夜航风，偏好冷色时用。',
  palette: {
    screen: '#02090b',
    panel: '#071a20',
    accent: '#0e7490',
    flow: '#0d9488',
    secondary: '#155e75',
    warning: '#f59e0b',
    alert: '#f43f5e',
    text: '#c2d6d8',
    building: '#071a20',
    buildingRoof: '#0c2630',
    chartSeries: ['#155e75', '#0369a1', '#0e7490', '#0d9488', '#2a9d8f', '#3ba7a3'],
  },
  roadColors: {
    main: '#16697a',
    secondary: '#125666',
    local: '#0e4552',
    footway: '#0b3540',
    fallback: '#082830',
  },
  glow: {
    roadPower: 0.1,
    roadAlpha: 0.78,
    buildingPower: 0.18,
    gridAlpha: 0.12,
  },
}

/** 全部可选主题（顺序即界面里的展示顺序）。 */
export const THEMES: readonly ThemeDefinition[] = [DEEP_SPACE, GRAPHITE, DEEP_SEA]

/** 默认主题 id。 */
export const DEFAULT_THEME_ID = 'deep-space'

/** 按 id 取主题；取不到就回落到默认主题（不返回 null）。 */
export const themeById = (id: string): ThemeDefinition =>
  THEMES.find(theme => theme.id === id) ?? DEEP_SPACE

/**
 * 主题 + 用户覆盖 → 最终生效的配色。
 *
 * 覆盖是**局部**的：只改用户动过的那几项，其余保持主题原值。
 * 返回新对象（不改原主题），所以调用方可以安全地拿它去改材质。
 */
export const resolveTheme = (id: string, overrides?: ThemeOverrides): ThemeDefinition => {
  const base = themeById(id)
  if (!overrides) return base
  const hasOverride = Object.values(overrides).some(value => value !== undefined)
  if (!hasOverride) return base
  return {
    ...base,
    palette: {
      ...base.palette,
      building: overrides.building ?? base.palette.building,
    },
    roadColors: {
      ...base.roadColors,
      main: overrides.roadMain ?? base.roadColors.main,
    },
    glow: {
      ...base.glow,
      roadPower: overrides.glowPower ?? base.glow.roadPower,
      roadAlpha: overrides.roadAlpha ?? base.glow.roadAlpha,
    },
  }
}
