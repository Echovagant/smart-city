import { markRaw, reactive, ref } from 'vue'
import type { Ref } from 'vue'
import * as Cesium from 'cesium'
import {
  createFlowDashMaterial,
  createLiveColorMaterial,
  createLiveGlowMaterial,
  createPrimitiveGlowMaterial,
  cssColor,
  getActiveTheme,
  gridColor,
  setActiveTheme,
  setLiveColor,
  setLiveGlow,
  setMaterialColor,
} from '@/theme/dark'
import type { LiveColorMaterial, LiveGlowMaterial } from '@/theme/dark'
import type { ThemeDefinition, ThemeRoadColors } from '@/theme/themes/types'
import type {
  BuildingsResponse,
  CityViewState,
  HeightMeters,
  LngLat,
  OSMTagReader,
  Position,
  RoadTier,
  RoadsResponse,
  ViewerConstructorOptions,
  WritablePolygonGraphics,
  WritablePolylineGraphics,
} from '../../types/city'

/**
 * 场景底座：Cesium 初始化、深色场景、发光网格、建筑与道路装配、批量描边。
 *
 * **共享可变状态只有这一份**：
 * - `viewer` —— Cesium 视图；
 * - `primitives` —— 场景里所有批量 Primitive 的引用与材质；
 * - `state` —— 图层显隐 / 视角模式 / 三组实体列表。
 *
 * 其余 composable（相机、交通、事件标记、页签联动）都从这里**拿引用**，
 * 不复制、不另存 —— 两份就是不同步的隐患。
 */

/* ---------------------------------------------------------------------------
 * 城市配置
 * ------------------------------------------------------------------------- */

/** 道路分级在主题道路色里的键。 */
export type RoadColorKey = keyof ThemeRoadColors

/** 全部道路分级的配色键（主干道 / 次干道 / 支路 / 人行道 / 兜底）。 */
export const ROAD_COLOR_KEYS: RoadColorKey[] = [
  'main',
  'secondary',
  'local',
  'footway',
  'fallback',
]

/** 道路分级 + 渲染参数（颜色是色板里的 CSS 值，材质在装载时按分级现造）。 */
export interface RenderedRoadTier extends RoadTier {
  /** 该档在主题道路色里的键（换主题时按它取色）。 */
  roadKey: RoadColorKey
  /** 该档的线色 —— **随主题变**（读当前主题的同键颜色）。 */
  color: string
  /** 是否叠一层流动光效（只给 1~2 级道路，全加会糊）。 */
  flowing: boolean
}

/**
 * 一座城市的场景参数。
 *
 * 城心 / 平视落点**逐城不同** —— 它们是这套数据的事实，不是通用常量。
 */
export interface CityScene {
  /**
   * 城心：相机绕行中心 + 全市级事件标记的落点。
   *
   * 选它的依据是**实测**：不在任何建筑多边形内，且离最近的建筑边界够远 ——
   * 站在露天，而不是站在某栋楼的屋顶上（事件光柱是 300 m 高的，落点被楼压着不好看）。
   */
  center: LngLat
  /** 鸟瞰高度（米）。 */
  zoomLevel: number
  /**
   * 平视模式的落点。
   *
   * 缺省时回落到 `center`。
   */
  streetPosition?: LngLat
}

/**
 * 每座城市的场景参数。键是城市 id（与后端 `city_data/cities.py` 一致）。
 *
 * 巴塞罗那：Eixample 街区腹地的一处开口，离最近建筑 24.6 m；
 * 平视落点取圣家堂南侧的**加泰罗尼亚广场**（离最近建筑 47.5 m，离圣家堂 113 m），
 * 正南朝北（heading=0）能看见圣家堂的塔尖。
 *
 * 米兰：大教堂与老城之间；平视落点取大教堂正南的**大教堂广场**。
 */
export const CITY_SCENES: Record<string, CityScene> = {
  barcelona: {
    center: { lng: 2.1652, lat: 41.39585 },
    zoomLevel: 1500,
    streetPosition: { lng: 2.1736, lat: 41.4026 },
  },
  milano: {
    center: { lng: 9.1919, lat: 45.4642 },
    zoomLevel: 1500,
    streetPosition: { lng: 9.1919, lat: 45.46355 },
  },
}

/** 城市配置参数。 */
export interface CityConfig {
  center: LngLat
  /**
   * 平视模式的落点。
   *
   * 缺省时回落到 `center`。
   */
  streetPosition?: LngLat
  zoomLevel: number
  streetLevel: { height: number; heading: number }
  defaultBuildingHeight: number
  roadTiers: RenderedRoadTier[]
  roadFallbackTier: RenderedRoadTier
}

