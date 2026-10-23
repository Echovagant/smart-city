import type { Ref } from 'vue'
import * as Cesium from 'cesium'
import {
  BUILDING_GLOW_DIMMED,
  DARK_PALETTE,
  FLOW_HIGHLIGHT,
  createPrimitiveGlowMaterial,
  setMaterialColor,
} from '@/theme/dark'
import { resolveFocusBuildingIds, resolveSceneLinkage } from './useSceneLinkage'
import { useDashboardState } from './useDashboardState'
import { collectBuildingOutlines } from './useSceneStage'
import type { ScenePrimitives } from './useSceneStage'
import type { BuildingsResponse, CityOverview } from '../../types/city'

/**
 * 页签联动在场景里的副作用：高亮焦点建筑、压暗其余建筑、提亮流动光效层。
 *
 * 「高亮 + 压暗」的实现顺序（按代价从低到高）：
 * 1. **改材质 uniform**（采用）：焦点建筑单独一条批量描边 Primitive，
 *    其余建筑把**全量描边**的 color uniform 调暗 —— 建筑本体保持可见，
 *    保留空间上下文。改 uniform 不重建几何，代价最低。
 * 2. 换整个 appearance（可能触发批处理重建）。
 * 3. 隐藏非焦点建筑（那是**隐藏**不是压暗，属于降级方案）。
 *
 * **绝不做**：逐个改 3854 个建筑的 `polygon.material` —— 那会打散批处理 →
 * 全量几何重建 → 卡死。
 *
 * 联动的判定规则在**纯函数**那边（`useSceneLinkage.ts`），这里只执行。
 */

/** 焦点建筑描边的辉光强度。 */
export const FOCUS_GLOW_POWER = 0.35

/** 页签联动对外暴露的东西。 */
export interface SceneLinkageEffect {
  /** 应用当前页签的联动（幂等）。 */
  applySceneLinkage(): void
  /** 拆掉焦点描边。 */
  removeFocusGlow(): void
}

/** 页签联动的输入。 */
export interface SceneLinkageEffectOptions {
  /** Cesium 视图（场景底座给的那一份）。 */
  viewer: Ref<Cesium.Viewer | null>
  /** 场景里的 Primitive 引用（全量描边 / 流动光效层 / 焦点描边）。 */
  primitives: ScenePrimitives
  /** 建筑 GeoJSON（焦点集合按 OSM id 匹配）。 */
  buildings: Ref<BuildingsResponse | null>
  /** 城市运行指标（焦点分类的成员来自后端 `facilities[].members`）。 */
  cityOverview: Ref<CityOverview | null>
}

export function useSceneLinkageEffect({
  viewer,
  primitives,
  buildings,
  cityOverview,
}: SceneLinkageEffectOptions): SceneLinkageEffect {
  // 大屏页签状态是**模块级单例**（S2 做的）：大屏与 3D 场景共用同一份 ——
  // 「页签切换 → 场景联动」就靠它。
  const { activeTabKey } = useDashboardState()

  /** 拆掉焦点描边。 */
  const removeFocusGlow = () => {
    const activeViewer = viewer.value
    if (primitives.focusGlow && activeViewer) {
      activeViewer.scene.primitives.remove(primitives.focusGlow)
    }
    primitives.focusGlow = null
  }

  /**
   * 应用页签联动。
   *
   * 幂等：同一页签反复切不会叠加高亮。
   */
  const applySceneLinkage = () => {
    const linkage = resolveSceneLinkage(activeTabKey.value)

    // 其余建筑的描边：压暗 / 恢复（只改一个 uniform）
    setMaterialColor(
      primitives.buildingGlowMaterial,
      linkage.dimBuildings ? BUILDING_GLOW_DIMMED : DARK_PALETTE.accent
    )

    // 流动光效层：提亮 / 恢复
    setMaterialColor(
      primitives.flowMaterial,
      linkage.brightenFlow ? FLOW_HIGHLIGHT : DARK_PALETTE.flow,
      0.95
    )

    // 焦点描边：重建（建筑集合很小，重建成本可忽略）
    removeFocusGlow()
    const activeViewer = viewer.value
    if (!activeViewer || linkage.focusFacilityKeys.length === 0) return

    // 焦点集合来自**后端** `facilities[].members` —— 前端不重新实现分类规则。
    const focusIds = resolveFocusBuildingIds(
      cityOverview.value?.facilities,
      linkage.focusFacilityKeys
    )
    if (focusIds.size === 0) return
    const features = (buildings.value?.features ?? []).filter(
      feature => feature.id !== undefined && focusIds.has(String(feature.id))
    )
    const instances = collectBuildingOutlines(features)
    if (instances.length === 0) return
    const primitive = new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PolylineMaterialAppearance({
        material: createPrimitiveGlowMaterial(DARK_PALETTE.flow, FOCUS_GLOW_POWER),
      }),
      asynchronous: false,
    })
    activeViewer.scene.primitives.add(primitive)
    primitives.focusGlow = primitive
  }

  return {
    applySceneLinkage,
    removeFocusGlow,
  }
}
