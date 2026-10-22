import { computed, ref } from 'vue'
import type { DashboardTab } from '../../types/city'

/**
 * 大屏页签状态。
 *
 * **模块级单例**：页签是整个大屏共享的一份状态 ——
 * `DashboardOverlay` 负责渲染与切换，阶段 3 的「页签联动场景」在
 * `SmartCity.vue` 里也要读同一个状态，所以它不能是组件内的局部 state。
 *
 * 这里**只放状态**（当前页签 + 切换动作），不塞数据：
 * 数据是 props 传进来的（见 `useDashboardData.ts`）。
 */

/** 大屏的 5 个页签。顺序即显示顺序。 */
export const DASHBOARD_TABS: DashboardTab[] = [
  { key: 'overview', label: '区域概览' },
  { key: 'air', label: '空气质量' },
  { key: 'public_safety', label: '公共安全' },
  { key: 'heritage', label: '城市文旅' },
  { key: 'network', label: '路网运行' },
]

/** 默认页签。 */
export const DEFAULT_TAB_KEY = 'overview'

// 模块级单例状态。
const activeTabKey = ref<string>(DEFAULT_TAB_KEY)

export function useDashboardState() {
  /** 切换页签。未知 key 时忽略（保持当前页签）。 */
  const setTab = (key: string) => {
    if (!DASHBOARD_TABS.some(tab => tab.key === key)) return
    activeTabKey.value = key
  }

  /** 当前页签的定义。 */
  const activeTab = computed<DashboardTab>(
    () => DASHBOARD_TABS.find(tab => tab.key === activeTabKey.value) ?? DASHBOARD_TABS[0],
  )

  return {
    /** 全部页签。 */
    tabs: DASHBOARD_TABS,
    /** 当前页签的 key（可写）。 */
    activeTabKey,
    /** 当前页签的定义。 */
    activeTab,
    /** 切换页签。 */
    setTab,
  }
}
