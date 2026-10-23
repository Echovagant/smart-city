import * as Cesium from 'cesium'
import { DEFAULT_THEME_ID, themeById } from './themes'
import type { ThemeDefinition, ThemePalette, ThemeRoadColors } from './themes/types'

/**
 * 深色 3D 数据可视化大屏的**色板与材质工厂**（主题驱动版）。
 *
 * 这个文件是视觉的唯一事实来源：组件里不再就地写颜色，
 * 全部从这里取。新增颜色或材质时改这里，不要在组件里就地定义。
 *
 * 四条约定
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
 * 4. **颜色来自主题**：本文件里的色板与道路色都是**读取当前主题**的 getter，
 *    不是写死的常量。换主题时改的是主题本身，调用点一行都不用改。
 */

/* ---------------------------------------------------------------------------
 * 当前主题（模块级单例）
 * ------------------------------------------------------------------------- */

/**
 * 当前生效的主题。
 *
 * `useTheme` 是**唯一的写入方**：它维护响应式状态，同时把解析结果写进这里，
 * 于是拿不到 Vue 响应式的地方（材质工厂、组件里的常量引用）也能读到同一份配色。
 */
let activeTheme: ThemeDefinition = themeById(DEFAULT_THEME_ID)

/** 读当前生效的主题。 */
export const getActiveTheme = (): ThemeDefinition => activeTheme

/** 换当前生效的主题（`useTheme` 调用）。 */
export const setActiveTheme = (theme: ThemeDefinition): void => {
  activeTheme = theme
}

/* ---------------------------------------------------------------------------
 * 色板（兼容层：导出名保留，值随主题变）
 * ------------------------------------------------------------------------- */

/**
 * 色板 —— **兼容层**。
 *
 * 以前这是一份写死的常量；现在每个属性都是 getter，读到的永远是
 * **当前主题**的那一份颜色。于是没改成主题驱动的调用点
 * （`LineChart.vue` 的折线色、`useTrafficFleet.ts` 的车身色等）
 * 不用改一行代码也跟着主题走。
 */
export const DARK_PALETTE: ThemePalette = {
  get screen() {
    return activeTheme.palette.screen
  },
  get panel() {
    return activeTheme.palette.panel
  },
  get accent() {
    return activeTheme.palette.accent
  },
  get flow() {
    return activeTheme.palette.flow
  },
  get secondary() {
    return activeTheme.palette.secondary
  },
  get warning() {
    return activeTheme.palette.warning
  },
  get alert() {
    return activeTheme.palette.alert
  },
  get text() {
    return activeTheme.palette.text
  },
  get building() {
    return activeTheme.palette.building
  },
  get buildingRoof() {
    return activeTheme.palette.buildingRoof
  },
  get chartSeries() {
    return activeTheme.palette.chartSeries
  },
}

/**
 * 道路分级配色：主干道最亮，人行道最暗。
 *
 * 宽度沿用原来的 14 / 10 / 7 / 4（像素），颜色全部换成深色科技色。
 */
export const ROAD_COLORS: ThemeRoadColors = {
  get main() {
    return activeTheme.roadColors.main
  },
  get secondary() {
    return activeTheme.roadColors.secondary
  },
  get local() {
    return activeTheme.roadColors.local
  },
  get footway() {
    return activeTheme.roadColors.footway
  },
  get fallback() {
    return activeTheme.roadColors.fallback
  },
}

/** 交通拥堵的分档色调。 */
export type TrafficTone = 'ok' | 'warn' | 'alert'

/** 事件严重度：提示 / 预警 / 告警。 */
export type EventTone = 'info' | 'warn' | 'alert'

/**
 * 事件严重度 → 颜色。
 *
 * 沿用全项目的一条语义线：**蓝色只做强调、橙色只做预警、红色只做告警**。
 * 「提示级」事件（空气质量等级变化）用强调蓝，不占用预警/告警色。
 *
 * 「提示级」跟着主题走（强调色随主题变），橙与红是**语义色，三套主题完全一致**。
 */
export const EVENT_COLORS: Record<EventTone, string> = {
  get info() {
    return activeTheme.palette.accent
  },
  get warn() {
    return activeTheme.palette.warning
  },
  get alert() {
    return activeTheme.palette.alert
  },
}

/* ---------------------------------------------------------------------------
 * 派生色
 * ------------------------------------------------------------------------- */

/** 数字底座的发光网格：压在地面之上一点点，避免与地面 z-fighting。 */
export const gridColor = (): string => activeTheme.palette.secondary

/** 控制面板的半透明底色（面板底色 + 0.82 不透明度）。 */
export const panelBackground = (): string => withAlpha(activeTheme.palette.panel, 0.82)

