import { computed, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { DEFAULT_THEME_ID, THEMES, resolveTheme } from '@/theme/themes'
import type { ThemeDefinition, ThemeOverrides } from '@/theme/themes/types'
import { applyThemeVariables, setActiveTheme } from '@/theme/dark'
import { syncChartColors } from '@/theme/dashboard'

/**
 * 大屏主题状态（**模块级单例**，与 `useDashboardState` 同款）。
 *
 * 一套主题 = 一整套配色（面板 / 场景 / 道路 / 图表 / 辉光参数）。
 * 用户可以换主题，也可以在主题之上做**局部覆盖**
 * （道路主色 / 建筑色 / 辉光强度 / 路面不透明度）。
 *
 * ## 职责边界
 *
 * - **CSS 变量**（`--dc-*`）由这里负责 —— 面板样式表读 `var(--dc-xxx)`；
 * - **3D 场景**由 `useSceneStage().applyTheme(theme)` 负责。
 *
 * 两边不重叠：这里不碰 Cesium，场景那边不碰 CSS 变量。
 */

/** 持久化用的 localStorage key。 */
export const THEME_STORAGE_KEY = 'smart-city:theme:v1'

/** 可被用户覆盖的项 —— **只有这四项**。 */
const OVERRIDE_KEYS: Array<keyof ThemeOverrides> = [
  'roadMain',
  'building',
  'glowPower',
  'roadAlpha',
]

/** 主题控制器（界面层拿它渲染主题选择器）。 */
export interface ThemeController {
  /** 当前主题 id。 */
  themeId: Ref<string>
  /** 用户在主题之上的局部覆盖。 */
  overrides: Ref<ThemeOverrides>
  /** 解析后的最终主题（主题 + 覆盖）。 */
  theme: ComputedRef<ThemeDefinition>
  /** 切换主题（**不清覆盖**：用户覆盖跨主题保留更符合直觉）。 */
  setTheme(id: string): void
  /** 设置 / 清除一项覆盖；value 传 `undefined` 表示清除该项。 */
  setOverride(key: keyof ThemeOverrides, value: string | number | undefined): void
  /** 清掉所有覆盖（恢复当前主题的原值）。 */
  resetOverrides(): void
}

/* ---------------------------------------------------------------------------
 * 持久化
 * ------------------------------------------------------------------------- */

/**
 * 把读回来的覆盖值**洗一遍**。
 *
 * 只认白名单里的四项，类型不对就丢掉 —— 存盘里可能躺着旧版本或
 * 手改过的内容，不能让它直接流进主题解析。
 *
 * 注意：白名单里**没有** warning / alert —— 语义色不开放给用户。
 */
const sanitizeOverrides = (raw: unknown): ThemeOverrides => {
  if (!raw || typeof raw !== 'object') return {}
  const source = raw as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of OVERRIDE_KEYS) {
    const value = source[key]
    if (value === undefined || value === null) continue
    if (key === 'glowPower' || key === 'roadAlpha') {
      if (typeof value === 'number' && Number.isFinite(value)) result[key] = value
      continue
    }
    if (typeof value === 'string' && value.trim() !== '') result[key] = value
  }
  return result as ThemeOverrides
}

/**
 * 读持久化的主题设置。
 *
 * **容错是第一要务**：localStorage 可能被禁用（隐私模式）、可能配额满、
 * 内容可能被手改成一段乱码 —— 任何一种情况都只回落到默认主题，
 * 绝不抛异常把整个应用带崩。
 */
const readPersisted = (): { id: string; overrides: ThemeOverrides } => {
  const fallback = { id: DEFAULT_THEME_ID, overrides: {} as ThemeOverrides }
  try {
    const raw = window.localStorage?.getItem(THEME_STORAGE_KEY)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallback
    const record = parsed as { id?: unknown; overrides?: unknown }
    const id =
      typeof record.id === 'string' && THEMES.some(theme => theme.id === record.id)
        ? record.id
        : DEFAULT_THEME_ID
    return { id, overrides: sanitizeOverrides(record.overrides) }
  } catch {
    return fallback
  }
}

/** 把当前设置写回 localStorage（写不进去就算了，不影响使用）。 */
const writePersisted = (id: string, overrides: ThemeOverrides): void => {
  try {
    window.localStorage?.setItem(THEME_STORAGE_KEY, JSON.stringify({ id, overrides }))
  } catch {
    /* 存储不可用（隐私模式 / 配额满）：忽略 */
  }
}

/* ---------------------------------------------------------------------------
 * 模块级单例状态
 * ------------------------------------------------------------------------- */

const themeId = ref<string>(DEFAULT_THEME_ID)
const overrides = ref<ThemeOverrides>({})

/** 解析后的最终主题（主题 + 覆盖）。 */
const theme = computed<ThemeDefinition>(() => resolveTheme(themeId.value, overrides.value))

/** 把解析结果落到三处：模块镜像、图表活数组、CSS 变量。 */
const applyCurrentTheme = (resolved: ThemeDefinition): void => {
  setActiveTheme(resolved)
  syncChartColors(resolved)
  applyThemeVariables(undefined, resolved)
}

// 同步监听：主题一变**立刻**生效（不等下一帧），面板与场景不会差一帧。
watch(theme, applyCurrentTheme, { flush: 'sync' })

/** 是否已经从 localStorage 恢复过一次。 */
let initialized = false

/**
 * 取主题控制器。
 *
 * **模块级单例**：大屏与 3D 场景共用同一份主题状态。
 * 第一次调用时会把持久化的设置读回来，并**立刻应用一次 CSS 变量** ——
 * 于是界面层只要 `useTheme()` 就能拿到已经生效的配色。
 */
export function useTheme(): ThemeController {
  if (!initialized) {
    initialized = true
    const persisted = readPersisted()
    themeId.value = persisted.id
    overrides.value = persisted.overrides
    applyCurrentTheme(theme.value)
  }

  /** 切换主题：未知 id 直接忽略（保持当前主题）。 */
  const setTheme = (id: string): void => {
    if (!THEMES.some(item => item.id === id)) return
    themeId.value = id
    writePersisted(themeId.value, overrides.value)
  }

  /** 设置 / 清除一项覆盖。 */
  const setOverride = (key: keyof ThemeOverrides, value: string | number | undefined): void => {
    if (!OVERRIDE_KEYS.includes(key)) return
    const next = { ...overrides.value } as Record<string, unknown>
    if (value === undefined) {
      delete next[key]
    } else {
      next[key] = value
    }
    overrides.value = next as ThemeOverrides
    writePersisted(themeId.value, overrides.value)
  }

  /** 清掉所有覆盖（恢复当前主题的原值）。 */
  const resetOverrides = (): void => {
    overrides.value = {}
    writePersisted(themeId.value, overrides.value)
  }

  return {
    themeId,
    overrides,
    theme,
    setTheme,
    setOverride,
    resetOverrides,
  }
}

/** 全部可选主题（顺序即界面里的展示顺序）。 */
export { THEMES, DEFAULT_THEME_ID }