export const cityConfig: CityConfig = {
  // Eixample 街区腹地的一处开口：全项目只有一个「城心」—— 就是这里的 `center`，
  // 相机的绕行中心、全市级事件标记的落点都指向它。
  // 后端那个「数据范围中心」（OSM 围盒中心）与它**不是同一个点**，
  // **不能**拿来放标记（默认鸟瞰视角下会落在屏幕之外）。
  center: { lng: 2.1652, lat: 41.39585 },
  zoomLevel: 1500,
  // 平视模式的落点**单独给一个**：城心在街区内部，1.7 m 的相机停在那里会钻进建筑里。
  // 这里取圣家堂南侧的**加泰罗尼亚广场**（离最近建筑 47.5 m，离圣家堂 113 m），
  // 正南朝北（heading=0）能看见圣家堂的塔尖。
  streetPosition: { lng: 2.1736, lat: 41.4026 },
  // 平视视角：1.7m 是人眼高度，朝向正北（heading=0）
  streetLevel: { height: 1.7, heading: 0 },
  // 建筑没有任何高度标签时的兜底高度（米）
  defaultBuildingHeight: 30,
  // 道路分级表：按 OSM 的 highway 标签分级渲染。
  //
  // 读的是 highway，不是 type：实测提取数据里每条道路都带 highway，
  // 而 type 一个都没有（建筑上的 type 是 'multipolygon' 几何标签，与道路等级无关）。
  //
  // 实测标签分布（backend-python/geojson/roads.geojson，2026-10-24，3794 条道路）：
  //   footway 2138、cycleway 470、living_street 209、residential 201、secondary 179、
  //   pedestrian 129、tertiary 125、steps 105、service 93、primary 56、
  //   tertiary_link 38、corridor 33、secondary_link 12、construction 5、bus_stop 1
  // 分级就是照这个分布定的：人行道/步行区占了一半以上，所以给它们最细最浅的线。
  // `*_link` 是上级道路的匝道（归次干道），`living_street` 是共享居住街道（归支路）——
  // 不收进来的话近 300 条路会掉进「其他道路」兜底档。
  //
  // 宽度是**几何属性**，只能在装载时定：运行时改宽度会触发每条路的几何重建
  // （与「换材质对象」同源的禁忌，见 applyTheme 的说明）。所以宽度**不做成主题项** ——
  // 全局默认一份、所有主题共享，否则切主题会出现「颜色变了、宽度没变」的割裂。
  //
  // 这组宽度是原来的**一半**（14 / 10 / 7 / 4 → 7 / 5 / 3 / 2）：
  // 实测原来主干道 14 px ≈ 21 m 的地面线宽，比 30 m 高的建筑的竖向体量还大 ——
  // 「建筑小道路大」的根因之一。砍半之后道路退成底纹，建筑体块自己说话。
  roadTiers: [
    {
      name: '主干道',
      highway: ['motorway', 'trunk', 'primary'],
      roadKey: 'main',
      flowing: true,
      width: 7,
      get color() {
        return getActiveTheme().roadColors.main
      },
    },
    {
      name: '次干道',
      highway: ['secondary', 'tertiary', 'secondary_link', 'tertiary_link'],
      roadKey: 'secondary',
      flowing: true,
      width: 5,
      get color() {
        return getActiveTheme().roadColors.secondary
      },
    },
    {
      name: '支路',
      highway: ['residential', 'unclassified', 'service', 'living_street'],
      roadKey: 'local',
      flowing: true,
      width: 3,
      get color() {
        return getActiveTheme().roadColors.local
      },
    },
    {
      name: '人行道/步行区',
      highway: ['footway', 'pedestrian', 'steps', 'path', 'cycleway'],
      roadKey: 'footway',
      flowing: true,
      width: 2,
      get color() {
        return getActiveTheme().roadColors.footway
      },
    }
  ],
  // 兜底分级：highway 标签缺失、或取值不在上表里时用它。
  // OSM 的 highway 取值比上表多（motorway_link / living_street / track 等都在表外），
  // 没有兜底的话这些道路会没有样式。
  // 宽度取最低等级（2 px，与人行道同级），避免把未知道路画得比主干道还宽。
  roadFallbackTier: {
    name: '其他道路',
    roadKey: 'fallback',
    flowing: false,
    width: 2,
    get color() {
      return getActiveTheme().roadColors.fallback
    },
  }
}

/**
 * 切到某座城市的场景参数。
 *
 * **就地改** `cityConfig` 的城心 / 鸟瞰高度 / 平视落点 ——
 * 相机绕行、事件标记落点、交通生成这些都读的是 `cityConfig`，
 * 改完立刻生效，不用改各自的代码。
 *
 * 未知城市 id 不改任何东西（调用方负责先校验）。
 */
export function setActiveCityScene(cityId: string): boolean {
  const scene = CITY_SCENES[cityId]
  if (!scene) return false
  cityConfig.center = { ...scene.center }
  cityConfig.zoomLevel = scene.zoomLevel
  if (scene.streetPosition) {
    cityConfig.streetPosition = { ...scene.streetPosition }
  } else {
    cityConfig.streetPosition = { ...scene.center }
  }
  return true
}

/** highway 标签 → 分级 的查表，建一次就够（几千条道路各查一次）。 */
export const ROAD_TIER_BY_HIGHWAY = cityConfig.roadTiers.reduce((map, tier) => {
  tier.highway?.forEach(tag => map.set(tag, tier))
  return map
}, new Map<string, RenderedRoadTier>())

/** 按 highway 标签查道路分级：标签缺失或不在表内 → 兜底分级。 */
export const resolveRoadTier = (highwayTag: unknown): RenderedRoadTier => {
  if (typeof highwayTag !== 'string') return cityConfig.roadFallbackTier
  const tier = ROAD_TIER_BY_HIGHWAY.get(highwayTag.trim().toLowerCase())
  return tier || cityConfig.roadFallbackTier
}

/** 每纬度一度约合多少米（把米换算成经纬度偏移时用）。 */
export const METERS_PER_DEGREE_LAT = 111320

/** 读一个 OSM 标签值：Cesium 的 properties 是 PropertyBag，取值必须经过 getValue()。 */
export const readTag = (properties: Cesium.PropertyBag | undefined, key: string): unknown => {
  const prop = properties?.[key] as Cesium.Property | undefined
  if (!prop || typeof prop.getValue !== 'function') return undefined
  return prop.getValue()
}

/** 读原始 GeoJSON 里的 OSM 标签（不走 PropertyBag）。 */
export const readRawTag = (properties: Record<string, unknown> | undefined, key: string): unknown => {
  if (!properties) return undefined
  const value = properties[key]
  return value === undefined || value === null ? undefined : value
}

/** 把一个 OSM 高度类标签转成正数米数；无效或缺失时返回 null。 */
export const parseHeightMeters = (raw: unknown): HeightMeters => {
  if (typeof raw === 'boolean') return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return null
  return value
}

/**
 * 建筑高度：height（总高，米）→ building:levels × 3（层数估算）→ 兜底高度。
 *
 * OSM 标签一律是字符串，必须在读取边界处显式转成数字，
 * 绝不让原始字符串流进 extrudedHeight（Cesium 的槽位是 Property | number）。
 * 不用 roof:height：OSM 里它是屋顶构件相对建筑顶部的高度，不是建筑总高，
 * 单独使用会把 15 米的建筑算成 1~3 米。
 *
 * 标签读取做成参数（而不是写死 PropertyBag），是为了让「实体」与「原始 GeoJSON」
 * 两条路共用**同一份**高度口径 —— 批量描边的高度必须与建筑本体完全一致。
 */
export const resolveBuildingHeight = (read: OSMTagReader, fallback: number): number => {
  const direct = parseHeightMeters(read('height'))
  if (direct !== null) return direct
  const levels = parseHeightMeters(read('building:levels'))
  if (levels !== null) return levels * 3
  return fallback
}

