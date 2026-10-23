import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, shallowRef } from 'vue'

vi.mock('cesium', async () => {
  const { createCesiumStub } = await import('./cesiumStub')
  return createCesiumStub()
})

import { useSceneStage, cityConfig, ROAD_TIER_BY_HIGHWAY } from '../useSceneStage'
import { getCesiumStub } from './cesiumStub'
import type { StubEntity } from './cesiumStub'
import { setActiveTheme } from '@/theme/dark'
import { CLAY, DEEP_SPACE } from '@/theme/themes'
import type { BuildingsResponse, Position, RoadsResponse } from '../../../types/city'

const stub = () => getCesiumStub()

beforeEach(() => {
  vi.clearAllMocks()
  stub().GeoJsonDataSource.load.mockResolvedValue({ entities: { values: [] } })
  // 模块级主题是单例：每条用例都从确定的起点开始
  setActiveTheme(DEEP_SPACE)
})

/** 一个「会记账的」polygon：material 的每次写入都记下来。 */
const spyPolygon = () => {
  const writes: unknown[] = []
  const polygon: Record<string, unknown> = {}
  Object.defineProperty(polygon, 'material', {
    set: (value: unknown) => {
      writes.push(value)
    },
    get: () => undefined,
    configurable: true,
  })
  return { polygon, writes }
}

/** 一个「会记账的」polyline：material 的每次写入都记下来。 */
const spyPolyline = () => {
  const writes: unknown[] = []
  const polyline: Record<string, unknown> = {}
  Object.defineProperty(polyline, 'material', {
    set: (value: unknown) => {
      writes.push(value)
    },
    get: () => undefined,
    configurable: true,
  })
  return { polyline, writes }
}

const buildingEntity = (height: string) => {
  const { polygon, writes } = spyPolygon()
  return {
    entity: {
      position: null,
      show: true,
      point: {},
      polygon,
      polyline: undefined,
      properties: { height: { getValue: () => height } },
    } as unknown as StubEntity,
    writes,
  }
}

const roadEntity = (highway: string) => {
  const { polyline, writes } = spyPolyline()
  return {
    entity: {
      position: null,
      show: true,
      point: {},
      polygon: undefined,
      polyline,
      properties: { highway: { getValue: () => highway } },
    } as unknown as StubEntity,
    writes,
  }
}

/** 广场 / 人造地面：只有 polygon、没有 polyline。 */
const plazaEntity = () => {
  const { polygon, writes } = spyPolygon()
  return {
    entity: {
      position: null,
      show: true,
      point: {},
      polygon,
      polyline: undefined,
      properties: {},
    } as unknown as StubEntity,
    writes,
  }
}

const buildingFeature = (height: string): BuildingsResponse['features'][number] => ({
  type: 'Feature',
  properties: { height },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [116.4, 39.9],
        [116.401, 39.9],
        [116.401, 39.901],
        [116.4, 39.9],
      ],
    ] as Position[][],
  },
})

const roadFeature = (highway: string): RoadsResponse['features'][number] => ({
  type: 'Feature',
  properties: { highway },
  geometry: {
    type: 'LineString',
    coordinates: [
      [116.39, 39.9],
      [116.42, 39.9],
    ] as Position[],
  },
})

/** 造一个装好了建筑与道路的场景底座（外加一个广场）。 */
const makeLoadedStage = async () => {
  const buildings = [buildingEntity('24'), buildingEntity('30')]
  const roads = [
    roadEntity('primary'),
    roadEntity('secondary'),
    roadEntity('residential'),
    roadEntity('footway'),
    roadEntity('motorway_link'),
  ]
  const plaza = plazaEntity()
  stub().GeoJsonDataSource.load
    .mockResolvedValueOnce({ entities: { values: buildings.map(item => item.entity) } })
    .mockResolvedValueOnce({ entities: { values: [...roads.map(item => item.entity), plaza.entity] } })

  const container = ref<HTMLDivElement | null>(document.createElement('div'))
  const buildingsRef = shallowRef<BuildingsResponse | null>({
    type: 'FeatureCollection',
    features: [buildingFeature('24'), buildingFeature('30')],
  })
  const roadsRef = shallowRef<RoadsResponse | null>({
    type: 'FeatureCollection',
    features: [
      roadFeature('primary'),
      roadFeature('secondary'),
      roadFeature('residential'),
      roadFeature('footway'),
      roadFeature('motorway_link'),
    ],
  })
  const stage = useSceneStage({ container, buildings: buildingsRef, roads: roadsRef })
  await stage.initCesium({ attach: vi.fn(), flyToOverhead: vi.fn() })
  await stage.loadGeoJSONBuildings()
  await stage.loadGeoJSONRoads()
  return { stage, buildings, roads, plaza }
}

/** 读 Primitive 材质里的颜色 uniform。 */
const uniformColor = (material: unknown): { name?: string; alpha: number } =>
  (material as { uniforms: { color: { name?: string; alpha: number } } }).uniforms.color

