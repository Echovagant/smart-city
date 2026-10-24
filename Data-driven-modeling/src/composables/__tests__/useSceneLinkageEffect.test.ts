import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, shallowRef } from 'vue'
import type { Ref } from 'vue'

vi.mock('cesium', async () => {
  const { createCesiumStub } = await import('./cesiumStub')
  return createCesiumStub()
})

import { useSceneLinkageEffect, FOCUS_GLOW_POWER } from '../useSceneLinkageEffect'
import { useDashboardState, DEFAULT_TAB_KEY } from '../useDashboardState'
import { BUILDING_GLOW_DIMMED, DARK_PALETTE, FLOW_HIGHLIGHT } from '@/theme/dark'
import type { ScenePrimitives } from '../useSceneStage'
import { getCesiumStub, makeScenePrimitives } from './cesiumStub'
import type { StubViewer } from './cesiumStub'
import type { BuildingsResponse, CityOverview, Position } from '../../../types/city'

const stub = () => getCesiumStub()

beforeEach(() => {
  vi.clearAllMocks()
  // 页签状态是模块级单例：每个用例先复位
  useDashboardState().setTab(DEFAULT_TAB_KEY)
})

const SOURCE = {
  name: '本地 OSM 路网数据',
  url: 'backend-python/geojson/roads.geojson',
  observed_at: '2026-06-21T11:40:10Z',
  fetched_at: '2026-10-22T04:30:00Z',
  realtime: false,
  estimated: false,
}

/** 一栋带 OSM id 的楼（焦点集合按 id 匹配）。 */
const buildingFeature = (id: string) => ({
  type: 'Feature' as const,
  id,
  properties: { building: 'yes' },
  geometry: {
    type: 'Polygon' as const,
    coordinates: [[
      [2.1674, 41.3995],
      [2.1684, 41.3995],
      [2.1684, 41.4005],
      [2.1674, 41.3995],
    ]] as Position[][],
  },
})

const overviewWith = (members: string[]): CityOverview => ({
  city: { id: 'barcelona', name: '巴塞罗那', latitude: 41.39585, longitude: 2.1652, timezone: 'Europe/Madrid' },
  generated_at: '2026-10-22T04:00:00Z',
  metrics: [],
  series: [],
  facilities: [
    { key: 'heritage', label: '历史建筑', count: members.length, criteria: [], members, source: SOURCE },
  ],
  events: [],
  degraded: [],
})

/** 造一套页签联动。 */
const makeLinkage = (options: { members?: string[] } = {}) => {
  const viewer = ref<unknown>(null)
  const buildings = shallowRef<BuildingsResponse | null>({
    type: 'FeatureCollection',
    features: [buildingFeature('relation/1')],
  })
  const cityOverview = shallowRef<CityOverview | null>(overviewWith(options.members ?? ['relation/1']))
  const primitives: ScenePrimitives = {
    ...makeScenePrimitives(),
    buildingGlowMaterial: { uniforms: { color: { name: DARK_PALETTE.accent } } } as never,
    flowMaterial: { uniforms: { color: { name: DARK_PALETTE.flow } } } as never,
  }
  const linkage = useSceneLinkageEffect({
    viewer: viewer as Ref<never>,
    primitives,
    buildings,
    cityOverview,
  })
  const stubViewer = stub().Viewer() as unknown as StubViewer
  viewer.value = stubViewer
  return { linkage, viewer, buildings, cityOverview, primitives, stubViewer }
}

