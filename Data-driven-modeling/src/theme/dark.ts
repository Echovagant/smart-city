import * as Cesium from 'cesium'

/**
 * 深色 3D 数据可视化大屏的**色板与材质工厂**。
 *
 * 这个文件是视觉的唯一事实来源：组件里不再就地写颜色，
 * 全部从这里取。新增颜色或材质时改这里，不要在组件里就地定义。
 *
 * 三条约定
 * --------
 * 1. **蓝色只做强调与辉光**，橙色只做预警，红色只做告警。
 *    不引入紫色渐变，也不做霓虹爆闪。
 * 2. **辉光材质有两条路**：实体（`entity.polyline.material`）收的是
 *    `MaterialProperty`，Primitive 的 appearance 收的是 `Material` ——
 *    两者不是一回事，直接把 `PolylineGlowMaterialProperty` 塞进
 *    Primitive 的 appearance 里，运行时会拿不到 uniforms。
 *    所以下面给两个工厂：实体用 `createGlowMaterial`，
 *    Primitive 用 `createPrimitiveGlowMaterial`（走 `Material.fromType`，
 *    同一份着色器）。
 * 3. **色板同时写进 CSS 自定义属性**（`applyThemeVariables`），
 *    这样面板样式表里的颜色也来自同一份常量，CSS 与 3D 场景不会各写一遍。
 */

/** 色板 —— 深色大屏只认这一份配色。 */
export const DARK_PALETTE = {
  /** 大屏底：地面 / 页面底。 */
  screen: '#050a14',
  /** 面板底：控制面板、卡片。 */
  panel: '#0d1a2e',
  /** 主强调：建筑描边、选中态。 */
  accent: '#165dff',
  /** 数据流：路网辉光、流动光点。 */
  flow: '#22d3ee',
  /** 次级线：次要道路、辅助线。 */
  secondary: '#3b82f6',
  /** 预警：中等级告警。 */
  warning: '#f59e0b',
  /** 告警：严重告警、脉冲点。 */
  alert: '#f43f5e',
  /** 正文：面板文字。 */
  text: '#e2e8f0',
  /** 建筑面：建筑本体（深色）。 */
  building: '#0d1a2e',
  /** 建筑顶面：比本体略亮。 */
  buildingRoof: '#132845',
  /**
   * **图表序列色**（蓝青系 6 档）。
   *
   * 分类图表（环形图 / 条形图）只许用这一组 —— 普通分类**不是告警**：
   * 把「历史建筑 87 处」画成橙色，看图的人会读成一条告警，那是语义级错误。
   *
   * 所以：**橙色只做预警，红色只做告警**，它们留给 severity
   * （拥堵徽标、事件流的严重度、S3 的告警脉冲环），**不进分类图表**。
   *
   * 6 档而不是 5 档：空气质量页的环形图有 6 项污染物
   * （PM2.5 / PM10 / O3 / NO2 / SO2 / CO），6 段用 6 个颜色，不必循环复用。
   */
  chartSeries: ['#165dff', '#3b82f6', '#22d3ee', '#0ea5e9', '#60a5fa', '#7dd3fc'],
} as const

/**
 * 道路分级配色：主干道最亮，人行道最暗。
 *
 * 宽度沿用原来的 14 / 10 / 7 / 4（像素），颜色全部换成深色科技色。
 */
export const ROAD_COLORS = {
  main: '#3b82f6',
  secondary: '#2f6bb0',
  local: '#1f4d85',
  footway: '#16375f',
  /** 兜底分级：highway 标签缺失、或取值不在分级表里。 */
  fallback: '#13305a',
} as const

/** 数字底座的发光网格：压在地面之上一点点，避免与地面 z-fighting。 */
export const GRID_COLOR = DARK_PALETTE.secondary

/** 控制面板的半透明底色（面板底色 + 0.82 不透明度）。 */
export const PANEL_BACKGROUND = 'rgba(13, 26, 46, 0.82)'

/** 面板里更浅一层的底（状态条、数字块）。 */
export const PANEL_SURFACE = 'rgba(5, 10, 20, 0.55)'

/** 交通拥堵的分档色调。 */
export type TrafficTone = 'ok' | 'warn' | 'alert'

/** 把色板里的 CSS 颜色转成 Cesium 颜色。 */
export const cssColor = (hex: string, alpha = 1): Cesium.Color =>
  Cesium.Color.fromCssColorString(hex).withAlpha(alpha)

