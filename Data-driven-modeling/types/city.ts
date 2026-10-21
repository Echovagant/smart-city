import type * as Cesium from 'cesium'

/**
 * 城市数据类型系统。
 *
 * 这个文件描述四类东西：
 *
 * 1. **GeoJSON 的最小可用子集**——本项目实际用到的几何类型只有
 *    Point / LineString / Polygon / MultiPolygon（实测数据里建筑是
 *    Polygon 3853 个 + MultiPolygon 1 个，道路是 LineString 1955 个 +
 *    Polygon 305 个）。
 * 2. **OSM 标签属性**——注意 `height` / `building:levels` / `width` 在 OSM 里
 *    是**字符串**，项目在读取边界处把它们解析成数值；这个「原始是字符串」的
 *    事实写进类型，而不是散落在组件里。
 * 3. **后端三个端点的响应契约**——`/api/buildings`、`/api/roads` 返回
 *    FeatureCollection，`/api/traffic-status` 返回 5 个键的交通读数。
 * 4. **前端视图状态**（视角模式、图层显隐、交通开关）：它们目前锁在
 *    SmartCity.vue 的 reactive() 里，这里给它们一个名字，为将来拆分状态留好接口，
 *    但本轮不拆组件。
 *
 * 最后一节补的是 **Cesium 类型声明的缺口**——见「Cesium 运行时可写视图」一节。
 *
 * 约定：新增 API 字段或 OSM 标签时**先改这个文件**，不要在组件里就地定义。
 */

/* -------------------------------------------------------------------------
 * GeoJSON 最小子集
 * ---------------------------------------------------------------------- */

/** 经纬度坐标。GeoJSON 允许带第三个分量表示高度。 */
export type Position = [number, number] | [number, number, number]

export interface PointGeometry {
  type: 'Point'
  coordinates: Position
}

export interface LineStringGeometry {
  type: 'LineString'
  coordinates: Position[]
}

export interface PolygonGeometry {
  type: 'Polygon'
  /** 外环 + 内环，每个环是若干个坐标点。 */
  coordinates: Position[][]
}

export interface MultiPolygonGeometry {
  type: 'MultiPolygon'
  coordinates: Position[][][]
}

/** 本项目用到的全部几何类型。 */
export type Geometry =
  | PointGeometry
  | LineStringGeometry
  | PolygonGeometry
  | MultiPolygonGeometry

/* -------------------------------------------------------------------------
 * OSM 标签属性
 * ---------------------------------------------------------------------- */

/**
 * OSM 标签的原始值。
 *
 * Overpass 返回的标签值一律是字符串（见 backend-python/scripts/fetch_osm_data.py
 * 的 `_feature()`：`{str(key): str(value) ...}`），所以除了 height 这类
 * 「会被解析成数值」的标签之外，其它标签都是 string。
 */
export type OSMTagValue = string | number

export interface OSMProperties {
  /** 建筑类型（yes / house / commercial …）。 */
  building?: string
  /** 道路等级（primary / footway / service …），道路分级全靠它。 */
  highway?: string
  /**
   * 建筑总高（米）。
   *
   * OSM 里是字符串；组件在读取边界处解析成数值，绝不让原始字符串流进
   * Cesium 的 extrudedHeight。
   */
  height?: OSMTagValue
  /**
   * 建筑层数。
   *
   * OSM 里是字符串；组件按「每层 3 米」折算成高度。
   * 不用 `roof:height`：那是屋顶构件相对建筑顶部的高度，不是建筑总高。
   */
  'building:levels'?: OSMTagValue
  /** 道路宽度（米）。OSM 里是字符串。 */
  width?: OSMTagValue
  /** 名称。 */
  name?: string
  /**
   * 其余未列出的 OSM 标签。
   *
   * 实测数据里有上百个标签（building:colour、surface、addr:street …），
   * 值一律是字符串。索引签名让「标签集合」保持开放，
   * 同时保证上面几个具名标签的值类型仍然是精确的。
   */
  [tag: string]: OSMTagValue | undefined
}

/* -------------------------------------------------------------------------
 * GeoJSON 要素
 * ---------------------------------------------------------------------- */

export interface Feature<G extends Geometry = Geometry> {
  type: 'Feature'
  geometry: G
  properties: OSMProperties
  /** OSM 要素标识，形如 "way/123456"。 */
  id?: string | number
}