/** 面板里更浅一层的底（状态条、数字块）。 */
export const panelSurface = (): string => withAlpha(activeTheme.palette.screen, 0.55)

/**
 * 建筑描边「压暗」后的颜色。
 *
 * 页签联动时非焦点建筑的描边要压暗（建筑本体保持可见，保留空间上下文）。
 * 用材质 uniform 就地换色即可 —— **不重建几何，也不去动 3854 个建筑的
 * `polygon.material`**（那会打散 Cesium 的批处理 → 全量几何重建 → 卡死）。
 *
 * 这个色**不随主题变**：它的职责是「退到背景里去」，
 * 三套主题的底色都是深色，同一个深蓝在它们上面都读作「暗」；
 * 变主题时改的是「恢复」那一侧（强调色，见 `DARK_PALETTE.accent`）。
 */
export const BUILDING_GLOW_DIMMED = '#0b2550'

/**
 * 流动光效层在「路网运行」页签下的高亮颜色（比常态更亮）。
 *
 * 同上：它是「提亮」信号色，不随主题变（常态色才是主题色）。
 */
export const FLOW_HIGHLIGHT = '#a5f3fc'

/* ---------------------------------------------------------------------------
 * 颜色工具
 * ------------------------------------------------------------------------- */

/** 把 `#rgb` / `#rrggbb` 解析成 `[r, g, b]`（0~255）；解析不了返回 null。 */
const parseHex = (hex: string): [number, number, number] | null => {
  const value = hex.trim().replace('#', '')
  if (value.length === 3) {
    const [r, g, b] = value.split('')
    return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)]
  }
  if (value.length !== 6) return null
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  if (![r, g, b].every(Number.isFinite)) return null
  return [r, g, b]
}

/** 把 `#rrggbb` 转成 `rgba(r, g, b, a)`（面板的半透明底色要用）。 */
export const withAlpha = (hex: string, alpha: number): string => {
  const rgb = parseHex(hex)
  if (!rgb) return hex
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
}

/** 把色板里的 CSS 颜色转成 Cesium 颜色。 */
export const cssColor = (hex: string, alpha = 1): Cesium.Color =>
  Cesium.Color.fromCssColorString(hex).withAlpha(alpha)

/* ---------------------------------------------------------------------------
 * 材质工厂
 * ------------------------------------------------------------------------- */

/**
 * 实体用的辉光材质。
 *
 * `glowPower` 是辉光强度（占线宽的比例，1.0 以下有效）：
 * 中心最亮、往两边渐隐，所以它看上去是「发光的线」而不是「涂了一条线」。
 *
 * **glowPower 必须包成常量属性**：
 * `PolylineGlowMaterialProperty.isConstant` 会问 `Property.isConstant(glowPower)`，
 * 而裸数字没有 `isConstant` 属性 → 判为「非常量」→ Cesium 认定这条线是 *dynamic*
 * → 贴地的线**每帧重建** `GroundPolylinePrimitive`（2260 条路直接把帧率打到 30）。
 * 包成常量属性之后材质才是常量，贴地几何只建一次。
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
 * 给「活颜色属性」补一个 `name` 读取口。
 *
 * 以前道路材质直接拿裸 `Color` 当颜色，`material.color.name` 就是那个十六进制色值；
 * 改成 CallbackProperty 之后颜色藏在回调里，这个读取口就没了。
 * 补上它，**材质属性的形状与改之前一致**（调试与断言都能直接看到当前色值）。
 */
const withColorName = <T extends object>(property: T, hex: () => string): T => {
  try {
    Object.defineProperty(property, 'name', {
      get: hex,
      configurable: true,
      enumerable: false,
    })
  } catch {
    /* 极端精简的运行时不允许定义属性：不影响功能 */
  }
  return property
}

/**
 * 一份「可原地改值」的辉光材质（道路分级共用一份）。
 *
 * ## 为什么不能直接 `setValue`
 *
 * `ConstantProperty.setValue()` 会 **raise `definitionChanged`**，
 * 于是 `entity.polyline.definitionChanged` → 几何更新器认为这条线变了
 * → **重建这条贴地线**（2260 条路逐条重建 = 帧率崩）。
 * 换掉 `entity.polyline.material` 整个对象更糟：同样触发重建。
 *
 * ## 这里怎么做
 *
 * 用 `CallbackProperty(callback, /* isConstant *\/ true)`：
 * - `isConstant === true` → Cesium 仍认为材质是常量 → **贴地几何只建一次**；
 * - 回调读的是**当前值**，而 Cesium 每帧都会重算材质 uniform
 *   （`MaterialProperty.getValue` → `material.uniforms.color`）
 *   → 改值**下一帧就生效**，不重建任何几何。
 */