describe('useSceneLinkageEffect', () => {
  it('默认页签：描边保持强调色，流动光效保持常态', () => {
    const { linkage, primitives } = makeLinkage()
    linkage.applySceneLinkage()
    const glow = primitives.buildingGlowMaterial as unknown as { uniforms: { color: { name: string } } }
    const flow = primitives.flowMaterial as unknown as { uniforms: { color: { name: string } } }
    expect(glow.uniforms.color.name).toBe(DARK_PALETTE.accent)
    expect(flow.uniforms.color.name).toBe(DARK_PALETTE.flow)
  })

  it('切到「城市文旅」：其余建筑压暗，并为焦点建筑单独画一条描边', () => {
    const { linkage, primitives, stubViewer } = makeLinkage()
    useDashboardState().setTab('heritage')
    linkage.applySceneLinkage()
    const glow = primitives.buildingGlowMaterial as unknown as { uniforms: { color: { name: string } } }
    expect(glow.uniforms.color.name).toBe(BUILDING_GLOW_DIMMED)
    // 焦点描边：一条批量 Primitive
    expect(stubViewer.scene.primitives.add).toHaveBeenCalledTimes(1)
    expect(primitives.focusGlow).not.toBeNull()
  })

  it('切到「路网运行」：不压暗建筑，只提亮流动光效', () => {
    const { linkage, primitives, stubViewer } = makeLinkage()
    useDashboardState().setTab('network')
    linkage.applySceneLinkage()
    const glow = primitives.buildingGlowMaterial as unknown as { uniforms: { color: { name: string } } }
    const flow = primitives.flowMaterial as unknown as { uniforms: { color: { name: string } } }
    expect(glow.uniforms.color.name).toBe(DARK_PALETTE.accent)
    expect(flow.uniforms.color.name).toBe(FLOW_HIGHLIGHT)
    // 没有焦点建筑 → 不画焦点描边
    expect(stubViewer.scene.primitives.add).not.toHaveBeenCalled()
  })

  it('焦点集合来自后端 members（按 OSM id 匹配）', () => {
    const { linkage, primitives, stubViewer } = makeLinkage({ members: ['relation/1'] })
    useDashboardState().setTab('heritage')
    linkage.applySceneLinkage()
    const primitive = stubViewer.scene.primitives.add.mock.calls[0][0] as {
      geometryInstances: unknown[]
      appearance: { material: { uniforms: { color: { name: string }; glowPower: number } } }
    }
    expect(primitive.geometryInstances).toHaveLength(1)
    expect(primitive.appearance.material.uniforms.color.name).toBe(DARK_PALETTE.flow)
    expect(primitive.appearance.material.uniforms.glowPower).toBe(FOCUS_GLOW_POWER)
    expect(primitives.focusGlow).toBe(primitive)
  })

  it('焦点集合为空时只压暗，不画焦点描边', () => {
    const { linkage, primitives, stubViewer } = makeLinkage({ members: [] })
    useDashboardState().setTab('heritage')
    linkage.applySceneLinkage()
    expect(stubViewer.scene.primitives.add).not.toHaveBeenCalled()
    expect(primitives.focusGlow).toBeNull()
  })

  it('切回默认页签：完全恢复，并把焦点描边从场景里拆掉', () => {
    const { linkage, primitives, stubViewer } = makeLinkage()
    useDashboardState().setTab('heritage')
    linkage.applySceneLinkage()
    const focus = primitives.focusGlow
    useDashboardState().setTab(DEFAULT_TAB_KEY)
    linkage.applySceneLinkage()
    const glow = primitives.buildingGlowMaterial as unknown as { uniforms: { color: { name: string } } }
    expect(glow.uniforms.color.name).toBe(DARK_PALETTE.accent)
    expect(primitives.focusGlow).toBeNull()
    expect(stubViewer.scene.primitives.remove).toHaveBeenCalledWith(focus)
  })

  it('removeFocusGlow 单独拆焦点描边', () => {
    const { linkage, primitives, stubViewer } = makeLinkage()
    useDashboardState().setTab('heritage')
    linkage.applySceneLinkage()
    const focus = primitives.focusGlow
    linkage.removeFocusGlow()
    expect(stubViewer.scene.primitives.remove).toHaveBeenCalledWith(focus)
    expect(primitives.focusGlow).toBeNull()
    // 再拆一次不炸
    expect(() => linkage.removeFocusGlow()).not.toThrow()
  })

  it('没有 viewer 时不画焦点描边', () => {
    const { linkage, viewer, primitives } = makeLinkage()
    viewer.value = null
    useDashboardState().setTab('heritage')
    expect(() => linkage.applySceneLinkage()).not.toThrow()
    expect(primitives.focusGlow).toBeNull()
  })
})
