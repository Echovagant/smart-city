import { getActiveTheme } from './dark'
import type { ThemeDefinition } from './themes/types'

/**
 * 大屏（16:9 骨架）的**设计 token**。
 *
 * 这个文件只放**尺寸与排版**：圆角、描边宽度、内边距、列宽、行高、
 * 字号阶梯、间距刻度。
 *
 * **颜色不在这里**：颜色一律从 `theme/dark.ts` 的色板取
 * （大屏的颜色是「视觉的唯一事实来源」这条约定的一部分）。
 * 组件与样式表都不许就地写颜色。
 */

/** 大屏的尺寸与排版 token。 */
export const DASHBOARD_TOKENS = {
  /** 面板圆角（px）。深色大屏用小圆角，与直角科技风一致。 */
  radius: 2,
  /** 面板描边宽度（px）。 */
  borderWidth: 1,
  /** 面板内边距（px）。 */
  padding: 12,
  /** 左右两列的宽度（px）。 */
  columnWidth: 340,
  /** 顶栏高度（px）。 */
  topBarHeight: 96,
  /** 底栏高度（px）。底栏是**通栏**（顶栏 / 左列 / 右列 / 底栏四块）。 */
  bottomBarHeight: 160,
  /** 间距刻度（px）：面板之间、卡片之间的间距都用它。 */
  gap: 12,
  /** 字号阶梯（px）。 */
  fontSize: {
    /** 大屏标题。 */
    title: 22,
    /** 面板标题。 */
    panelTitle: 13,
    /** 指标名 / 轴标签。 */
    label: 11,
    /** 指标值。 */
    value: 24,
    /** 来源小字。 */
    small: 10,
  },
  /** 图表的画布尺寸（px，SVG viewBox 用）。 */
  chart: {
    /** 折线图画布高。 */
    lineHeight: 120,
    /** 折线图画布宽。 */
    lineWidth: 300,
    /** 环形图画布边长。 */
    donutSize: 120,
    /** 环形图环宽。 */
    donutStroke: 16,
    /** 条形图单条高度。 */
    barHeight: 12,
    /** 条形图行距。 */
    barGap: 5,
  },
} as const

/**
 * 图表色序 —— **随当前主题变**。
 *
 * 这条色序背后的约定（与 `dark.ts` 一致）：
 * **蓝色只做强调与辉光，橙色只做预警，红色只做告警。**
 *
 * 所以分类图表（环形图 / 条形图）**一档橙红都不能有** ——
 * 「历史建筑」「人行道」这类普通分类画成橙色，看图的人会读成一条告警。
 * 橙与红只留给 severity：拥堵徽标、事件流的严重度、S3 的告警脉冲环。
 *
 * 6 段正好够用（空气质量页的环形图有 6 项污染物），不需要循环复用。
 *
 * ## 它是「活数组」，不是写死的常量
 *
 * 换主题时**就地改写内容**（不换对象），于是
 * `import { CHART_COLORS }` 的老调用点不用改也能拿到当前主题的色序；
 * 同时它仍然反映当前主题 —— 不是模块加载那一刻定死的快照。
 */
export const CHART_COLORS: string[] = [...getActiveTheme().palette.chartSeries]

/** 把活数组同步到给定主题（`useTheme` 在主题变化时调）。 */
export const syncChartColors = (theme: ThemeDefinition): void => {
  const next = theme.palette.chartSeries
  CHART_COLORS.length = next.length
  next.forEach((color, index) => {
    CHART_COLORS[index] = color
  })
}

/** 取当前主题的图表色序（函数形式 —— 不依赖导入时的快照）。 */
export const chartColors = (): readonly string[] => CHART_COLORS

/** 取第 n 段的颜色（按色序循环）。 */
export const chartColor = (index: number): string =>
  CHART_COLORS[index % CHART_COLORS.length]

/**
 * 把大屏 token 写进 CSS 自定义属性。
 *
 * 与 `dark.ts` 的 `applyThemeVariables`（颜色）配套：
 * 组件样式表里写的是 `var(--dc-xxx, 兜底值)` —— JS 没跑起来时也有兜底值，
 * 不会因为缺变量而整块塌掉。
 *
 * 颜色**不在这里**：颜色由 `applyThemeVariables` 从主题写进
 * `--dc-*`，两边的变量名不重叠。
 */
export const applyDashboardVariables = (target?: HTMLElement): void => {
  const root = target ?? document.documentElement
  if (!root?.style) return
  const style = root.style
  const t = DASHBOARD_TOKENS
  style.setProperty('--dc-panel-radius', `${t.radius}px`)
  style.setProperty('--dc-panel-border-width', `${t.borderWidth}px`)
  style.setProperty('--dc-panel-padding', `${t.padding}px`)
  style.setProperty('--dc-panel-gap', `${t.gap}px`)
  style.setProperty('--dc-column-width', `${t.columnWidth}px`)
  style.setProperty('--dc-topbar-height', `${t.topBarHeight}px`)
  style.setProperty('--dc-bottom-height', `${t.bottomBarHeight}px`)
  style.setProperty('--dc-title-size', `${t.fontSize.title}px`)
  style.setProperty('--dc-panel-title-size', `${t.fontSize.panelTitle}px`)
  style.setProperty('--dc-label-size', `${t.fontSize.label}px`)
  style.setProperty('--dc-value-size', `${t.fontSize.value}px`)
  style.setProperty('--dc-panel-small-size', `${t.fontSize.small}px`)
  style.setProperty('--dc-chart-line-width', `${t.chart.lineWidth}px`)
  style.setProperty('--dc-chart-line-height', `${t.chart.lineHeight}px`)
  style.setProperty('--dc-chart-donut-size', `${t.chart.donutSize}px`)
  style.setProperty('--dc-chart-donut-stroke', `${t.chart.donutStroke}px`)
  style.setProperty('--dc-chart-bar-height', `${t.chart.barHeight}px`)
  style.setProperty('--dc-chart-bar-gap', `${t.chart.barGap}px`)
}