export interface LiveGlowMaterial {
  /** 交给 `entity.polyline.material` 的材质对象（全场共用同一个实例）。 */
  material: Cesium.PolylineGlowMaterialProperty
  /** 当前颜色：改它（配套 `setLiveGlow`）就生效。 */
  color: Cesium.Color
  /** 当前颜色的十六进制值（材质属性上以 `name` 暴露）。 */
  hex: string
  /** 当前辉光强度。 */
  glowPower: number
}

/** 造一份可原地改值的辉光材质。 */
export const createLiveGlowMaterial = (
  hex: string,
  glowPower = 0.3,
  alpha = 1,
): LiveGlowMaterial => {
  const handle: LiveGlowMaterial = {
    color: cssColor(hex, alpha),
    hex,
    glowPower,
    material: undefined as unknown as Cesium.PolylineGlowMaterialProperty,
  }
  handle.material = new Cesium.PolylineGlowMaterialProperty({
    color: withColorName(new Cesium.CallbackProperty(() => handle.color, true), () => handle.hex),
    glowPower: new Cesium.CallbackProperty(() => handle.glowPower, true),
  })
  return handle
}

/** 换一份活辉光材质的颜色与辉光强度（**不换材质对象**）。 */
export const setLiveGlow = (
  handle: LiveGlowMaterial,
  hex: string,
  alpha: number,
  glowPower: number,
): void => {
  const next = cssColor(hex, alpha)
  handle.color.red = next.red
  handle.color.green = next.green
  handle.color.blue = next.blue
  handle.color.alpha = next.alpha
  handle.hex = hex
  handle.glowPower = glowPower
}

/**
 * 一份「活颜色材质」—— 让实体的多边形走 `MaterialAppearance`（颜色是**批次级 uniform**）。
 *
 * ## 为什么不用 Cesium 的 `ColorMaterialProperty`
 *
 * `ColorMaterialProperty` 会让 Cesium 走 `PerInstanceColorAppearance`：
 * 颜色是**逐实例顶点属性**，而静态颜色批次只在材质**非常量**时才逐帧刷新它。
 * 那份逐帧刷新是 3855 个实体各查一遍 —— 实测每帧多约 7 ms，
 * 帧率从 80 掉到 48（本机实测，见报告）。
 *
 * 另一条路（把常量颜色的 `ConstantProperty` 用 `setValue` 改掉）更糟：
 * 它会 raise `definitionChanged` → 几何更新器认为这些面变了 →
 * **重建整批多边形的缓冲**（3855 栋楼一次性重传）。
 *
 * ## 这里怎么做
 *
 * 自己实现 Cesium 材质属性要用到的那几个方法（`getType` / `getValue` /
 * `isConstant` / `equals` / `definitionChanged`），让 Cesium 走 `MaterialAppearance`：
 * **颜色变成批次级 uniform** → 换主题 = 改一个颜色对象 →
 * 零逐实体开销，几何也不重建。
 *
 * `getType()` 返回的 `'Color'` 是 **Cesium 自己注册过的材质类型**
 * （`Material._materialCache.addMaterial(Material.ColorType, …)`），
 * 它的半透明判定是「颜色 alpha < 1」——
 * 与本项目「建筑不透明 / 广场半透明」的用法正好一致。
 */
export interface LiveColorMaterial {
  /** 交给 `entity.polygon.material` 的材质属性（全场共用同一个实例）。 */
  material: Cesium.MaterialProperty | null
  /** 当前颜色：材质每帧读它（**就地改分量**，不要换对象）。 */
  color: Cesium.Color
  /** 当前颜色的十六进制值（材质属性上以 `name` 暴露）。 */
  hex: string
}

/** 材质属性的 `definitionChanged`：材质对象从不替换，所以永远不触发。 */
const createMaterialEvent = (): { addEventListener: (...args: unknown[]) => () => void } => {
  try {
    const EventCtor = (
      Cesium as unknown as {
        Event?: new () => { addEventListener: (...args: unknown[]) => () => void }
      }
    ).Event
    if (EventCtor) return new EventCtor()
  } catch {
    /* 精简运行时没有 Event：下面用空实现兜底 */
  }
  return { addEventListener: () => () => {} }
}

