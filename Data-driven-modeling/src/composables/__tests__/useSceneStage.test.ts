import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, shallowRef } from 'vue'
import type { Ref } from 'vue'

vi.mock('cesium', async () => {
  const { createCesiumStub } = await import('./cesiumStub')
  return createCesiumStub()
})

import {
  BUILDING_GLOW_WIDTH,
  FLOW_DASH_LENGTH,
  GRID_ALTITUDE_M,
  GRID_SPACING_M,
  ROAD_TIER_BY_HIGHWAY,
  cityConfig,
  collectBuildingOutlines,
  computeExtent,
  nextPaint,
  parseHeightMeters,
  readRawTag,
  readTag,
  resolveBuildingHeight,
  resolveRoadTier,
  resolveRoadWidth,
  useSceneStage,
} from '../useSceneStage'
import { getCesiumStub } from './cesiumStub'
import type { StubEntity, StubViewer } from './cesiumStub'
import type { BuildingsResponse, RoadsResponse } from '../../../types/city'

const stub = () => getCesiumStub()

/** 网格 Primitive 的形状（只看几何实例的端点）。 */
interface GridPrimitive {
  geometryInstances: Array<{ geometry: { positions: Array<{ x: number; z: number }> } }>
}

beforeEach(() => {
  vi.clearAllMocks()
  stub().GeoJsonDataSource.load.mockResolvedValue({ entities: { values: [] } })
})

/* ---------------------------------------------------------------------------
 * 纯函数：标签读取 / 高度 / 道路分级 / 范围
 * ------------------------------------------------------------------------- */

