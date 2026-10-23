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
    text: '#e0e7f1',
    building: '#0b1526',
    buildingRoof: '#101f38',
    buildingEdge: '#1e40af',
    surface: '#0b1526',
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
    flowAlpha: 0.95,
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
    text: '#e3e7ec',
    building: '#15181e',
    buildingRoof: '#1c2027',
    buildingEdge: '#4a6fa5',
    surface: '#15181e',
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
    flowAlpha: 0.95,
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
    text: '#dcebee',
    building: '#071a20',
    buildingRoof: '#0c2630',
    buildingEdge: '#0e7490',
    surface: '#071a20',
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
    flowAlpha: 0.95,
  },
}

/**
 * C「哑光白模」：**建筑是主体，道路退成底纹**。
 *
 * 解决的是「建筑小道路大」——原来的配色里建筑本体色与地面底几乎同色
 * （对比度 1.10 : 1，建筑面在画面上几乎不可见，只剩一圈描边），
 * 而道路是 14 px 宽的亮线（≈ 21 m 的地面线宽），比 30 m 高的建筑的竖向体量还大。
 *
 * 这一套把权重反转过来：
 * - 建筑本体改成**哑光浅灰**（对地面 6.09 : 1），体块自己就说话；
 * - 道路改成比建筑**暗**的灰阶细线（对建筑 3.07 : 1 → 道路退到后面）；
 * - 描边不发光，只是一道浅色细边（像建模软件里的棱线）；
 * - 流动光效层压到 0.12 —— 保留一点「数据在流动」的提示，不再抢注意力。
 *
 * 地面**保持深色**：浅底白模需要开光照与阴影才有体块感，而本项目关了光照；
 * 深底 + 浅建筑能拿到同样的「建筑是主体」效果，且不与深色面板打架。
 */
export const CLAY: ThemeDefinition = {
  id: 'clay',
  label: '哑光白模',
  description: '建筑是主体，道路退成底纹。无辉光，久看不累。',
  palette: {
    screen: '#0d1117',
    panel: '#101720',
    // 界面强调色仍是蓝：描边用的是 buildingEdge，两者分开。
    accent: '#4a7fb5',
    flow: '#5b6a7d',
    secondary: '#39424f',
    warning: '#f59e0b',
    alert: '#f43f5e',
    text: '#dde3ea',
    building: '#8a93a0',
    buildingRoof: '#98a1ae',
    buildingEdge: '#c3ccd8',
    surface: '#1b222c',
    chartSeries: ['#3f5f80', '#5b7fa6', '#4a6b8c', '#7d9ab8', '#6b8aa8', '#a8bfd2'],
  },
  roadColors: {
    main: '#3d4653',
    secondary: '#333c48',
    local: '#2a323c',
    footway: '#232a33',
    fallback: '#1f252d',
  },
  glow: {
    roadPower: 0.05,
    roadAlpha: 0.9,
    buildingPower: 0.04,
    gridAlpha: 0.04,
    flowAlpha: 0.12,
  },
}

/** 全部可选主题（顺序即界面里的展示顺序）。 */
export const THEMES: readonly ThemeDefinition[] = [DEEP_SPACE, GRAPHITE, DEEP_SEA, CLAY]

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