/** 造一份可原地改值的颜色材质。 */
export const createLiveColorMaterial = (hex: string, alpha = 1): LiveColorMaterial => {
  const handle: LiveColorMaterial = {
    color: cssColor(hex, alpha),
    hex,
    material: null,
  }
  const property = {
    /** 常量：Cesium 每帧重算一次材质 uniform 就行，不必逐实例跟踪。 */
    isConstant: true,
    /** 决定走哪条渲染路径：`'Color'` → `MaterialAppearance` 的颜色材质。 */
    getType: () => 'Color',
    /** Cesium 每帧调一次：把当前颜色写进材质的 uniforms。 */
    getValue: (_time: unknown, result?: Record<string, unknown>) => {
      const uniforms = result ?? {}
      uniforms.color = handle.color
      return uniforms
    },
    /** 批次分组用（同一个实例 → 同一批）。 */
    equals: (other: unknown) => other === property,
    /** 材质属性变化事件。 */
    definitionChanged: createMaterialEvent(),
  }
  // Cesium 只要求材质属性带 getValue；这里按它的鸭子类型实现。
  const withName = property as unknown as Record<string, unknown>
  withName.name = hex
  Object.defineProperty(withName, 'name', {
    get: () => handle.hex,
    configurable: true,
    enumerable: false,
  })
  handle.material = property as unknown as Cesium.MaterialProperty
  return handle
}

/**
 * 换一份活颜色材质的颜色（**不换材质对象**）。
 *
 * 注意是**就地改分量**：材质 uniform 持有的是同一个 Color 对象。
 */
export const setLiveColor = (handle: LiveColorMaterial, hex: string, alpha: number): void => {
  const next = cssColor(hex, alpha)
  handle.color.red = next.red
  handle.color.green = next.green
  handle.color.blue = next.blue
  handle.color.alpha = next.alpha
  handle.hex = hex
}

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
 * 脉冲环的辉光材质：透明度由回调驱动，辉光强度是**常量**。
 *
 * 两条约定：
 * 1. **`glowPower` 必须包成常量属性** —— 裸数字会让 Cesium 判这条线
 *    「非常量」，贴地几何每帧重建（见 `createGlowMaterial` 的说明）。
 * 2. 透明度是动态的，所以这条线整体是 *dynamic*：贴地的 dynamic polyline 走
 *    `GroundPolylinePrimitive`（主线程建几何），**不会**去请求被剪枝清单剪掉的
 *    `Workers/createPolylineGeometry.js` —— 非贴地的 dynamic polyline 才会，
 *    那个 404 会让整个渲染循环停摆（页面报 "Rendering has stopped."）。
 *
 * @param hex 环的颜色（取自 `EVENT_COLORS`）。
 * @param alphaAt 回调：返回当前透明度（0~1）。
 */
export const createPulseGlowMaterial = (
  hex: string,
  alphaAt: () => number,
  glowPower = 0.3,
): Cesium.PolylineGlowMaterialProperty =>
  new Cesium.PolylineGlowMaterialProperty({
    color: new Cesium.CallbackProperty(() => cssColor(hex, alphaAt()), false),
    glowPower: new Cesium.ConstantProperty(glowPower),
  })

/**
 * 换掉一个 Primitive 材质里的颜色 uniform。
 *
 * **只改一个 uniform 值**：不重建几何、不换 appearance，代价最低。
 * Cesium 的 `Material._uniforms[name]` 是个**每帧求值**的取值函数
 * （`function() { return material.uniforms[name]; }`），
 * 所以换掉 `uniforms.color` 下一帧就生效。
 *
 * 同款做法：流动光效层每帧改 `material.uniforms.dashLength` 推进相位。
 */
export const setMaterialColor = (
  material: Cesium.Material | null | undefined,
  hex: string,
  alpha = 1,
): void => {
  if (!material || !material.uniforms) return
  material.uniforms.color = cssColor(hex, alpha)
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
 *
 * @param target 写到哪里（默认 `document.documentElement`）。
 * @param theme 用哪套主题（默认当前主题）。
 */
export const applyThemeVariables = (
  target?: HTMLElement,
  theme?: ThemeDefinition,
): void => {
  const active = theme ?? activeTheme
  const root = target ?? document.documentElement
  if (!root?.style) return
  const style = root.style
  const palette = active.palette
  style.setProperty('--dc-screen', palette.screen)
  style.setProperty('--dc-panel', palette.panel)
  style.setProperty('--dc-panel-bg', withAlpha(palette.panel, 0.82))
  style.setProperty('--dc-panel-surface', withAlpha(palette.screen, 0.55))
  style.setProperty('--dc-accent', palette.accent)
  style.setProperty('--dc-flow', palette.flow)
  style.setProperty('--dc-secondary', palette.secondary)
  style.setProperty('--dc-warning', palette.warning)
  style.setProperty('--dc-alert', palette.alert)
  style.setProperty('--dc-text', palette.text)
  style.setProperty('--dc-building', palette.building)
  style.setProperty('--dc-building-roof', palette.buildingRoof)
  style.setProperty('--dc-road-main', active.roadColors.main)
}