describe('useSceneStage 的纯函数', () => {
  it('readTag 只认能 getValue 的 Property', () => {
    expect(readTag(undefined, 'height')).toBeUndefined()
    expect(readTag({} as never, 'height')).toBeUndefined()
    expect(readTag({ height: { getValue: () => '12' } } as never, 'height')).toBe('12')
    // 不是 Property 的东西一律当作「没有这个标签」
    expect(readTag({ height: 42 } as never, 'height')).toBeUndefined()
  })

  it('readRawTag 把 null / undefined 都算成「没有」', () => {
    expect(readRawTag(undefined, 'highway')).toBeUndefined()
    expect(readRawTag({ highway: null }, 'highway')).toBeUndefined()
    expect(readRawTag({ highway: undefined }, 'highway')).toBeUndefined()
    expect(readRawTag({ highway: 'primary' }, 'highway')).toBe('primary')
  })

  it('parseHeightMeters 只收正数', () => {
    expect(parseHeightMeters(true)).toBeNull()
    expect(parseHeightMeters('abc')).toBeNull()
    expect(parseHeightMeters(Infinity)).toBeNull()
    expect(parseHeightMeters(0)).toBeNull()
    expect(parseHeightMeters(-3)).toBeNull()
    expect(parseHeightMeters('12.5')).toBe(12.5)
  })

  it('resolveBuildingHeight: height → levels × 3 → 兜底', () => {
    expect(resolveBuildingHeight(() => '18', 30)).toBe(18)
    expect(resolveBuildingHeight(key => (key === 'building:levels' ? '4' : undefined), 30)).toBe(12)
    expect(resolveBuildingHeight(() => undefined, 30)).toBe(30)
    // 非法的高度标签不生效（走兜底），但层数仍然可用
    expect(resolveBuildingHeight(key => (key === 'height' ? '0' : key === 'building:levels' ? '2' : undefined), 30)).toBe(6)
  })

  it('resolveRoadTier 按 highway 标签查表，表外落兜底', () => {
    expect(resolveRoadTier('primary').name).toBe('主干道')
    expect(resolveRoadTier(' PRIMARY ').name).toBe('主干道')
    expect(resolveRoadTier('motorway_link').name).toBe('其他道路')
    expect(resolveRoadTier(undefined).name).toBe('其他道路')
    expect(resolveRoadTier(42).name).toBe('其他道路')
    expect(ROAD_TIER_BY_HIGHWAY.get('footway')?.width).toBe(2)
  })

  it('道路分级宽度是砍半后的 7/5/3/2，兜底分级也是 2', () => {
    // 宽度是**几何属性**：全局一份默认，所有主题共享（不做成主题项）
    expect(cityConfig.roadTiers.map(tier => tier.width)).toEqual([7, 5, 3, 2])
    expect(cityConfig.roadFallbackTier.width).toBe(2)
    expect(ROAD_TIER_BY_HIGHWAY.get('primary')?.width).toBe(7)
    expect(ROAD_TIER_BY_HIGHWAY.get('secondary')?.width).toBe(5)
    expect(ROAD_TIER_BY_HIGHWAY.get('residential')?.width).toBe(3)
    expect(ROAD_TIER_BY_HIGHWAY.get('footway')?.width).toBe(2)
  })

  it('resolveRoadWidth 只在「正数且不超纲」时采用标签值', () => {
    const tier = resolveRoadTier('primary')
    expect(resolveRoadWidth(tier, '5')).toBe(5)
    // 超纲（标签宽度大于该分级默认宽度）一律回落默认宽度
    expect(resolveRoadWidth(tier, '8')).toBe(tier.width)
    expect(resolveRoadWidth(tier, '30')).toBe(tier.width)
    expect(resolveRoadWidth(tier, '0')).toBe(tier.width)
    expect(resolveRoadWidth(tier, '-4')).toBe(tier.width)
    expect(resolveRoadWidth(tier, 'abc')).toBe(tier.width)
  })

  it('computeExtent 覆盖三种几何，算不出来时返回 null', () => {
    const extent = computeExtent([
      {
        features: [
          { geometry: { type: 'Polygon', coordinates: [[[116.39, 39.9], [116.42, 39.9], [116.42, 39.92]]] } },
          { geometry: { type: 'MultiPolygon', coordinates: [[[[116.40, 39.91], [116.41, 39.91], [116.41, 39.93]]]] } },
          { geometry: { type: 'LineString', coordinates: [[116.38, 39.89], [116.43, 39.94]] } },
        ],
      },
    ])
    expect(extent).not.toBeNull()
    expect(extent!.west).toBeCloseTo(116.38)
    expect(extent!.east).toBeCloseTo(116.43)
    expect(extent!.south).toBeCloseTo(39.89)
    expect(extent!.north).toBeCloseTo(39.94)

    expect(computeExtent([])).toBeNull()
    expect(computeExtent([{ features: [] }])).toBeNull()
  })

  it('collectBuildingOutlines 把每个面闭合成一条轮廓，忽略非面要素与碎环', () => {
    const instances = collectBuildingOutlines([
      {
        geometry: {
          type: 'Polygon',
          coordinates: [[[116.4, 39.9], [116.401, 39.9], [116.401, 39.901], [116.4, 39.9]]],
        },
        properties: { height: '10' },
      },
      {
        geometry: {
          type: 'MultiPolygon',
          coordinates: [[[[116.4, 39.9], [116.401, 39.9], [116.401, 39.901]]]],
        },
      },
      // 点不到三个点的环：几何退化，跳过
      { geometry: { type: 'Polygon', coordinates: [[[116.4, 39.9], [116.401, 39.9]]] } },
      // 不是面：没有轮廓
      { geometry: { type: 'LineString', coordinates: [[116.4, 39.9], [116.401, 39.9]] } },
    ])
    // Polygon 1 条 + MultiPolygon 1 条
    expect(instances).toHaveLength(2)
    const positions = (instances[0].geometry as unknown as { positions: Array<{ z: number }> }).positions
    // 4 个点 + 闭合回起点 = 5 个位置
    expect(positions).toHaveLength(5)
    // 高度 = height 10 + 抬升 0.5
    expect(positions[0].z).toBeCloseTo(10.5)
    const widths = instances.map(
      instance => (instance.geometry as unknown as { width: number }).width,
    )
    expect(widths).toEqual([BUILDING_GLOW_WIDTH, BUILDING_GLOW_WIDTH])
  })

  it('nextPaint 在没有 requestAnimationFrame 时也能兑现', async () => {
    const original = globalThis.requestAnimationFrame
    // 故意把 rAF 摘掉，模拟后台标签页
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    await expect(nextPaint()).resolves.toBeUndefined()
    globalThis.requestAnimationFrame = original
  })
})