export interface FeatureCollection<G extends Geometry = Geometry> {
  type: 'FeatureCollection'
  features: Feature<G>[]
  /** OSM 抽取元信息。 */
  generator?: string
  copyright?: string
  timestamp?: string
}

/** 建筑要素：几何是面（Polygon / MultiPolygon）。 */
export type BuildingFeature = Feature<PolygonGeometry | MultiPolygonGeometry>

/** 道路要素：几何是线（LineString）；另有少量广场、人造地面是面。 */
export type RoadFeature = Feature<LineStringGeometry | PolygonGeometry>

/* -------------------------------------------------------------------------
 * API 契约
 * ---------------------------------------------------------------------- */

/** `GET /api/buildings` 的响应。 */
export type BuildingsResponse = FeatureCollection<PolygonGeometry | MultiPolygonGeometry>

/** `GET /api/roads` 的响应。 */
export type RoadsResponse = FeatureCollection<LineStringGeometry | PolygonGeometry>

/**
 * `GET /api/traffic-status` 的响应。
 *
 * 五个字段全部由后端按时间确定性推导（见 backend-python/main.py 的
 * `_traffic_status_payload`）。前端对每个字段都做「缺失就整段略过」的处理，
 * 所以这里全部是可选的——界面上永远不会出现 undefined / NaN。
 */
export interface TrafficStatus {
  /** 拥堵等级代码：normal / slow / congested。 */
  status?: string
  /** 拥堵指数（0..1）。 */
  congestion_level?: number
  /** 拥堵中文标签：畅通 / 轻微拥堵 / 拥堵 / 严重拥堵。 */
  congestion?: string
  /** 流量（0..1）。 */
  flow?: number
  /** ISO8601 时间戳。 */
  update_time?: string
}

/**
 * 请求子区域时的 bbox 参数。
 *
 * 格式是 `min_lon,min_lat,max_lon,max_lat`（后端 `_parse_bbox` 会校验，
 * 不合法一律 400）。缺省不传——后端直接返回完整集合。
 */
export type BBoxParam = string

/* -------------------------------------------------------------------------
 * 解析出来的数值
 * ---------------------------------------------------------------------- */

/**
 * 解析后的建筑高度（米）。
 *
 * `null` 表示「OSM 里没有可用的 height / building:levels」，
 * 由调用方决定兜底高度。
 */
export type HeightMeters = number | null

/* -------------------------------------------------------------------------
 * 前端视图状态
 * ---------------------------------------------------------------------- */

/** 视角模式：鸟瞰 / 平视。 */
export type ViewMode = 'overhead' | 'street'

/** 图层显隐。 */
export interface LayerVisibility {
  /** 建筑图层是否可见。 */
  buildingVisible: boolean
  /** 道路图层是否可见。 */
  roadVisible: boolean
  /** 交通仿真是否可见。 */
  trafficVisible: boolean
}

/**
 * 前端视图状态。
 *
 * 目前整体锁在 SmartCity.vue 的 reactive() 里；这里先给它一个类型名字，
 * 为将来把它（以及 Cesium 实体列表）拆出去留好接口。
 */
export interface CityViewState extends LayerVisibility {
  /** 当前视角。 */
  viewMode: ViewMode
}

/** 经纬度坐标对。 */
export interface LngLat {
  lng: number
  lat: number
}

/**
 * 道路分级。
 *
 * 按 OSM 的 `highway` 标签把道路分成几档，每档有自己的宽度（米）。
 * 颜色是 Cesium 的 Color，属于渲染细节，由组件补上去。
 */
export interface RoadTier {
  /** 档位名称。 */
  name: string
  /** 归入这一档的 highway 标签取值；兜底分级不属于任何一档，没有这一项。 */
  highway?: string[]
  /** 该档的道路宽度（米）。 */
  width: number
}

/* -------------------------------------------------------------------------
 * Cesium 运行时可写视图
 *
 * Cesium 1.134 的 .d.ts 与运行时有两处不一致，这里把缺口补齐——
 * 是**补类型**，不是压制检查。
 * ---------------------------------------------------------------------- */

