import { DARK_PALETTE } from './dark'

/**
 * 大屏（16:9 骨架）的**设计 token**。
 *
 * 这个文件只放**尺寸与排版**：圆角、描边宽度、内边距、列宽、行高、
 * 字号阶梯、间距刻度。
 *
 * **颜色不在这里**：颜色一律从 `theme/dark.ts` 的 `DARK_PALETTE` 取
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
  /** 底栏高度（px）。 */
  bottomBarHeight: 150,
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
    barHeight: 14,
    /** 条形图行距。 */
    barGap: 8,
  },
} as const

/**
 * 图表色序 —— **只从 `DARK_PALETTE` 里取**。
 *
 * 蓝 → 青 → 蓝灰 → 预警 → 告警，环形的每一段按这个顺序取色。
 *
 * 这条色序背后的约定（与 `dark.ts` 一致）：
 * **蓝色只做强调与辉光，橙色只做预警，红色只做告警。**
 * 所以色序里没有第四种「装饰色」—— 段位不够时循环取用，而不是另造颜色。
 */
export const CHART_COLORS: readonly string[] = [
  DARK_PALETTE.accent, // 蓝：强调
  DARK_PALETTE.flow, // 青：数据流
  DARK_PALETTE.secondary, // 蓝灰：次级
  DARK_PALETTE.warning, // 橙：预警
  DARK_PALETTE.alert, // 红：告警
]

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
 * 颜色**不在这里**：颜色由 `applyThemeVariables` 从 `DARK_PALETTE` 写进
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