/* ---------------------------------------------------------------------------
 * 场景底座
 * ------------------------------------------------------------------------- */

/** 造一个场景底座（带一个假的相机接线）。 */
const makeStage = (options: {
  buildings?: BuildingsResponse | null
  roads?: RoadsResponse | null
} = {}) => {
  const container = ref<HTMLDivElement | null>(document.createElement('div'))
  const buildings = shallowRef<BuildingsResponse | null>(options.buildings ?? null)
  const roads = shallowRef<RoadsResponse | null>(options.roads ?? null)
  const stage = useSceneStage({ container, buildings, roads })
  const camera = {
    attach: vi.fn(),
    flyToOverhead: vi.fn(),
  }
  return { stage, camera, container, buildings, roads }
}

describe('useSceneStage', () => {
  it('没有容器时不建 Viewer', async () => {
    const buildings = shallowRef<BuildingsResponse | null>(null)
    const roads = shallowRef<RoadsResponse | null>(null)
    const stage = useSceneStage({ container: ref(null), buildings, roads })
    await stage.initCesium({ attach: vi.fn(), flyToOverhead: vi.fn() })
    expect(stage.viewer.value).toBeNull()
  })

  it('initCesium 建 Viewer、铺深色底座、接上相机并开场定位', async () => {
    const { stage, camera } = makeStage()
    await stage.initCesium(camera)

    const viewer = stage.viewer.value as unknown as StubViewer
    expect(viewer).not.toBeNull()
    // 深色底座：地面底色、光照、大气全关
    expect(viewer.scene.globe.baseColor).toBeTruthy()
    expect(viewer.scene.globe.enableLighting).toBe(false)
    expect(viewer.scene.globe.showGroundAtmosphere).toBe(false)
    expect(viewer.scene.skyAtmosphere.show).toBe(false)
    expect(viewer.scene.backgroundColor).toBeTruthy()
    // 相机接线
    expect(camera.attach).toHaveBeenCalledWith(viewer)
    expect(camera.flyToOverhead).toHaveBeenCalledWith({ duration: 2, resync: false })
  })

  it('optimizePerformance 开雾、抗锯齿、限帧', () => {
    const { stage, camera } = makeStage()
    return stage.initCesium(camera).then(() => {
      stage.optimizePerformance()
      const viewer = stage.viewer.value as unknown as StubViewer
      expect(viewer.scene.fog.density).toBeGreaterThan(0)
      expect(viewer.scene.fog.near).toBeGreaterThan(0)
      expect(viewer.scene.fog.far).toBeGreaterThan(viewer.scene.fog.near)
      expect(viewer.scene.postProcessStages.fxaa.enabled).toBe(true)
      expect(viewer.scene.maximumFrameRate).toBe(60)
    })
  })

  it('loadGeoJSONBuildings 没有数据时什么都不做', async () => {
    const { stage, camera } = makeStage()
    await stage.initCesium(camera)
    await stage.loadGeoJSONBuildings()
    expect(stub().GeoJsonDataSource.load).not.toHaveBeenCalled()
    expect(stage.state.buildingEntities).toHaveLength(0)
  })

  it('loadGeoJSONBuildings 给实体定高、铺深色本体，并批量画描边', async () => {
    const building = {
      position: null,
      show: true,
      point: {},
      polygon: {},
      polyline: {},
      properties: { height: { getValue: () => '24' } },
    } as unknown as StubEntity
    stub().GeoJsonDataSource.load.mockResolvedValue({ entities: { values: [building] } })

    const { stage, camera } = makeStage({
      buildings: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { height: '24' },
            geometry: {
              type: 'Polygon',
              coordinates: [[[116.4, 39.9], [116.401, 39.9], [116.401, 39.901], [116.4, 39.9]]],
            },
          },
        ],
      },
    })
    await stage.initCesium(camera)
    await stage.loadGeoJSONBuildings()

    const viewer = stage.viewer.value as unknown as StubViewer
    expect(stage.state.buildingEntities).toContain(building)
    expect(building.polygon.extrudedHeight).toBe(24)
    expect(building.polygon.outline).toBe(false)
    expect(building.polygon.material).toBeTruthy()
    expect(viewer.dataSources.add).toHaveBeenCalledTimes(1)
    // 全量描边：一条批量 Primitive
    expect(viewer.scene.primitives.add).toHaveBeenCalledTimes(1)
    expect(stage.primitives.buildingGlow).not.toBeNull()
    expect(stage.primitives.buildingGlowMaterial).not.toBeNull()
  })

  it('loadGeoJSONBuildings 跳过没有 polygon 的要素', async () => {
    // 真 Cesium 里，非面要素没有 polygon 属性（这里是 undefined）
    const point = {
      position: null,
      show: true,
      point: {},
      polygon: undefined,
      polyline: undefined,
    } as unknown as StubEntity
    stub().GeoJsonDataSource.load.mockResolvedValue({ entities: { values: [point] } })
    const { stage, camera } = makeStage({
      buildings: { type: 'FeatureCollection', features: [] },
    })
    await stage.initCesium(camera)
    await stage.loadGeoJSONBuildings()
    expect(stage.state.buildingEntities).toHaveLength(0)
  })

  it('loadGeoJSONBuildings 装载失败时只记日志，不抛', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    stub().GeoJsonDataSource.load.mockRejectedValue(new Error('boom'))
    const { stage, camera } = makeStage({
      buildings: { type: 'FeatureCollection', features: [] },
    })
    await stage.initCesium(camera)
    await expect(stage.loadGeoJSONBuildings()).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('loadGeoJSONRoads 按 highway 分级上色，广场拿深色材质', async () => {
    const primary = {
      position: null,
      show: true,
      point: {},
      polygon: {},
      polyline: { material: { name: '' }, width: 0 },
      properties: { highway: { getValue: () => 'primary' } },
    } as unknown as StubEntity
    const plaza = {
      position: null,
      show: true,
      point: {},
      polygon: {},
      polyline: undefined,
      properties: { highway: { getValue: () => undefined } },
    } as unknown as StubEntity
    stub().GeoJsonDataSource.load.mockResolvedValue({ entities: { values: [primary, plaza] } })

    const { stage, camera } = makeStage({
      roads: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { highway: 'primary' },
            geometry: { type: 'LineString', coordinates: [[116.39, 39.9], [116.42, 39.9]] },
          },
        ],
      },
    })
    await stage.initCesium(camera)
    await stage.loadGeoJSONRoads()

    expect(primary.polyline.width).toBe(7)
    expect(primary.polyline.clampToGround).toBe(true)
    expect(stage.state.roadEntities).toContain(primary)
    expect(stage.state.roadEntities).toContain(plaza)
    expect(plaza.polygon.material).toBeTruthy()
    expect(plaza.polygon.outline).toBe(false)
  })

  it('loadGeoJSONRoads 给 1~2 级道路叠一层流动光效', async () => {
    const { stage, camera } = makeStage({
      roads: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { highway: 'primary' },
            geometry: { type: 'LineString', coordinates: [[116.39, 39.9], [116.42, 39.9]] },
          },
        ],
      },
    })
    await stage.initCesium(camera)
    await stage.loadGeoJSONRoads()
    expect(stage.primitives.flow).not.toBeNull()
    expect(stage.primitives.flowMaterial).not.toBeNull()
  })

  it('loadGeoJSONRoads 没有数据时什么都不做', async () => {
    const { stage, camera } = makeStage()
    await stage.initCesium(camera)
    await stage.loadGeoJSONRoads()
    expect(stub().GeoJsonDataSource.load).not.toHaveBeenCalled()
  })

  it('createBaseGrid 在数据范围上铺一层发光网格', async () => {
    const { stage, camera } = makeStage()
    await stage.initCesium(camera)
    stage.createBaseGrid({ west: 116.39, south: 39.9, east: 116.42, north: 39.92 })
    const viewer = stage.viewer.value as unknown as StubViewer
    expect(viewer.scene.primitives.add).toHaveBeenCalledTimes(1)
    const primitive = viewer.scene.primitives.add.mock.calls[0][0] as GridPrimitive
    expect(primitive.geometryInstances.length).toBeGreaterThan(0)
    // 网格线抬到 1.5 m，避免与地面 z-fighting
    expect(primitive.geometryInstances[0].geometry.positions[0].z).toBe(GRID_ALTITUDE_M)
    // 竖线间距 ≈ GRID_SPACING_M
    const verticals = primitive.geometryInstances.filter(
      instance => instance.geometry.positions[0].x === instance.geometry.positions[1].x,
    )
    expect(verticals.length).toBeGreaterThan(1)
  })

  it('toggleBuildings / toggleRoads 同步实体与 Primitive 的显隐', async () => {
    const building = { position: null, show: true, point: {}, polygon: {}, polyline: {} } as unknown as StubEntity
    const road = { position: null, show: true, point: {}, polygon: {}, polyline: {} } as unknown as StubEntity
    stub().GeoJsonDataSource.load.mockResolvedValue({ entities: { values: [building, road] } })

    const { stage, camera } = makeStage({
      buildings: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { height: '24' },
            geometry: {
              type: 'Polygon',
              coordinates: [[[116.4, 39.9], [116.401, 39.9], [116.401, 39.901], [116.4, 39.9]]],
            },
          },
        ],
      },
      roads: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { highway: 'primary' },
            geometry: { type: 'LineString', coordinates: [[116.39, 39.9], [116.42, 39.9]] },
          },
        ],
      },
    })
    await stage.initCesium(camera)
    await stage.loadGeoJSONBuildings()
    await stage.loadGeoJSONRoads()

    stage.toggleBuildings()
    expect(stage.state.buildingVisible).toBe(false)
    expect(building.show).toBe(false)
    expect(stage.primitives.buildingGlow!.show).toBe(false)
    stage.toggleBuildings()
    expect(stage.state.buildingVisible).toBe(true)
    expect(building.show).toBe(true)

    stage.toggleRoads()
    expect(stage.state.roadVisible).toBe(false)
    expect(road.show).toBe(false)
    expect(stage.primitives.flow!.show).toBe(false)
    stage.toggleRoads()
    expect(stage.state.roadVisible).toBe(true)
  })

  it('destroyViewer 销毁并置空', async () => {
    const { stage, camera } = makeStage()
    await stage.initCesium(camera)
    const viewer = stage.viewer.value as unknown as StubViewer
    stage.destroyViewer()
    expect(viewer.destroy).toHaveBeenCalled()
    expect(stage.viewer.value).toBeNull()
    // 再调一次不炸
    stage.destroyViewer()
  })

  it('卸载后（mounted=false）不再往场景里挂东西', async () => {
    const { stage, camera } = makeStage({
      buildings: { type: 'FeatureCollection', features: [] },
    })
    await stage.initCesium(camera)
    stage.mounted.value = false
    await stage.loadGeoJSONBuildings()
    expect(stage.state.buildingEntities).toHaveLength(0)
  })

  it('城心与网格间距是约定的常量', () => {
    expect(cityConfig.center).toEqual({ lng: 116.3976, lat: 39.9055 })
    expect(cityConfig.zoomLevel).toBe(1500)
    expect(cityConfig.streetLevel).toEqual({ height: 1.7, heading: 0 })
    expect(GRID_SPACING_M).toBe(200)
    expect(FLOW_DASH_LENGTH).toBe(24)
  })
})

/* ---------------------------------------------------------------------------
 * 类型守卫：Ref 的形状不被破坏
 * ------------------------------------------------------------------------- */

describe('useSceneStage 的输入契约', () => {
  it('接受 Ref 形式的容器与数据', () => {
    const container: Ref<HTMLDivElement | null> = ref(null)
    const buildings: Ref<BuildingsResponse | null> = shallowRef(null)
    const roads: Ref<RoadsResponse | null> = shallowRef(null)
    const stage = useSceneStage({ container, buildings, roads })
    expect(stage.viewer.value).toBeNull()
    expect(stage.state.viewMode).toBe('overhead')
  })
})
