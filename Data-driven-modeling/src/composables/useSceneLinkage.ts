import type { FacilityCategory } from '../../types/city'

/**
 * 页签 → 场景联动的**纯函数**解析。
 *
 * 这里只算「该做什么」，不碰 Cesium，也不碰 Vue 响应式 —— 所以好测。
 * 真正执行联动的代码在 `SmartCity.vue` 里。
 *
 * | 页签 | 场景动作 |
 * |---|---|
 * | `overview` | **无联动**（全部正常显示） |
 * | `air` | 无空间定位 → **不联动**，面板里写一句说明 |
 * | `public_safety` | 高亮 `public_safety` + `medical` 分类的建筑，**其余压暗** |
 * | `heritage` | 高亮 `heritage` 分类的建筑，其余压暗 |
 * | `network` | **不压暗建筑**；把流动光效层的颜色提亮 |
 *
 * 联动的焦点建筑集合来自**后端** `facilities[].members`（建筑的 OSM id），
 * 前端只按 id 匹配 —— **不重新实现分类规则**（规则只写在后端）。
 */

/** 一次联动的结果。 */
export interface SceneLinkage {
  /** 要高亮的设施分类 key（空数组 = 不高亮任何东西）。 */
  focusFacilityKeys: string[]
  /** 非焦点建筑是否压暗。 */
  dimBuildings: boolean
  /** 流动光效层是否提亮。 */
  brightenFlow: boolean
  /** 给用户看的一句话说明（没有就 null）。 */
  note: string | null
}

/** 无联动时的结果（overview / air 页签）。 */
const NO_LINKAGE: SceneLinkage = {
  focusFacilityKeys: [],
  dimBuildings: false,
  brightenFlow: false,
  note: null,
}

/**
 * 页签 → 联动动作。
 *
 * 未知页签按「无联动」处理（宁可什么都不做，也不要做错）。
 */
export const resolveSceneLinkage = (tabKey: string): SceneLinkage => {
  switch (tabKey) {
    case 'public_safety':
      return {
        focusFacilityKeys: ['public_safety', 'medical'],
        dimBuildings: true,
        brightenFlow: false,
        note: null,
      }
    case 'heritage':
      return {
        focusFacilityKeys: ['heritage'],
        dimBuildings: true,
        brightenFlow: false,
        note: null,
      }
    case 'network':
      return {
        focusFacilityKeys: [],
        dimBuildings: false,
        brightenFlow: true,
        note: null,
      }
    case 'air':
      return {
        ...NO_LINKAGE,
        note: '空气质量为全市指标，无空间定位',
      }
    default:
      return { ...NO_LINKAGE }
  }
}

/**
 * 联动焦点建筑 → 建筑 OSM id 集合。
 *
 * 集合来自后端 `facilities[].members`，前端**不重新实现分类规则**。
 */
export const resolveFocusBuildingIds = (
  facilities: FacilityCategory[] | null | undefined,
  focusFacilityKeys: string[],
): Set<string> => {
  const ids = new Set<string>()
  if (!Array.isArray(facilities) || focusFacilityKeys.length === 0) return ids
  facilities.forEach(category => {
    if (!category || !focusFacilityKeys.includes(category.key)) return
    const members = category.members
    if (!Array.isArray(members)) return
    members.forEach(id => {
      if (typeof id === 'string' && id) ids.add(id)
    })
  })
  return ids
}