/**
 * 道路宽度：优先用 OSM 的 width 标签（单位：米），但只在它是正数、
 * 且不超过该分级的默认宽度时才采用——数据里存在 '30' 这种异常值，
 * 直接采用会把人行道画成 30 米宽。非法或超纲一律用分级默认宽度。
 */
export const resolveRoadWidth = (tier: RenderedRoadTier, taggedWidth: unknown): number => {
  const width = Number(taggedWidth)
  return Number.isFinite(width) && width > 0 && width <= tier.width ? width : tier.width
}

/* ---------------------------------------------------------------------------
 * 渲染参数（一个都不许调 —— 这是重构，不是调优）
 * ------------------------------------------------------------------------- */

/** 数字底座的网格间距（米）。 */
export const GRID_SPACING_M = 200

/** 网格线离地面的高度（米）：抬一点点，避免与地面 z-fighting。 */
export const GRID_ALTITUDE_M = 1.5

/** 网格线的辉光强度。 */
export const GRID_GLOW_POWER = 0.3

/** 建筑描边的线宽（像素）。 */
export const BUILDING_GLOW_WIDTH = 2

/** 描边相对顶面的抬高（米）：避免与顶面 z-fighting。 */
export const BUILDING_OUTLINE_LIFT_M = 0.5

/** 流动光效的虚线基准长度（米）。 */
export const FLOW_DASH_LENGTH = 24

/** 流动光效一个完整来回的时长（秒）。 */
export const FLOW_PERIOD_SECONDS = 6

/* ---------------------------------------------------------------------------
 * 状态
 * ------------------------------------------------------------------------- */

/** 组件的视图状态 + 三组 Cesium 实体列表。 */
export interface SmartCityState extends CityViewState {
  buildingEntities: Cesium.Entity[]
  roadEntities: Cesium.Entity[]
  trafficEntities: Cesium.Entity[]
}

/**
 * 场景里所有批量 Primitive 的引用与材质 —— **全项目各只有这一份**。
 *
 * 建筑描边与流动光效层由本模块创建；焦点描边由页签联动创建，
 * 但也挂在这里：它同样是「场景级」的引用，卸载时要在同一个地方清掉。
 *
 * ## 材质为什么都存在这里
 *
 * 换主题时只允许「改值」，所以每一个会被换色的材质都必须**留一份引用**：
 * 网格材质以前是内联创建的（换主题拿不到手），现在补上了。
 */
export interface ScenePrimitives {
  /** 全量建筑描边（一个绘制调用管全部建筑）。 */
  buildingGlow: Cesium.Primitive | null
  /** 全量建筑描边的材质（页签联动改它的 color uniform）。 */
  buildingGlowMaterial: Cesium.Material | null
  /** 流动光效层（1~2 级道路）。 */
  flow: Cesium.Primitive | null
  /** 流动光效的材质：每帧改 `uniforms.dashLength` 推进相位。 */
  flowMaterial: Cesium.Material | null
  /** 焦点描边（页签联动用）。 */
  focusGlow: Cesium.Primitive | null
  /** 地面网格的材质（换主题改它的 color uniform）。 */
  gridMaterial: Cesium.Material | null
  /** 建筑本体材质 —— **全场共用这一个实例**（3854 栋楼不再各包一个）。 */
  buildingMaterial: LiveColorMaterial | null
  /** 广场 / 人造地面材质 —— 全场共用一个实例。 */
  surfaceMaterial: LiveColorMaterial | null
  /** 道路分级材质 —— 按分级共用（五档各一个实例）。 */
  roadMaterials: Map<RoadColorKey, LiveGlowMaterial>
}

/** 数据的经纬度范围。 */
export interface MapExtent {
  west: number
  south: number
  east: number
  north: number
}

/** 算出所有要素的经纬度范围；算不出来就返回 null（不画网格）。 */
export const computeExtent = (
  collections: Array<{ features: Array<{ geometry: { type: string; coordinates: unknown } }> }>,
): MapExtent | null => {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity

  const visit = (positions: Position[]) => {
    for (const position of positions) {
      const [lng, lat] = position
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
      if (lng < west) west = lng
      if (lng > east) east = lng
      if (lat < south) south = lat
      if (lat > north) north = lat
    }
  }

  for (const collection of collections) {
    for (const feature of collection.features) {
      const geometry = feature.geometry
      if (geometry.type === 'Polygon') {
        ;(geometry.coordinates as Position[][]).forEach(visit)
      } else if (geometry.type === 'MultiPolygon') {
        ;(geometry.coordinates as Position[][][]).forEach(polygon => polygon.forEach(visit))
      } else if (geometry.type === 'LineString') {
        visit(geometry.coordinates as Position[])
      }
    }
  }

  if (!Number.isFinite(west) || !Number.isFinite(south)) return null
  return { west, south, east, north }
}

/** 一条网格线（两端的经纬度 + 高度）。 */
const gridLine = (from: [number, number], to: [number, number]): Cesium.GeometryInstance => {
  const positions = [
    Cesium.Cartesian3.fromDegrees(from[0], from[1], GRID_ALTITUDE_M),
    Cesium.Cartesian3.fromDegrees(to[0], to[1], GRID_ALTITUDE_M)
  ]
  return new Cesium.GeometryInstance({
    geometry: new Cesium.PolylineGeometry({
      positions,
      width: 1,
      vertexFormat: Cesium.PolylineMaterialAppearance.VERTEX_FORMAT,
      arcType: Cesium.ArcType.GEODESIC
    })
  })
}

/** 能算建筑轮廓的原始要素（原始 GeoJSON 的那一支）。 */
export interface OutlinableFeature {
  geometry: { type: string; coordinates: unknown }
  properties?: Record<string, unknown>
}

/**
 * 建筑描边的几何实例（每个面的外环，抬到顶面高度处）。
 *
 * 「全量描边」与「焦点描边」（页签联动）**共用这一份实现** ——
 * 两者的差别只是建筑集合，高度口径必须完全一致，
 * 否则描边会与楼体对不齐。
 */