/**
 * 实体用的辉光材质。
 *
 * `glowPower` 是辉光强度（占线宽的比例，1.0 以下有效）：
 * 中心最亮、往两边渐隐，所以它看上去是「发光的线」而不是「涂了一条线」。
 *
 * **glowPower 必须包成 `ConstantProperty`**：
 * `PolylineGlowMaterialProperty.isConstant` 会问 `Property.isConstant(glowPower)`，
 * 而裸数字没有 `isConstant` 属性 → 判为「非常量」→ Cesium 认定这条线是 *dynamic*
 * → 贴地的线**每帧重建** `GroundPolylinePrimitive`（2260 条路直接把帧率打到 30）。
 * 包成 `ConstantProperty` 之后材质才是常量，贴地几何只建一次。
 */
export const createGlowMaterial = (
  hex: string,
  glowPower = 0.3,
  alpha = 1,
): Cesium.PolylineGlowMaterialProperty =>
  new Cesium.PolylineGlowMaterialProperty({
    color: cssColor(hex, alpha),
    glowPower: new Cesium.ConstantProperty(glowPower),
  })

/**
 * Primitive 用的辉光材质。
 *
 * Primitive 的 appearance 要的是 `Material`，不是 `MaterialProperty`。
 * `Material.fromType('PolylineGlow', …)` 与实体的 `PolylineGlowMaterialProperty`
 * 走的是同一份着色器（`Material.PolylineGlowType`），外观一致。
 */
export const createPrimitiveGlowMaterial = (
  hex: string,
  glowPower = 0.3,
  alpha = 1,
): Cesium.Material =>
  Cesium.Material.fromType('PolylineGlow', {
    color: cssColor(hex, alpha),
    glowPower,
  })

/**
 * 流动光效材质（**Primitive 用**）。
 *
 * Cesium 的 PolylineDash 着色器按**屏幕空间**取相位
 * （`fract(屏幕坐标 / dashLength)`），所以推进 `dashLength`，
 * 虚线段就会沿路面前后跑 —— 这就是「数据流」的观感。
 *
 * 返回的是 `Material`（不是 MaterialProperty）：Primitive 的 appearance 收 Material。
 * 推进相位用 `flowDashLength()` 改 `material.uniforms.dashLength` 即可 ——
 * 渲染器每帧从 `material.uniforms` 读值，所以改了就生效。
 */
export const createFlowDashMaterial = (
  hex: string,
  baseLength: number,
): Cesium.Material =>
  Cesium.Material.fromType('PolylineDash', {
    color: cssColor(hex, 0.95),
    gapColor: Cesium.Color.TRANSPARENT,
    dashLength: baseLength,
    dashPattern: 255,
  })

/**
 * 流动光效当前该有的 dash 长度。
 *
 * 三角波：dashLength 在基准值的 0.6 ~ 1.4 倍之间来回，
 * 虚线段看起来一直在往前跑（而不是原地呼吸）。
 */
export const flowDashLength = (baseLength: number, periodSeconds: number): number => {
  const phase = (performance.now() / 1000 / periodSeconds) % 1
  const wave = phase < 0.5 ? phase * 2 : (1 - phase) * 2
  return baseLength * (0.6 + 0.8 * wave)
}

/**
 * 拥堵分档 → 色调。
 *
 * 优先用拥堵指数（0..1）分档；没有指数时退回中文标签。
 * 畅通=数据流色、轻微拥堵=预警色、拥堵及以上=告警色。
 */
export const resolveTrafficTone = (
  level: number | null,
  label?: string | null,
): TrafficTone => {
  if (level !== null) {
    if (level < 0.25) return 'ok'
    if (level < 0.5) return 'warn'
    return 'alert'
  }
  if (label) {
    if (label.includes('严重')) return 'alert'
    if (label.includes('轻微')) return 'warn'
    if (label.includes('拥堵')) return 'alert'
  }
  return 'ok'
}

/**
 * 把色板写进 CSS 自定义属性，让面板样式表也用同一份常量。
 *
 * 组件样式表里写的是 `var(--dc-xxx, 兜底值)` —— JS 没跑起来时也有兜底值，
 * 不会因为缺变量而整块透明。
 */
export const applyThemeVariables = (target?: HTMLElement): void => {
  const root = target ?? document.documentElement
  if (!root?.style) return
  const style = root.style
  style.setProperty('--dc-screen', DARK_PALETTE.screen)
  style.setProperty('--dc-panel', DARK_PALETTE.panel)
  style.setProperty('--dc-panel-bg', PANEL_BACKGROUND)
  style.setProperty('--dc-panel-surface', PANEL_SURFACE)
  style.setProperty('--dc-accent', DARK_PALETTE.accent)
  style.setProperty('--dc-flow', DARK_PALETTE.flow)
  style.setProperty('--dc-secondary', DARK_PALETTE.secondary)
  style.setProperty('--dc-warning', DARK_PALETTE.warning)
  style.setProperty('--dc-alert', DARK_PALETTE.alert)
  style.setProperty('--dc-text', DARK_PALETTE.text)
  style.setProperty('--dc-building', DARK_PALETTE.building)
}
