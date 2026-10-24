import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, shallowRef } from 'vue'

vi.mock('cesium', async () => {
  const { createCesiumStub } = await import('./cesiumStub')
  return createCesiumStub()
})

import { useSceneStage, ROAD_COLOR_KEYS } from '../useSceneStage'
import { getCesiumStub } from './cesiumStub'
import type { StubEntity, StubViewer } from './cesiumStub'
import { DEEP_SPACE, GRAPHITE } from '@/theme/themes'
import type { BuildingsResponse, Position, RoadsResponse } from '../../../types/city'

const stub = () => getCesiumStub()

beforeEach(() => {
  vi.clearAllMocks()
  stub().GeoJsonDataSource.load.mockResolvedValue({ entities: { values: [] } })
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

const buildingFeature = (height: string): BuildingsResponse['features'][number] => ({
  type: 'Feature',
  properties: { height },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [2.1674, 41.3895],
        [2.1684, 41.3895],
        [2.1684, 41.3905],
        [2.1674, 41.3895],
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
      [2.1574, 41.3895],
      [2.1874, 41.3895],
    ] as Position[],
  },
})

/** 造一个装好了建筑与道路的场景底座。 */
const makeLoadedStage = async () => {
  const buildings = [
    buildingEntity('24'),
    buildingEntity('18'),
    buildingEntity('30'),
  ]
  const roads = [
    roadEntity('primary'),
    roadEntity('secondary'),
    roadEntity('residential'),
    roadEntity('footway'),
    roadEntity('motorway_link'),
  ]
  stub().GeoJsonDataSource.load
    .mockResolvedValueOnce({ entities: { values: buildings.map(item => item.entity) } })
    .mockResolvedValueOnce({ entities: { values: roads.map(item => item.entity) } })

  const container = ref<HTMLDivElement | null>(document.createElement('div'))
  const buildingsRef = shallowRef<BuildingsResponse | null>({
    type: 'FeatureCollection',
    features: [buildingFeature('24'), buildingFeature('18'), buildingFeature('30')],
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
  return { stage, buildings, roads }
}

describe('场景换色 —— 材质是共享的', () => {
  it('全部建筑共用同一个材质实例', async () => {
    const { stage, buildings } = await makeLoadedStage()
    const materials = buildings.map(item => item.writes[0])
    expect(materials[0]).toBeTruthy()
    // 三栋楼拿到的是**同一个对象**
    expect(materials[1]).toBe(materials[0])
    expect(materials[2]).toBe(materials[0])
    // 场景底座上也只登记了一份
    expect(stage.primitives.buildingMaterial?.material).toBe(materials[0])
  })

  it('道路按分级共用：五档各一个实例', async () => {
    const { stage, roads } = await makeLoadedStage()
    expect(stage.primitives.roadMaterials.size).toBe(ROAD_COLOR_KEYS.length)
    expect(ROAD_COLOR_KEYS).toHaveLength(5)

    const [primary, secondary, local, footway, fallback] = roads.map(item => item.writes[0])
    // 五档各不相同
    const all = [primary, secondary, local, footway, fallback]
    expect(new Set(all).size).toBe(5)
    // 主干道与次干道各自对应主题里的那一档
    expect(primary).toBe(stage.primitives.roadMaterials.get('main')?.material)
    expect(secondary).toBe(stage.primitives.roadMaterials.get('secondary')?.material)
    expect(local).toBe(stage.primitives.roadMaterials.get('local')?.material)
    expect(footway).toBe(stage.primitives.roadMaterials.get('footway')?.material)
    // 表外 highway 落兜底档
    expect(fallback).toBe(stage.primitives.roadMaterials.get('fallback')?.material)
  })

  it('网格材质被存下来了（换主题拿得到引用）', async () => {
    const { stage } = await makeLoadedStage()
    stage.createBaseGrid({ west: 2.1574, south: 41.3895, east: 2.1874, north: 41.4095 })
    expect(stage.primitives.gridMaterial).not.toBeNull()
  })
})

describe('场景换色 —— 切主题时各层材质的写入边界', () => {
  it('道路（polyline）的 setter 一次都没被调用：道路只改值不换对象', async () => {
    const { stage, roads } = await makeLoadedStage()
    const polylineWritesBefore = roads.map(item => item.writes.length)

    stage.applyTheme(GRAPHITE)

    expect(roads.map(item => item.writes.length)).toEqual(polylineWritesBefore)
  })

  it('建筑面每切一次主题重新赋一次材质（Cesium 的逐实例颜色是更新时烘焙的）', async () => {
    const { stage, buildings } = await makeLoadedStage()
    const polygonWritesBefore = buildings.map(item => item.writes.length)

    stage.applyTheme(GRAPHITE)

    buildings.forEach((item, index) => {
      expect(item.writes.length).toBe(polygonWritesBefore[index] + 1)
    })
    // 换上去的是**常量材质属性** → 几何仍是静态的，不是每帧重建
    const written = buildings[0].writes[buildings[0].writes.length - 1] as unknown as {
      color?: { isConstant?: boolean }
    }
    expect(written.color?.isConstant).toBe(true)
  })

  it('连切三次主题：道路依然零写入', async () => {
    const { stage, buildings, roads } = await makeLoadedStage()
    const polygonWritesBefore = buildings.map(item => item.writes.length)
    const polylineWritesBefore = roads.map(item => item.writes.length)

    stage.applyTheme(GRAPHITE)
    stage.applyTheme(DEEP_SPACE)
    stage.applyTheme(GRAPHITE)

    buildings.forEach((item, index) => {
      expect(item.writes.length).toBe(polygonWritesBefore[index] + 3)
    })
    expect(roads.map(item => item.writes.length)).toEqual(polylineWritesBefore)
  })
})

describe('场景换色 —— 八处颜色都跟着主题走', () => {
  it('地面 / 背景 / 建筑本体 / 描边 / 道路 / 流动光效 / 网格 全部换成新主题的值', async () => {
    const { stage } = await makeLoadedStage()
    stage.createBaseGrid({ west: 2.1574, south: 41.3895, east: 2.1874, north: 41.4095 })
    const viewer = stage.viewer.value as unknown as StubViewer

    stage.applyTheme(GRAPHITE)

    // 地面与背景
    const ground = viewer.scene.globe.baseColor as { name?: string }
    expect(ground.name).toBe(GRAPHITE.palette.screen)
    const background = viewer.scene.backgroundColor as { name?: string }
    expect(background.name).toBe(GRAPHITE.palette.screen)

    // 建筑本体
    const building = stage.primitives.buildingMaterial
    expect(building?.hex).toBe(GRAPHITE.palette.building)
    // 颜色在 ColorMaterialProperty 的常量回调上（每帧重读 → 换色即时生效）
    const buildingColor = building?.material?.color?.getValue() as unknown as {
      name?: string
    }
    expect(buildingColor?.name).toBe(GRAPHITE.palette.building)

    // 建筑描边（Primitive 材质的 uniform）—— 取 buildingEdge，不是界面 accent
    const glow = stage.primitives.buildingGlowMaterial as unknown as {
      uniforms: { color: { name?: string }; glowPower: number }
    }
    expect(glow.uniforms.color.name).toBe(GRAPHITE.palette.buildingEdge)
    expect(glow.uniforms.glowPower).toBe(GRAPHITE.glow.buildingPower)

    // 道路（五档）
    stage.primitives.roadMaterials.forEach((material, key) => {
      expect(material.hex).toBe(GRAPHITE.roadColors[key])
      expect(material.glowPower).toBe(GRAPHITE.glow.roadPower)
    })

    // 流动光效（颜色 + 不透明度：不透明度跟主题的 flowAlpha 走）
    const flow = stage.primitives.flowMaterial as unknown as {
      uniforms: { color: { name?: string; alpha: number } }
    }
    expect(flow.uniforms.color.name).toBe(GRAPHITE.palette.flow)
    expect(flow.uniforms.color.alpha).toBe(GRAPHITE.glow.flowAlpha)

    // 地面网格
    const grid = stage.primitives.gridMaterial as unknown as {
      uniforms: { color: { name?: string } }
    }
    expect(grid.uniforms.color.name).toBe(GRAPHITE.palette.secondary)
  })

  it('切回原主题时颜色也回到原值', async () => {
    const { stage } = await makeLoadedStage()
    stage.applyTheme(GRAPHITE)
    stage.applyTheme(DEEP_SPACE)
    expect(stage.primitives.buildingMaterial?.hex).toBe(DEEP_SPACE.palette.building)
    const glow = stage.primitives.buildingGlowMaterial as unknown as {
      uniforms: { color: { name?: string } }
    }
    expect(glow.uniforms.color.name).toBe(DEEP_SPACE.palette.buildingEdge)
  })

  it('没有场景时切主题也不炸（界面层先换主题、场景后起来）', () => {
    const container = ref<HTMLDivElement | null>(null)
    const stage = useSceneStage({
      container,
      buildings: shallowRef<BuildingsResponse | null>(null),
      roads: shallowRef<RoadsResponse | null>(null),
    })
    expect(() => stage.applyTheme(GRAPHITE)).not.toThrow()
  })
})

describe('场景换色 —— 耗时', () => {
  it('切主题在 100 ms 内完成（不重建几何）', async () => {
    const { stage } = await makeLoadedStage()
    const started = performance.now()
    stage.applyTheme(GRAPHITE)
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(100)
  })
})