export const collectBuildingOutlines = (
  features: OutlinableFeature[],
): Cesium.GeometryInstance[] => {
  const instances: Cesium.GeometryInstance[] = []
  for (const feature of features) {
    const geometry = feature.geometry
    const height = resolveBuildingHeight(
      (key) => readRawTag(feature.properties, key),
      cityConfig.defaultBuildingHeight
    )
    const top = height + BUILDING_OUTLINE_LIFT_M

    // 每个面的外环（MultiPolygon 的每个子面各取各的环）
    const rings: Position[][] =
      geometry.type === 'Polygon'
        ? (geometry.coordinates as Position[][])
        : geometry.type === 'MultiPolygon'
          ? (geometry.coordinates as Position[][][]).flat()
          : []

    for (const ring of rings) {
      if (ring.length < 3) continue
      const positions = ring.map(
        (position) => Cesium.Cartesian3.fromDegrees(position[0], position[1], top)
      )
      // 闭合：末点回到起点
      positions.push(positions[0].clone())
      instances.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.PolylineGeometry({
            positions,
            width: BUILDING_GLOW_WIDTH,
            vertexFormat: Cesium.PolylineMaterialAppearance.VERTEX_FORMAT,
            // RHUMB：楼与楼之间的直线段，不做测地细分 —— 拐角是直角，
            // 而且省掉每个轮廓的弧线细分（3854 栋楼，这是最省的一刀）。
            arcType: Cesium.ArcType.RHUMB
          })
        })
      )
    }
  }
  return instances
}

/**
 * 等浏览器把当前这一帧画出来。
 *
 * 用它是为了让「面板先画出来、再去做几百毫秒的同步场景装配」——
 * 首屏 LCP 量的是页面文字块（面板上那行大号数字），不是画布：
 * 不让出这一帧的话，这行字要等装配完才画得出来，LCP 会被推到 3 秒以后。
 *
 * **必须有兜底**：后台标签页里 `requestAnimationFrame` 可能一直不触发，
 * 没有兜底的话加载会永远卡住（jsdom 测试环境里根本没有 rAF）。
 */
export const nextPaint = (): Promise<void> =>
  new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(done, 0)
      return
    }
    requestAnimationFrame(() => requestAnimationFrame(done))
    setTimeout(done, 100)
  })

/* ---------------------------------------------------------------------------
 * 场景底座
 * ------------------------------------------------------------------------- */

/**
 * 场景底座与相机之间的接线契约。
 *
 * 只声明底座**需要**的那两件事：挂上相机（交互监听 + 自转回调），
 * 以及开场的鸟瞰定位。具体的相机行为在 `useCameraRig` 里。
 */
export interface SceneCamera {
  /** 把相机装到这个 viewer 上（交互监听 + 每帧自转）。 */
  attach(viewer: Cesium.Viewer): void
  /** 飞到鸟瞰视角（开场定位用：不从相机当前位置反算轨道）。 */
  flyToOverhead(options?: { duration?: number; resync?: boolean }): void
}

/** 场景底座的输入。 */
export interface SceneStageOptions {
  /** Cesium 容器（组件里的 div ref）。 */
  container: Ref<HTMLDivElement | null>
  /** 建筑 GeoJSON（useCityData 给的那一份）。 */
  buildings: Ref<BuildingsResponse | null>
  /** 道路 GeoJSON。 */
  roads: Ref<RoadsResponse | null>
}

/** 场景底座对外暴露的东西。 */
export interface SceneStage {
  /** Cesium 视图（全项目唯一一份）。 */
  viewer: Ref<Cesium.Viewer | null>
  /** 视图状态 + 三组 Cesium 实体列表。 */
  state: SmartCityState
  /** 场景里所有批量 Primitive 的引用与材质（全项目唯一一份）。 */
  primitives: ScenePrimitives
  /** 组件是否还挂载着（异步装配路径的守卫）。 */
  mounted: Ref<boolean>
  /** 初始化 Cesium（建 Viewer、铺深色底座、接上相机、开场定位）。 */
  initCesium(camera: SceneCamera): Promise<void>
  /** 性能开关：雾、抗锯齿、限帧。 */
  optimizePerformance(): void
  /** 装载建筑（实体 + 批量描边）。 */
  loadGeoJSONBuildings(): Promise<void>
  /** 装载道路（实体 + 流动光效层）。 */
  loadGeoJSONRoads(): Promise<void>
  /** 在数据范围上铺出发光网格。 */
  createBaseGrid(extent: MapExtent): void
  /** 建筑图层显隐。 */
  toggleBuildings(): void
  /** 道路图层显隐。 */
  toggleRoads(): void
  /**
   * 把整套主题应用到场景（面板 CSS 由 `useTheme` 负责，这里只管 3D）。
   *
   * **只改值，不换对象**：材质实例全部保持原样，
   * 所以 Cesium 不会重建任何几何（3854 栋楼 / 2260 条路都不动）。
   */
  applyTheme(theme: ThemeDefinition): void
  /** 销毁 Viewer 并把引用置空。 */
  destroyViewer(): void
}