/**
 * **缺口一：图元属性只声明了「包装后」的一侧。**
 *
 * 构造选项（`PolygonGraphics.ConstructorOptions` 等）允许裸值：
 * `outline?: Property | boolean`、`material?: MaterialProperty | Color`、
 * `extrudedHeight?: Property | number`。但**实例属性**只声明成
 * `Property | undefined`——因为 Cesium 内部用 `createPropertyDescriptor`
 * 包装：写入裸值时会被自动包成 `ConstantProperty`。
 *
 * 也就是说：**运行时接受裸值，类型声明只写了一侧**。
 * 下面的 `Writable*` 类型描述「运行时真正接受的写入类型」。
 *
 * 它们是 Cesium 声明类型的**超类型**（属性只放宽、只多不少），
 * 所以从 Cesium 的类型转过去是一次安全的宽化，不需要绕开任何检查。
 */
export type WritablePolygonGraphics = Omit<
  Cesium.PolygonGraphics,
  'show' | 'height' | 'extrudedHeight' | 'fill' | 'material' | 'outline' | 'outlineColor' | 'outlineWidth'
> & {
  show: Cesium.Property | boolean | undefined
  height: Cesium.Property | number | undefined
  extrudedHeight: Cesium.Property | number | undefined
  fill: Cesium.Property | boolean | undefined
  material: Cesium.MaterialProperty | Cesium.Color | undefined
  outline: Cesium.Property | boolean | undefined
  outlineColor: Cesium.Property | Cesium.Color | undefined
  outlineWidth: Cesium.Property | number | undefined
}

export type WritablePolylineGraphics = Omit<
  Cesium.PolylineGraphics,
  'show' | 'width' | 'material' | 'clampToGround' | 'outline' | 'outlineColor' | 'outlineWidth'
> & {
  show: Cesium.Property | boolean | undefined
  width: Cesium.Property | number | undefined
  material: Cesium.MaterialProperty | Cesium.Color | undefined
  clampToGround: Cesium.Property | boolean | undefined
  outline: Cesium.Property | boolean | undefined
  outlineColor: Cesium.Property | Cesium.Color | undefined
  outlineWidth: Cesium.Property | number | undefined
}

/**
 * Entity 的运行时可写视图。
 *
 * `Entity.position` 在 .d.ts 里只声明成 `PositionProperty | undefined`，
 * 但运行时同样接受裸的 `Cartesian3`（自动包成 ConstantPositionProperty）。
 */
export type WritableEntity = Omit<Cesium.Entity, 'position'> & {
  position: Cesium.PositionProperty | Cesium.Cartesian3 | undefined
}

/**
 * **缺口二：`Scene.maximumFrameRate` 没被声明。**
 *
 * Cesium 运行时用 `Object.defineProperties` 定义了它（用来限制最大帧率），
 * 但 1.134 的 .d.ts 里没有这个属性。这里用模块增补把它补上，
 * 免得在组件里靠断言硬过。
 */
declare module 'cesium' {
  interface Scene {
    /** 限制最大帧率（避免过度消耗 GPU）。 */
    maximumFrameRate: number
  }

  /**
   * **缺口四：`Fog.near` / `Fog.far` 没被声明。**
   *
   * Cesium 1.134 的 Fog 只有浓淡相关的属性（density / heightFalloff …），
   * 没有这两个「生效距离」。项目把它们当作雾的生效距离在写（性能开关的一部分），
   * 所以在类型里补上——免得组件里靠断言硬过。
   */
  interface Fog {
    /** 雾开始生效的距离（米）。 */
    near: number
    /** 雾完全遮挡的距离（米）。 */
    far: number
  }
}

/**
 * **缺口五：`window.CESIUM_BASE_URL` 没被声明。**
 *
 * Cesium 内部用这个全局变量拼接 /Cesium/Workers/* 等静态资源路径，
 * Cesium 自己的 .d.ts 没有声明它。必须在第一次访问 Cesium 静态资源之前设好，
 * 否则会回到 Cesium 默认路径，dev 阶段 Vite 兜底返回 index.html。
 */
declare global {
  interface Window {
    /** Cesium 静态资源根路径。 */
    CESIUM_BASE_URL?: string
  }
}

/**
 * **缺口三：Viewer 的构造选项里没有 errorHandler。**
 *
 * Cesium 运行时支持 `errorHandler`（Viewer 会把它透传给 CesiumWidget），
 * 但 1.134 的 `Viewer.ConstructorOptions` 没声明它。
 * 这里补一个可选字段——它是 Cesium 声明类型的**超类型**，
 * 传进去是一次安全的宽化。
 */
export interface ViewerConstructorOptions extends Cesium.Viewer.ConstructorOptions {
  /** Cesium 运行时错误回调。 */
  errorHandler?: (error: unknown) => void
}
