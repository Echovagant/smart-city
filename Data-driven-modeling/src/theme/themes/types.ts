/**
 * 主题契约 —— 大屏配色的**唯一事实来源**的类型定义。
 *
 * 主题 = 一整套配色（面板 / 场景 / 道路 / 图表 / 辉光参数），
 * 切换主题时整体换掉；用户还可以在这套配色之上做**局部覆盖**
 * （道路主色 / 建筑色 / 辉光强度 / 路面不透明度）。
 *
 * 这里只定义**形状**，具体色值在 `themes/index.ts` 里。
 *
 * 语义色（warning / alert）**不随主题变**：橙色只做预警、红色只做告警，
 * 这是全项目的一条语义线，换主题不能把它改掉。
 */
export interface ThemePalette {
  /** 大屏底：地面 / 页面底。 */
  screen: string
  /** 面板底：控制面板、卡片。 */
  panel: string
  /** 主强调：建筑描边、选中态。 */
  accent: string
  /** 数据流：路网辉光、流动光点。 */
  flow: string
  /** 次级线：次要道路、辅助线。 */
  secondary: string
  /** 预警：中等级告警。**语义色，不随主题变**。 */
  warning: string
  /** 告警：严重告警、脉冲点。**语义色，不随主题变**。 */
  alert: string
  /** 正文：面板文字。 */
  text: string
  /** 建筑面：建筑本体。 */
  building: string
  /** 建筑顶面：比本体略亮。 */
  buildingRoof: string
  /**
   * 图表序列色（蓝青系 6 档）。
   *
   * 分类图表只许用这一组 —— 普通分类**不是告警**，
   * 把「历史建筑 87 处」画成橙色，看图的人会读成一条告警，那是语义级错误。
   */
  chartSeries: readonly string[]
}

/** 道路分级配色：主干道最亮，人行道最暗。 */
export interface ThemeRoadColors {
  main: string
  secondary: string
  local: string
  footway: string
  /** 兜底分级：highway 标签缺失、或取值不在分级表里。 */
  fallback: string
}

/**
 * 辉光与不透明度参数。
 *
 * **它们必须跟颜色一起进主题**：辉光强度越大，线中心那条白芯越宽 → 看起来越亮。
 * 只换颜色不改它，「换个主题变暗一点」的效果会被白芯抵消掉。
 */
export interface ThemeGlow {
  /** 道路辉光强度（占线宽的比例）。 */
  roadPower: number
  /** 道路线不透明度。 */
  roadAlpha: number
  /** 建筑描边辉光强度。 */
  buildingPower: number
  /** 地面网格线不透明度。 */
  gridAlpha: number
}

/** 一套完整的主题。 */
export interface ThemeDefinition {
  /** 稳定标识（持久化用）。 */
  id: string
  /** 界面上显示的名字。 */
  label: string
  /** 一句话说明这套主题适合什么场景。 */
  description: string
  /** 面板与场景配色。 */
  palette: ThemePalette
  /** 道路分级配色。 */
  roadColors: ThemeRoadColors
  /** 辉光参数。 */
  glow: ThemeGlow
}

/**
 * 用户在主题之上的**局部覆盖**。
 *
 * 只开放这四项：
 * - 道路主色 / 建筑本体色：用户最常改的两个；
 * - 辉光强度 / 路面不透明度：直接对应「太亮」这个诉求。
 *
 * **不开放**语义色（橙 / 红）与图表 6 档 —— 前者会破坏「橙=预警、红=告警」的语义，
 * 后者逐档取色会让 6 档失去可区分性（图表色相应该整体插值，不是逐档乱调）。
 */
export interface ThemeOverrides {
  /** 覆盖道路主色（只改 `main` 档，其余分级保持主题原值）。 */
  roadMain?: string
  /** 覆盖建筑本体色。 */
  building?: string
  /** 覆盖道路辉光强度。 */
  glowPower?: number
  /** 覆盖道路不透明度。 */
  roadAlpha?: number
}