export function useSceneStage({ container, buildings, roads }: SceneStageOptions): SceneStage {
  const viewer = ref<Cesium.Viewer | null>(null)
  const mounted = ref(true)

  const state = reactive<SmartCityState>({
    buildingVisible: true,
    roadVisible: true,
    trafficVisible: true,
    viewMode: 'overhead', // 'overhead' 鸟瞰 | 'street' 平视
    buildingEntities: [],
    roadEntities: [],
    trafficEntities: []
  })

  const primitives: ScenePrimitives = {
    buildingGlow: null,
    buildingGlowMaterial: null,
    flow: null,
    flowMaterial: null,
    focusGlow: null,
    gridMaterial: null,
    buildingMaterial: null,
    surfaceMaterial: null,
    roadMaterials: new Map<RoadColorKey, LiveGlowMaterial>(),
  }

  /**
   * 当前生效的主题。
   *
   * 材质在**装载时**按它创建；`applyTheme` 会换掉它并就地改色。
   * 初值取模块里的当前主题（`useTheme` 写的），所以界面先换主题、
   * 场景后装载时，颜色也是对的。
   */
  let currentTheme: ThemeDefinition = getActiveTheme()

  /**
   * 深色底座：把 Cesium 默认的「灰蓝地球 + 蓝天」换成大屏配色。
   *
   * - 地面：baseColor 必设，否则球体是 Cesium 的默认灰蓝，很丑。
   * - 光照：关掉，地面亮度不随昼夜变，底色恒定。
   * - 大气：关掉（地平线那圈蓝雾与亮蓝天都是「刺眼」的来源）。
   * - 天空：保留 Cesium 自带的深色星空，只把背景色刷成大屏底色。
   */
  const applyDarkScene = (activeViewer: Cesium.Viewer) => {
    const scene = activeViewer.scene
    scene.globe.baseColor = cssColor(currentTheme.palette.screen)
    scene.globe.enableLighting = false
    scene.globe.showGroundAtmosphere = false
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false
    scene.backgroundColor = cssColor(currentTheme.palette.screen)
  }

  /**
   * 画一层发光网格 —— 「数字底座」最有辨识度的一层，成本极低。
   *
   * 走 Primitive（而不是几千个实体）：整层网格只有一次绘制调用。
   */
  const createBaseGrid = (extent: MapExtent) => {
    const activeViewer = viewer.value
    if (!activeViewer) return

    const centerLatRad = (cityConfig.center.lat * Math.PI) / 180
    const lonStep = GRID_SPACING_M / (METERS_PER_DEGREE_LAT * Math.cos(centerLatRad))
    const latStep = GRID_SPACING_M / METERS_PER_DEGREE_LAT

    const instances: Cesium.GeometryInstance[] = []
    for (let lng = extent.west; lng <= extent.east + 1e-9; lng += lonStep) {
      instances.push(gridLine([lng, extent.south], [lng, extent.north]))
    }
    for (let lat = extent.south; lat <= extent.north + 1e-9; lat += latStep) {
      instances.push(gridLine([extent.west, lat], [extent.east, lat]))
    }
    if (instances.length === 0) return

    // asynchronous: false —— 同步在主线程建几何。
    // 异步会走 worker，而本项目的 Cesium 运行时是**剪过枝**的，
    // 不确定那条 worker 还在不在（不在就是一次 404，回归脚本会红）。
    //
    // 材质单独存一份：换主题时要改它的 color uniform（改 uniform 不重建几何）。
    const material = createPrimitiveGlowMaterial(
      gridColor(),
      GRID_GLOW_POWER,
      currentTheme.glow.gridAlpha
    )
    primitives.gridMaterial = material
    const primitive = new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PolylineMaterialAppearance({
        material
      }),
      asynchronous: false
    })
    activeViewer.scene.primitives.add(primitive)
  }

  /**
   * 批量生成建筑描边。
   *
   * **必须批量**：3854 栋楼各建一个描边实体，实体数会翻倍到 ~7700，帧率会掉。
   * 这里把所有楼的闭合轮廓合成**一个** Primitive（一次绘制调用）。
   *
   * 描边画在**顶面高度**处：俯视看到的是屋顶轮廓，斜视看到的是发光的屋顶边线。
   */
  const createBuildingGlow = (features: OutlinableFeature[]) => {
    const activeViewer = viewer.value
    if (!activeViewer) return

    const instances = collectBuildingOutlines(features)
    if (instances.length === 0) return

    // 材质单独存一份：页签联动时要改它的 color uniform（压暗 / 恢复），
    // 换主题时也要改它 —— 改 uniform 不重建几何，这是最省的一刀。
    //
    // 描边取 `palette.buildingEdge` 而不是 `palette.accent`：
    // **描边是场景里的物体，accent 是界面里的强调**。哑光白模要浅灰细边
    // （像建模软件里的棱线），而界面强调色必须仍是可辨认的蓝 ——
    // 用同一个色位会让界面的选中态变成灰色，看着像禁用态。
    primitives.buildingGlowMaterial = createPrimitiveGlowMaterial(
      currentTheme.palette.buildingEdge,
      currentTheme.glow.buildingPower
    )

    // asynchronous: false —— 同步建几何，不去动剪过枝的 worker（见 createBaseGrid 的说明）。
    const primitive = new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PolylineMaterialAppearance({
        material: primitives.buildingGlowMaterial
      }),
      asynchronous: false
    })
    activeViewer.scene.primitives.add(primitive)
    primitives.buildingGlow = primitive
  }

  // 加载真实GeoJSON建筑数据（替换随机生成的建筑）
  const loadGeoJSONBuildings = async () => {
    if (!buildings.value) return
    try {
      // 使用 useCityData 已加载到内存的 GeoJSON 对象，避免再次发起 HTTP 请求。
      const dataSource = await Cesium.GeoJsonDataSource.load(buildings.value, {
        clampToGround: false,
      })
      if (!mounted.value) return

      const entities = dataSource.entities.values
      // 建筑本体材质 —— **全场共用这一个实例**。
      //
      // 以前是 `polygon.material = cssColor(...)`：Cesium 会给每栋楼各包一个
      // ColorMaterialProperty（3854 个），换色就得逐个改；整体换材质对象则
      // 会打散批处理 → 全量几何重建 → 卡死。
      //
      // 现在全部共用一个实例，颜色挂在它的 CallbackProperty 上：
      // 换主题 = 换一份颜色对象的分量 → 下一帧生效，**不重建任何几何**。
      primitives.buildingMaterial = createLiveColorMaterial(currentTheme.palette.building)
      const buildingMaterial = primitives.buildingMaterial
      entities.forEach(entity => {
        if (!mounted.value) return
        // OSM 数据里可能混进非 Polygon 的要素（Point/LineString 等），
        // 它们没有 polygon 属性，直接 entity.polygon.extrudedHeight = ... 会抛
        // "Cannot set properties of undefined"，而且 try/catch 会把整批加载中止。
        if (!entity.polygon) return
        // 建筑高度：height（米）→ building:levels × 3 → 兜底 30 米，
        // 显式转成数字，extrudedHeight 拿到的永远是数值而不是字符串
        const height = resolveBuildingHeight(
          (key) => readTag(entity.properties, key),
          cityConfig.defaultBuildingHeight
        )

        // Cesium 1.134 的 .d.ts 只把图元属性声明成 Property 一侧，运行时却接受
        // 裸值（内部自动包成 ConstantProperty）——WritablePolygonGraphics
        // 就是「运行时真正接受的写入类型」，见 types/city.ts。
        const polygon = entity.polygon as WritablePolygonGraphics
        polygon.extrudedHeight = height // 拉伸高度（米）
        // 统一的深色本体（顶面/侧面同色）。
        // 顶面亮一档需要 PerInstanceColorAppearance + 自定义材质，代价与收益不成比例，
        // 这里走「统一深色面 + 批量描边」这条路。
        //
        // 材质**只在这里设置一次**：换主题改的是共用实例里的颜色值，
        // 绝不回到这里重设（重设 = 换材质对象 = 重建几何）。
        polygon.material = buildingMaterial.material ?? cssColor(currentTheme.palette.building)
        // 不画 1px 描边：描边由下面的批量 Primitive 负责（带辉光）。
        // 留着 outline 会让每栋楼多一次绘制调用（3854 → 7708 次）。
        polygon.outline = false

        // 存入状态管理，用于控制显示/隐藏。
        // markRaw：Cesium Entity 是引擎对象，不是视图状态，
        // 别让 Vue 给它套一层响应式代理（几千个实体的代理开销与被代理对象内部行为都有风险）。
        state.buildingEntities.push(markRaw(entity))
      })

      if (mounted.value) {
        // mounted 为真时 viewer 一定还在（onUnmounted 会把两者一起置空）。
        viewer.value!.dataSources.add(dataSource)
        // 建筑描边：一次批量 Primitive 管全部建筑。
        createBuildingGlow(buildings.value.features)
      }
    } catch (error) {
      console.error('加载建筑 GeoJSON 失败:', error)
    }
  }

  /**
   * 取（必要时建）某档道路的**共享**材质。
   *
   * 五档各一个实例：换主题时每档改一次颜色与辉光强度，
   * 而不是逐条改 2260 个材质对象。
   */
  const roadMaterialFor = (key: RoadColorKey): LiveGlowMaterial => {
    const existing = primitives.roadMaterials.get(key)
    if (existing) return existing
    const created = createLiveGlowMaterial(
      currentTheme.roadColors[key],
      currentTheme.glow.roadPower,
      currentTheme.glow.roadAlpha
    )
    primitives.roadMaterials.set(key, created)
    return created
  }

  /** 加载真实GeoJSON道路数据 */
  const loadGeoJSONRoads = async () => {
    if (!roads.value) return
    try {
      // 使用 useCityData 已加载到内存的 GeoJSON 对象，避免再次发起 HTTP 请求。
      const dataSource = await Cesium.GeoJsonDataSource.load(roads.value, {
        clampToGround: true,
      })
      if (!mounted.value) return

      const entities = dataSource.entities.values
      // 广场 / 人造地面材质 —— 全场共用一个实例（305 个地面多边形不再各包一个）。
      // 取 `palette.surface` 而不是 `palette.panel`：广场是**场景里的一部分**，
      // 面板是大屏的 UI 底，两者是两回事。
      primitives.surfaceMaterial = createLiveColorMaterial(currentTheme.palette.surface, 0.9)
      const surfaceMaterial = primitives.surfaceMaterial
      entities.forEach(entity => {
        if (!mounted.value) return
        // OSM 道路数据里混着 Polygon/MultiPolygon（广场、人造地面等，实测 305 个）。
        // 它们没有 polyline 属性，直接 entity.polyline.width = ... 会抛
        // "Cannot set properties of undefined"。用 Cesium.defined 守门。
        //
        // **但不能就这么放过**：GeoJsonDataSource 给没设过 material 的要素发的是
        // **随机颜色**（Color.fromRandomColor），于是广场就会在深色底上留下一块
        // 随机色的斑（实测就是一片金黄）。这里显式给它们深色 —— 广场是地面的一部分。
        if (!entity.polyline) {
          if (entity.polygon) {
            const surface = entity.polygon as WritablePolygonGraphics
            surface.material = surfaceMaterial.material ?? cssColor(currentTheme.palette.surface, 0.9)
            surface.outline = false
            state.roadEntities.push(markRaw(entity))
          }
          return
        }
        // 按 OSM 的 highway 标签定级（type 标签在道路数据里根本不存在）
        const tier = resolveRoadTier(readTag(entity.properties, 'highway'))
        // 宽度：优先用 OSM 的 width 标签（单位：米），但只在它是正数、
        // 且不超过该分级的默认宽度时才采用——数据里存在 '30' 这种异常值，
        // 直接采用会把人行道画成 30 米宽。非法或超纲一律用分级默认宽度。
        const width = resolveRoadWidth(tier, readTag(entity.properties, 'width'))

        // 配置道路样式（同样是运行时可写视图，见 types/city.ts）
        const polyline = entity.polyline as WritablePolylineGraphics
        polyline.width = width // 道路宽度（始终是数字）
        // 道路材质**按分级共用**（五档各一个实例）：换主题时每档改一次颜色与辉光，
        // 而不是逐条改 2260 个材质。
        polyline.material = roadMaterialFor(tier.roadKey).material
        polyline.clampToGround = true // 贴地显示

        // 存入状态管理，用于控制显示/隐藏
        state.roadEntities.push(markRaw(entity))
      })

      // 流动光效：1~2 级道路额外叠一层推进的虚线（"数据流"）。
      // 全加会糊，所以只给主干道与次干道。
      //
      // **走一个 Primitive，不走实体**：
      // 实体的「非贴地 polyline」走 Cesium 的静态路径，它会建一个
      // `asynchronous: true` 的 Primitive → 需要 `Workers/createPolylineGeometry.js`
      // —— 那个 worker 被剪枝清单剪掉了 → 404 → **整个渲染循环停摆**
      // （实测：页面直接报 "An error occurred while rendering"）。
      // 自己建的 Primitive 走同步路径（asynchronous: false），不需要任何 worker，
      // 而且 100 多条流动线合成**一次**绘制调用。
      const flowInstances: Cesium.GeometryInstance[] = []
      for (const feature of roads.value.features) {
        const geometry = feature.geometry
        if (geometry.type !== 'LineString') continue
        const tier = resolveRoadTier(readRawTag(feature.properties, 'highway'))
        if (!tier.flowing) continue
        const width = resolveRoadWidth(tier, readRawTag(feature.properties, 'width'))
        const positions = (geometry.coordinates as Position[]).map((position) =>
          Cesium.Cartesian3.fromDegrees(position[0], position[1], 0)
        )
        if (positions.length < 2) continue
        flowInstances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.PolylineGeometry({
              positions,
              // 流动层与道路**同宽**（原来四档都正好等于路宽）。
              // 之前有个 `Math.max(3, width)` 的下限：路宽砍半后人行道是 2 px，
              // 那个下限会让流动层（3 px）比路本身还宽 —— 现在直接用路宽，
              // 保持「流动层正好盖在路面上」这个关系。
              width,
              vertexFormat: Cesium.PolylineMaterialAppearance.VERTEX_FORMAT,
              arcType: Cesium.ArcType.GEODESIC
            })
          })
        )
      }
      if (flowInstances.length > 0) {
        primitives.flowMaterial = createFlowDashMaterial(currentTheme.palette.flow, FLOW_DASH_LENGTH)
        // 不透明度取主题的 `glow.flowAlpha`（工厂里的 0.95 是硬编码的默认值）：
        // 这一层是**全场最刺眼的元素**（实测对底色 10.96 : 1，比主干道还亮），
        // 哑光白模主题把它压到 0.12 —— 保留一点「数据在流动」的提示，
        // 但不再抢建筑主体的注意力。
        // 改 uniform（换颜色对象的分量），不换材质对象。
        setMaterialColor(
          primitives.flowMaterial,
          currentTheme.palette.flow,
          currentTheme.glow.flowAlpha
        )
        const flowPrimitive = new Cesium.Primitive({
          geometryInstances: flowInstances,
          appearance: new Cesium.PolylineMaterialAppearance({ material: primitives.flowMaterial }),
          asynchronous: false
        })
        primitives.flow = flowPrimitive
        viewer.value!.scene.primitives.add(flowPrimitive)
      }

      if (mounted.value) {
        viewer.value!.dataSources.add(dataSource)
      }
    } catch (error) {
      console.error('加载道路 GeoJSON 失败:', error)
    }
  }

  // 初始化Cesium
  const initCesium = async (camera: SceneCamera) => {
    if (!container.value) return

    // 在第一次访问 Cesium 静态资源之前，必须把 base URL 设到 vite-plugins/cesium-assets
    // 挂载的 /Cesium/ 路径上。Cesium 内部用 getCesiumBaseUrl() (= Jt 工厂) 拼接
    // /Cesium/Workers/* / /Cesium/ThirdParty/* 等路径。漏设会回到 Cesium 默认
    // '/Cesium/' 路径，dev 阶段 Vite 兜底返回 index.html → "Failed to load module
    // script: text/html" + InvalidStateError。
    window.CESIUM_BASE_URL = '/Cesium/'

    // 关键洞察：Cesium 1.134 Viewer 默认会构造两个会触发 ion 401 的组件：
    //   1. baseLayerPicker：其 BaseLayerPickerViewModel 构造末尾执行
    //      `this.selectedImagery = n[0]`，n[0] = Bing Maps Aerial viewmodel，
    //      setter 立刻调 creationCommand() → createWorldImageryAsync()
    //      → IonImageryProvider.fromAssetId(2) → api.cesium.com 401。
    //   2. geocoder：GeocoderViewModel 构造时若 geocoderServices 为空，会默认
    //      new IonGeocoderService()，构造里立即访问 ion defaultAccessToken。
    // 必须显式两个都禁用。
    //
    // 副作用：baseLayerPicker: false 让 Viewer 的 n = (baseLayerPicker !== false)
    // 变 false → 传给 CesiumWidget 的 baseLayer 表达式
    //   (n && l(selectedVM)) || l(baseLayer) || l(imageryProvider) ? !1 : void 0
    // 在 baseLayer/imageryProvider 都 undefined 时结果为 void 0 (undefined)。
    // CesiumWidget 内部 `E !== !1` 短路（undefined !== false === true），但
    // l(undefined) === false → E = os.fromWorldImagery() → 又触发 ion！
    // 所以还必须显式传 baseLayer: false 才能让 CesiumWidget 完全跳过底图。
    //
    // **底座不再来自任何瓦片服务**：地面是我们自己画的（纯色 + 发光网格），
    // 建筑与道路也都画在 OSM 的原始 WGS-84 坐标上 —— 天然同坐标系，
    // GCJ-02 偏移（东 533 m / 北 156 m）因此自动消失。
    // 将来若有人把 GCJ-02 坐标系的瓦片加回来，偏移会**立刻回来**，详见 docs/ARCHITECTURE.md。
    //
    // errorHandler 不在 Cesium 1.134 的 Viewer.ConstructorOptions 里（运行时支持），
    // 所以用补过的 ViewerConstructorOptions——见 types/city.ts。
    //
    // 选项对象必须**内联**在 Viewer 的构造调用里：测试有一条源码文本断言，
    // 专门从这个调用的参数块里抠出选项、确认底图相关的三个开关都是 false
    // （见 src/components/__tests__/SmartCity.lifecycle.test.ts）。
    viewer.value = new Cesium.Viewer(container.value, {
      timeline: false,
      animation: false,
      homeButton: false,        // 浅色圆角按钮跟深色大屏不搭（计划书要求深色底座）
      sceneModePicker: false,   // 同上：2D/3D 切换在这里用不到
      navigationHelpButton: false,
      navigationInstructionsInitiallyVisible: false, // 同上：说明板跟深色大屏不搭
      baseLayerPicker: false, // 禁用底图切换 UI（避免 ion 401）
      geocoder: false,        // 禁用地理编码 UI（避免 ion 401）
      infoBox: false,         // 禁用信息框（消除 about:blank sandboxed iframe 警告）
      selectionIndicator: false, // 禁用选择指示器
      baseLayer: false,       // 显式告诉 CesiumWidget 完全不加底图（避免 fromWorldImagery）
      terrainProvider: undefined,
      useDefaultRenderLoop: true,
      sceneMode: Cesium.SceneMode.SCENE3D,
      errorHandler: function (error) {
        console.warn('Cesium初始化错误:', error)
      },
    } as ViewerConstructorOptions)

    applyDarkScene(viewer.value)
    // 相机装上：交互监听 + 每帧自转（自转回调也在相机那边）。
    camera.attach(viewer.value)

    // 底座自绘：影像图层数是 0（不接任何影像瓦片服务）。
    // 这行日志是回归脚本的探针 —— 它按 "Viewer created" 判定 Viewer 起来了。
    console.log(
      '[SmartCity] Viewer created. imagery layers:',
      viewer.value.imageryLayers.length,
      '(0 = 底座自绘，没有外部瓦片)'
    )

    // 定位到城市中心（鸟瞰视角），同时把自转的起手位置定好。
    camera.flyToOverhead({ duration: 2, resync: false })
  }

  // 优化3D场景性能
  const optimizePerformance = () => {
    // viewer 在 onMounted 里初始化成功后才会调到这里，不会是 null。
    const activeViewer = viewer.value
    if (!activeViewer) return
    // 地面不随太阳变亮：底色恒定（深色大屏要的是「恒定的暗」）
    activeViewer.scene.globe.enableLighting = false

    // 添加雾效果（远处建筑渐隐，减少渲染压力）
    activeViewer.scene.fog.density = 0.0002
    activeViewer.scene.fog.near = 1000 // 雾开始生效的距离
    activeViewer.scene.fog.far = 5000 // 雾完全遮挡的距离

    // 开启抗锯齿
    activeViewer.scene.postProcessStages.fxaa.enabled = true

    // 限制最大帧率（避免过度消耗GPU）
    activeViewer.scene.maximumFrameRate = 60
  }

  const toggleBuildings = () => {
    state.buildingVisible = !state.buildingVisible
    state.buildingEntities.forEach(entity => {
      entity.show = state.buildingVisible
    })
    // 描边是建筑的另一半，隐藏建筑时也要一起藏
    if (primitives.buildingGlow) primitives.buildingGlow.show = state.buildingVisible
  }

  const toggleRoads = () => {
    state.roadVisible = !state.roadVisible
    state.roadEntities.forEach(entity => {
      entity.show = state.roadVisible
    })
    // 流动光效层是 Primitive，不在实体列表里，要单独开关
    if (primitives.flow) primitives.flow.show = state.roadVisible
  }

  /**
   * 把整套主题应用到场景（面板 CSS 由 `useTheme` 负责，这里只管 3D）。
   *
   * ## 硬约束：道路/描边/光效只改值，不换对象
   *
   * 这几类**绝不**去写 `entity.polyline.material` ——
   * 那是 2260 条路，换材质对象会打散 Cesium 的批处理 →
   * 全量几何重建 → 卡死。所有改动都落在**已有材质实例**上：
   *
   * - Primitive 材质：改 `uniforms.color` / `uniforms.glowPower`；
   * - 实体材质：改它内部那个 CallbackProperty 读到的颜色对象。
   *
   * 两种改法都**不 raise 任何事件**，所以 Cesium 不会重建几何。
   *
   * **唯一的例外是建筑本体与广场的面**：它们的颜色是 Cesium 的**逐实例颜色**
   * （PerInstanceColorAppearance → 写进 batch table 的副本），
   * 只改回调里的颜色对象，实体不被标脏就永远不重读 → 颜色不变。
   * 所以这一处要换**一份新的材质属性**（里面还是同一个活颜色回调），
   * 让这批实体重新读一次颜色 —— 一次性重建，不是每帧。
   */
  const applyTheme = (theme: ThemeDefinition): void => {
    currentTheme = theme
    // 模块镜像同步一份：道路分级的颜色 getter 读的是它。
    setActiveTheme(theme)

    // 地面与背景
    const activeViewer = viewer.value
    if (activeViewer) {
      activeViewer.scene.globe.baseColor = cssColor(theme.palette.screen)
      activeViewer.scene.backgroundColor = cssColor(theme.palette.screen)
    }

    // 建筑本体（共用一个材质实例）
    if (primitives.buildingMaterial) {
      setLiveColor(primitives.buildingMaterial, theme.palette.building, 1)
      // **还要让实体重新读一次颜色**：Cesium 的逐实例颜色是**实体更新时烘焙**的
      // （PerInstanceColorAppearance → 写进 batch table 的副本），
      // 只改回调里的颜色对象，实体不被标脏就永远不重读 → 建筑面不变色。
      // 所以这里换**一份新的材质属性**（里面还是同一个活颜色回调）：
      // 实体被标脏 → 视觉器重新读色 → 新颜色生效。
      // 代价：这批实体的 primitive 会重建一次（一次性，不是每帧）。
      const refreshed = new Cesium.ColorMaterialProperty(primitives.buildingMaterial.material!.color)
      state.buildingEntities.forEach(entity => {
        const polygon = entity.polygon as WritablePolygonGraphics | undefined
        if (polygon) polygon.material = refreshed
      })
    }
    // 广场 / 人造地面（共用一个材质实例）
    // 取 `palette.surface` 而不是 `palette.panel`：广场是**场景里的一部分**，
    // 面板是大屏的 UI 底，两者是两回事。
    if (primitives.surfaceMaterial) {
      setLiveColor(primitives.surfaceMaterial, theme.palette.surface, 0.9)
      // 同上：逐实例颜色要重新读一次才生效（广场与建筑走的是同一条路）。
      const refreshed = new Cesium.ColorMaterialProperty(primitives.surfaceMaterial.material!.color)
      state.roadEntities.forEach(entity => {
        const polygon = entity.polygon as WritablePolygonGraphics | undefined
        if (polygon) polygon.material = refreshed
      })
    }
    // 建筑描边（批量 Primitive 的 uniform）
    setMaterialColor(primitives.buildingGlowMaterial, theme.palette.buildingEdge)
    if (primitives.buildingGlowMaterial) {
      primitives.buildingGlowMaterial.uniforms.glowPower = theme.glow.buildingPower
    }
    // 道路（五档各改一次）
    primitives.roadMaterials.forEach((material, key) => {
      setLiveGlow(material, theme.roadColors[key], theme.glow.roadAlpha, theme.glow.roadPower)
    })
    // 流动光效（不透明度跟着主题的 flowAlpha 走）
    setMaterialColor(primitives.flowMaterial, theme.palette.flow, theme.glow.flowAlpha)
    // 地面网格
    setMaterialColor(primitives.gridMaterial, theme.palette.secondary, theme.glow.gridAlpha)
  }

  const destroyViewer = () => {
    if (!viewer.value) return
    viewer.value.destroy()
    viewer.value = null
  }

  const stage: SceneStage = {
    viewer,
    state,
    primitives,
    mounted,
    initCesium,
    optimizePerformance,
    loadGeoJSONBuildings,
    loadGeoJSONRoads,
    createBaseGrid,
    toggleBuildings,
    toggleRoads,
    applyTheme,
    destroyViewer,
  }
  return stage
}