describe('哑光白模 —— 路宽砍一半', () => {
  it('分级宽度是 7/5/3/2，兜底分级也是 2', () => {
    expect(cityConfig.roadTiers.map(tier => tier.width)).toEqual([7, 5, 3, 2])
    expect(cityConfig.roadFallbackTier.width).toBe(2)
    expect(ROAD_TIER_BY_HIGHWAY.get('primary')?.width).toBe(7)
    expect(ROAD_TIER_BY_HIGHWAY.get('secondary')?.width).toBe(5)
    expect(ROAD_TIER_BY_HIGHWAY.get('residential')?.width).toBe(3)
    expect(ROAD_TIER_BY_HIGHWAY.get('footway')?.width).toBe(2)
  })

  it('宽度是全局默认，不随主题变（几何属性，只能装载时定）', async () => {
    const { stage } = await makeLoadedStage()
    stage.applyTheme(CLAY)
    expect(cityConfig.roadTiers.map(tier => tier.width)).toEqual([7, 5, 3, 2])
  })

  it('装载时实体拿到的就是砍半后的宽度', async () => {
    const { stage, roads } = await makeLoadedStage()
    const widths = roads.map(item => (item.entity.polyline as { width: number }).width)
    expect(widths).toEqual([7, 5, 3, 2, 2])
    // 实体确实挂在场景里
    expect(stage.state.roadEntities).toHaveLength(6)
  })
})

describe('哑光白模 —— 描边取 buildingEdge，不取界面 accent', () => {
  it('装载时描边就用 buildingEdge', async () => {
    setActiveTheme(CLAY)
    const { stage } = await makeLoadedStage()
    expect(uniformColor(stage.primitives.buildingGlowMaterial).name).toBe(CLAY.palette.buildingEdge)
  })

  it('切主题后描边跟着 buildingEdge 走', async () => {
    const { stage } = await makeLoadedStage()
    stage.applyTheme(CLAY)
    expect(uniformColor(stage.primitives.buildingGlowMaterial).name).toBe(CLAY.palette.buildingEdge)
    // 白模的描边与界面强调色是**两个不同的色**（否则界面选中态会变成灰色）
    expect(CLAY.palette.buildingEdge).not.toBe(CLAY.palette.accent)
  })
})

describe('哑光白模 —— 广场取 surface，不取面板底 panel', () => {
  it('装载时广场就用 surface', async () => {
    setActiveTheme(CLAY)
    const { stage, plaza } = await makeLoadedStage()
    expect(stage.primitives.surfaceMaterial?.hex).toBe(CLAY.palette.surface)
    // 广场实体拿的是**全场共用**的那一个地面材质实例
    expect(plaza.writes[0]).toBe(stage.primitives.surfaceMaterial?.material)
  })

  it('切主题后广场跟着 surface 走', async () => {
    const { stage } = await makeLoadedStage()
    stage.applyTheme(CLAY)
    expect(stage.primitives.surfaceMaterial?.hex).toBe(CLAY.palette.surface)
    // 地面与大屏面板是两个色位
    expect(CLAY.palette.surface).not.toBe(CLAY.palette.panel)
  })
})

describe('哑光白模 —— 流动光效层的不透明度跟 flowAlpha 走', () => {
  it('装载时用的就是当前主题的 flowAlpha', async () => {
    setActiveTheme(CLAY)
    const { stage } = await makeLoadedStage()
    expect(uniformColor(stage.primitives.flowMaterial).alpha).toBe(CLAY.glow.flowAlpha)
    expect(CLAY.glow.flowAlpha).toBe(0.12)
  })

  it('applyTheme 之后 alpha 等于 theme.glow.flowAlpha', async () => {
    const { stage } = await makeLoadedStage()
    stage.applyTheme(CLAY)
    expect(uniformColor(stage.primitives.flowMaterial).alpha).toBe(CLAY.glow.flowAlpha)

    stage.applyTheme(DEEP_SPACE)
    expect(uniformColor(stage.primitives.flowMaterial).alpha).toBe(DEEP_SPACE.glow.flowAlpha)
  })

  it('不是写死的 0.95', async () => {
    const { stage } = await makeLoadedStage()
    stage.applyTheme(CLAY)
    expect(uniformColor(stage.primitives.flowMaterial).alpha).not.toBe(0.95)
  })
})

describe('哑光白模 —— 切主题仍然不碰材质对象的 setter', () => {
  it('切到白模主题时 polygon.material / polyline.material 的 setter 一次都没被调用', async () => {
    const { stage, buildings, roads, plaza } = await makeLoadedStage()
    const polygonWritesBefore = [
      ...buildings.map(item => item.writes.length),
      plaza.writes.length,
    ]
    const polylineWritesBefore = roads.map(item => item.writes.length)

    stage.applyTheme(CLAY)

    expect([...buildings.map(item => item.writes.length), plaza.writes.length]).toEqual(
      polygonWritesBefore,
    )
    expect(roads.map(item => item.writes.length)).toEqual(polylineWritesBefore)
  })

  it('连切三次也不碰 setter', async () => {
    const { stage, buildings, roads, plaza } = await makeLoadedStage()
    const polygonWritesBefore = [
      ...buildings.map(item => item.writes.length),
      plaza.writes.length,
    ]
    const polylineWritesBefore = roads.map(item => item.writes.length)

    stage.applyTheme(CLAY)
    stage.applyTheme(DEEP_SPACE)
    stage.applyTheme(CLAY)

    expect([...buildings.map(item => item.writes.length), plaza.writes.length]).toEqual(
      polygonWritesBefore,
    )
    expect(roads.map(item => item.writes.length)).toEqual(polylineWritesBefore)
  })
})
