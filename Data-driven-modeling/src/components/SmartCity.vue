<template>
  <div class="smart-city-container">
    <!-- Cesium容器 -->
    <div ref="cesiumContainer" class="cesium-container"></div>

    <!-- 控制面板 -->
    <div class="control-panel">
      <!-- 数据加载状态 / 后端错误提示：后端挂了必须看得见，不能只剩一个空地球。
           横幅要等「数据到位 **且** 建筑/道路都挂进场景」才消失 ——
           这一刻才是城市真的画出来了（不只是 API 回来了）。 -->
      <div v-if="loading || !sceneAssembled" class="status-hint">正在加载城市数据…</div>
      <div v-if="error" class="status-error">
        数据加载失败：{{ error.message }}<span v-if="error.status">（状态码 {{ error.status }}）</span>
      </div>

      <!-- 城市运行指标带：空气质量 / 天气 / 路网负载。
           每个数字都带来源标注与时间戳；模型估算项标「（模型估算）」；
           取不到的源显示「数据源暂不可用」——绝不显示 0 或上一次的旧值。 -->
      <div v-if="metricSlots.length" class="metric-strip">
        <div v-for="slot in metricSlots" :key="slot.key" class="metric-slot">
          <div class="metric-head">
            <span class="metric-label">{{ slot.label }}</span>
            <span v-if="slot.estimated" class="metric-estimate">（模型估算）</span>
          </div>
          <div class="metric-body">
            <span
              class="metric-value"
              :class="{ 'metric-value-unavailable': slot.unavailable }"
            >{{ slot.display }}</span>
            <span
              v-if="slot.badge"
              class="metric-badge"
              :class="`tone-${slot.tone}`"
            >{{ slot.badge }}</span>
          </div>
          <div v-if="slot.sub" class="metric-sub">{{ slot.sub }}</div>
          <div class="metric-source" :title="slot.sourceTitle">{{ slot.sourceText }}</div>
        </div>
      </div>

      <!-- 实时交通读数：后端按时间推导的交通状态。
           没有数据时不渲染这一行，绝不显示 undefined / NaN。 -->
      <div v-if="trafficReadout" class="traffic-status">
        <span class="traffic-label">实时交通</span>
        <span v-if="trafficReadout.flow" class="traffic-value">{{ trafficReadout.flow }}</span>
        <span
          v-if="trafficReadout.congestion"
          class="traffic-badge"
          :class="`tone-${trafficReadout.tone}`"
        >{{ trafficReadout.congestion }}</span>
        <span v-if="trafficReadout.clock" class="traffic-clock">更新于 {{ trafficReadout.clock }}</span>
      </div>

      <!-- OSM 数据遵循 ODbL：展示这份数据必须署名。删掉这一行等于违反许可证。 -->
      <div class="attribution">数据 © OpenStreetMap contributors</div>

      <button @click="toggleBuildings">
        {{ state.buildingVisible ? '隐藏建筑' : '显示建筑' }}
      </button>
      <button @click="toggleRoads">
        {{ state.roadVisible ? '隐藏道路' : '显示道路' }}
      </button>
      <button @click="toggleTraffic">
        {{ state.trafficVisible ? '停止交通' : '启动交通' }}
      </button>
      <button @click="toggleView">
        {{ state.viewMode === 'overhead' ? '切换平视' : '切换鸟瞰' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, reactive, markRaw, nextTick } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { useCityData } from '@/composables/useCityData'
import {
  DARK_PALETTE,
  GRID_COLOR,
  ROAD_COLORS,
  applyThemeVariables,
  createFlowDashMaterial,
  createGlowMaterial,
  createPrimitiveGlowMaterial,
  cssColor,
  flowDashLength,
  resolveTrafficTone,
} from '@/theme/dark'
import type { TrafficTone } from '@/theme/dark'
import type {
  CityViewState,
  HeightMeters,
  LngLat,
  Metric,
  OSMTagReader,
  Position,
  RoadTier,
  ViewerConstructorOptions,
  WritableEntity,
  WritablePolygonGraphics,
  WritablePolylineGraphics,
} from '../../types/city'

// 移除手动设置的CESIUM_BASE_URL，让Vite自动处理

// 跟踪所有 requestAnimationFrame handle，onUnmounted 时统一取消
const animationFrames = new Set<number>()

/** 车辆在地图上的位置与行驶方向。 */
interface VehiclePosition {
  lng: number
  lat: number
  direction: 'east' | 'west' | 'north' | 'south'
}

/** 一辆车的动画句柄。 */
interface VehicleAnimation {
  vehicle: Cesium.Entity
  pos: VehiclePosition
  /** 重新拉起这条动画链（幂等）。 */
  restart: () => void
}

// 记录每辆车的动画句柄（{ vehicle, pos, restart }）。
// moveVehicle 在交通隐藏时会提前返回、动画链就此断掉，
// 重新显示交通时靠这里的 restart 把链重新拉起来。
const vehicleAnimations: VehicleAnimation[] = []

function safeRequestAnimationFrame(callback: FrameRequestCallback): number {
  const handle = requestAnimationFrame((t) => {
    animationFrames.delete(handle)
    callback(t)
  })
  animationFrames.add(handle)
  return handle
}

function cancelAllAnimations() {
  for (const handle of animationFrames) {
    cancelAnimationFrame(handle)
  }
  animationFrames.clear()
}

// 组件挂载状态标志，async 初始化路径在 await 后检查
let isMounted = true

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
const nextPaint = (): Promise<void> =>
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

// 组件状态
const cesiumContainer = ref<HTMLDivElement | null>(null)
const viewer = ref<Cesium.Viewer | null>(null)

/**
 * 场景是否已装配完成（数据到位 **且** 建筑/道路都挂进场景）。
 *
 * 加载横幅要等它也为 true 才消失：横幅消失的那一刻，城市是真的画出来了。
 * 3854 个建筑实体 + 3854 条批量描边几何的装配是**同步**的（几百毫秒），
 * 这段时间必须被横幅盖住，否则用户会看到「横幅没了但城市还没出来」。
 */
const sceneAssembled = ref(false)

/** 组件的视图状态 + 三组 Cesium 实体列表。 */
interface SmartCityState extends CityViewState {
  buildingEntities: Cesium.Entity[]
  roadEntities: Cesium.Entity[]
  trafficEntities: Cesium.Entity[]
}

const state = reactive<SmartCityState>({
  buildingVisible: true,
  roadVisible: true,
  trafficVisible: true,
  viewMode: 'overhead', // 'overhead' 鸟瞰 | 'street' 平视
  buildingEntities: [],
  roadEntities: [],
  trafficEntities: []
})

/** 道路分级 + 渲染参数（颜色是色板里的 CSS 值，材质在装载时按分级现造）。 */
interface RenderedRoadTier extends RoadTier {
  /** 该档的线色。 */
  color: string
  /** 是否叠一层流动光效（只给 1~2 级道路，全加会糊）。 */
  flowing: boolean
}

/** 城市配置参数。 */
interface CityConfig {
  center: LngLat
  zoomLevel: number
  streetLevel: { height: number; heading: number }
  defaultBuildingHeight: number
  roadTiers: RenderedRoadTier[]
  roadFallbackTier: RenderedRoadTier
}

const cityConfig: CityConfig = {
  // 天安门广场中央：开阔地带，平视模式不会穿模；朝北（heading=0）能看到天安门城楼
  center: { lng: 116.3976, lat: 39.9055 },
  zoomLevel: 1500,
  // 平视视角：1.7m 是人眼高度，朝向正北（heading=0）
  streetLevel: { height: 1.7, heading: 0 },
  // 建筑没有任何高度标签时的兜底高度（米）
  defaultBuildingHeight: 30,
  // 道路分级表：按 OSM 的 highway 标签分级渲染。
  //
  // 读的是 highway，不是 type：实测提取数据里 2260 条道路全部带 highway，
  // 而 type 一个都没有（建筑上的 type 是 'multipolygon' 几何标签，与道路等级无关）。
  //
  // 实测标签分布（backend-python/geojson/roads.geojson，2026-10-20）：
  //   footway 1117、pedestrian 314、service 263、steps 235、residential 118、
  //   tertiary 47、primary 40、unclassified 27、path 26、secondary 21、……
  // 分级就是照这个分布定的：人行道/步行区占了一半，所以给它们最细最浅的线。
  //
  // 宽度沿用原来的 14/10/7/4（Cesium 里是像素），颜色全部换成深色科技色：
  // 主干道最亮，人行道最暗 —— 越细的路越暗，层级一眼可辨。
  roadTiers: [
    {
      name: '主干道',
      highway: ['motorway', 'trunk', 'primary'],
      color: ROAD_COLORS.main,
      flowing: true,
      width: 14
    },
    {
      name: '次干道',
      highway: ['secondary', 'tertiary'],
      color: ROAD_COLORS.secondary,
      flowing: true,
      width: 10
    },
    {
      name: '支路',
      highway: ['residential', 'unclassified', 'service'],
      color: ROAD_COLORS.local,
      flowing: true,
      width: 7
    },
    {
      name: '人行道/步行区',
      highway: ['footway', 'pedestrian', 'steps', 'path', 'cycleway'],
      color: ROAD_COLORS.footway,
      flowing: true,
      width: 4
    }
  ],
  // 兜底分级：highway 标签缺失、或取值不在上表里时用它。
  // OSM 的 highway 取值比上表多（motorway_link / living_street / track 等都在表外），
  // 没有兜底的话这些道路会没有样式。
  // 宽度取最低等级（4m，与人行道同级），避免把未知道路画得比主干道还宽。
  roadFallbackTier: {
    name: '其他道路',
    color: ROAD_COLORS.fallback,
    flowing: false,
    width: 4
  }
}

// highway 标签 → 分级 的查表，建一次就够（2260 条道路各查一次）。
const ROAD_TIER_BY_HIGHWAY = cityConfig.roadTiers.reduce((map, tier) => {
  tier.highway?.forEach(tag => map.set(tag, tier))
  return map
}, new Map<string, RenderedRoadTier>())

// 按 highway 标签查道路分级：标签缺失或不在表内 → 兜底分级。
function resolveRoadTier(highwayTag: unknown): RenderedRoadTier {
  if (typeof highwayTag !== 'string') return cityConfig.roadFallbackTier
  const tier = ROAD_TIER_BY_HIGHWAY.get(highwayTag.trim().toLowerCase())
  return tier || cityConfig.roadFallbackTier
}

// 读一个 OSM 标签值：Cesium 的 properties 是 PropertyBag，取值必须经过 getValue()。
// 标签缺失时返回 undefined。
//
// Cesium 给 PropertyBag 的索引签名是宽松类型，这里显式收窄成 Property；
// 返回值统一是 unknown —— OSM 里的标签值是字符串，调用方自己判断。
function readTag(properties: Cesium.PropertyBag | undefined, key: string): unknown {
  const prop = properties?.[key] as Cesium.Property | undefined
  if (!prop || typeof prop.getValue !== 'function') return undefined
  return prop.getValue()
}

// 读原始 GeoJSON 里的 OSM 标签（不走 PropertyBag）。
// 原始值一律是字符串；这里只负责「有没有」，数值转换在调用方做。
function readRawTag(properties: Record<string, unknown> | undefined, key: string): unknown {
  if (!properties) return undefined
  const value = properties[key]
  return value === undefined || value === null ? undefined : value
}

// 把一个 OSM 高度类标签转成正数米数；无效或缺失时返回 null。
function parseHeightMeters(raw: unknown): HeightMeters {
  if (typeof raw === 'boolean') return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return null
  return value
}

// 建筑高度：height（总高，米）→ building:levels × 3（层数估算）→ 兜底高度。
// OSM 标签一律是字符串，必须在读取边界处显式转成数字，
// 绝不让原始字符串流进 extrudedHeight（Cesium 的槽位是 Property | number）。
// 不用 roof:height：OSM 里它是屋顶构件相对建筑顶部的高度，不是建筑总高，
// 单独使用会把 15 米的建筑算成 1~3 米。
//
// 标签读取做成参数（而不是写死 PropertyBag），是为了让「实体」与「原始 GeoJSON」
// 两条路共用**同一份**高度口径 —— 批量描边的高度必须与建筑本体完全一致。
function resolveBuildingHeight(read: OSMTagReader, fallback: number): number {
  const direct = parseHeightMeters(read('height'))
  if (direct !== null) return direct
  const levels = parseHeightMeters(read('building:levels'))
  if (levels !== null) return levels * 3
  return fallback
}

// 道路宽度：优先用 OSM 的 width 标签（单位：米），但只在它是正数、
// 且不超过该分级的默认宽度时才采用——数据里存在 '30' 这种异常值，
// 直接采用会把人行道画成 30 米宽。非法或超纲一律用分级默认宽度。
function resolveRoadWidth(tier: RenderedRoadTier, taggedWidth: unknown): number {
  const width = Number(taggedWidth)
  return Number.isFinite(width) && width > 0 && width <= tier.width ? width : tier.width
}

// 城市数据来源（通过 useCityData composable 从后端 /api/* 拉取 GeoJSON）
// error / loading 必须一起取出来，否则后端挂了界面上一片空白、毫无提示
// trafficStatus 同样要取：它此前请求了却被丢弃，界面上看不到任何实时读数
// cityOverview 是城市运行指标（空气质量 / 天气 / 路网负载），
// 每个数字都带来源标注与时间戳。
const {
  buildings,
  roads,
  trafficStatus,
  refreshTrafficStatus,
  loadAll,
  cityOverview,
  loadCityOverview,
  refreshCityOverview,
  error,
  loading,
} = useCityData()

// 把任意取值转成有限数字；null / undefined / 空串 / 非数字一律返回 null。
function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

// 0..1 的指数 → 百分比文本；拿不到就返回 null（整段略过）。
function formatRatio(value: unknown): string | null {
  const num = toFiniteNumber(value)
  if (num === null) return null
  return `${Math.round(num * 100)}%`
}

// 拥堵描述：优先用后端给的中文标签；没有标签时按拥堵指数自己分档。
function formatCongestion(label: unknown, level: unknown): string | null {
  if (typeof label === 'string' && label.trim()) return label.trim()
  const num = toFiniteNumber(level)
  if (num === null) return null
  if (num < 0.25) return '畅通'
  if (num < 0.5) return '轻微拥堵'
  if (num < 0.75) return '拥堵'
  return '严重拥堵'
}

// ISO8601 时间戳 → 本地 HH:MM:SS；解析不了就返回 null（整段略过）。
// 自己拼时间串而不用 toLocaleTimeString：后者受运行环境的 ICU 数据影响，
// 输出格式不保证一致。
function formatClock(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`
}

// 实时交通读数：拆成「标签 / 大号数字 / 拥堵徽标 / 时间」四块，
// 交给样式表去排版。任何一项字段缺失都整段略过，
// 绝不让 undefined / NaN 出现在界面上。
interface TrafficReadout {
  flow: string | null
  congestion: string | null
  tone: TrafficTone
  clock: string | null
}

const trafficReadout = computed<TrafficReadout | null>(() => {
  const status = trafficStatus.value
  if (!status || typeof status !== 'object') return null

  const congestion = formatCongestion(status.congestion, status.congestion_level)
  const level = toFiniteNumber(status.congestion_level)
  return {
    flow: formatRatio(status.flow),
    congestion,
    tone: resolveTrafficTone(level, congestion),
    clock: formatClock(status.update_time)
  }
})

// 交通状态轮询间隔（毫秒）。计划书里的实时性主张是「5 秒级更新」；
// 这个端点不带 API key，前端可以直接轮询。
const TRAFFIC_POLL_INTERVAL_MS = 5000

let trafficTimer: ReturnType<typeof setInterval> | null = null

// 挂上轮询：交通读数每 5 秒刷新一次。
// 与 3D 渲染无关，Cesium 初始化失败时读数照样在动。
const startTrafficPolling = () => {
  stopTrafficPolling()
  // refreshTrafficStatus 内部已经吞掉了所有失败，不会产生未处理的 rejection。
  trafficTimer = setInterval(() => {
    refreshTrafficStatus()
  }, TRAFFIC_POLL_INTERVAL_MS)
}

// 停掉轮询：组件卸载后不再发请求，也不再往已卸载的组件里写数据。
const stopTrafficPolling = () => {
  if (trafficTimer === null) return
  clearInterval(trafficTimer)
  trafficTimer = null
}

/* ---------------------------------------------------------------------------
 * 城市运行指标带
 * ------------------------------------------------------------------------- */

/**
 * 指标带上的一个格子。
 *
 * 三条硬要求：
 * - 取不到的源显示「数据源暂不可用」，**不显示 0 或上一次的旧值**；
 * - 模型估算的指标标「（模型估算）」；
 * - 每个格子都带来源标注（来源名 + 观测时间），悬停有完整信息。
 */
interface MetricSlot {
  key: string
  label: string
  /** 显示出来的值；取不到时是「数据源暂不可用」。 */
  display: string
  /** 分级徽标（空气质量的「良」）。 */
  badge: string | null
  tone: TrafficTone
  /** 这个指标是不是模型估算。 */
  estimated: boolean
  /** 这个源是不是没取到。 */
  unavailable: boolean
  /** 副标题（例如「路网总长 202.173 km」）。 */
  sub: string | null
  /** 来源小字。 */
  sourceText: string
  /** 悬停提示（完整来源信息）。 */
  sourceTitle: string
}

/** 指标带上的格子定义。顺序即显示顺序。 */
interface MetricSlotDef {
  key: string
  label: string
  /** 值后面是否直接跟单位（AQI 与指数不跟，其余跟）。 */
  showUnit?: boolean
  /** 副标题对应的指标 key。 */
  subKey?: string
  /** 副标题前缀。 */
  subLabel?: string
}

const METRIC_SLOT_DEFS: MetricSlotDef[] = [
  { key: 'aqi', label: '空气质量' },
  { key: 'weather_temp', label: '气温', showUnit: true },
  {
    key: 'road_load_index',
    label: '路网负载',
    subKey: 'road_length_km',
    subLabel: '路网总长',
  },
]

// 空气质量分级 → 色调：优/良是常态，污染开始是预警，严重是告警。
function resolveAirTone(level: number | null | undefined): TrafficTone {
  if (level === null || level === undefined) return 'ok'
  if (level <= 2) return 'ok'
  if (level === 3) return 'warn'
  return 'alert'
}

// 指标值 → 文本。拿不到就返回 null（整段略过，不显示 undefined / NaN）。
function formatMetricValue(metric: Metric | undefined): string | null {
  if (!metric) return null
  const value = metric.value
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    // 最多两位小数：63.5 → "63.5"，51 → "51"
    return String(Math.round(value * 100) / 100)
  }
  return String(value)
}

// 指标带的格子。数据没到（cityOverview 为 null）时返回空数组 —— 什么都不显示，
// 胜过显示一个假的 0。
const metricSlots = computed<MetricSlot[]>(() => {
  const overview = cityOverview.value
  if (!overview || !Array.isArray(overview.metrics)) return []
  const byKey = new Map<string, Metric>()
  overview.metrics.forEach(metric => {
    if (metric && typeof metric.key === 'string') byKey.set(metric.key, metric)
  })

  return METRIC_SLOT_DEFS.map(def => {
    const metric = byKey.get(def.key)
    const source = metric?.source
    const unavailable = !metric || metric.value === null || metric.value === undefined
    const estimated = source?.estimated === true
    const rawValue = formatMetricValue(metric)
    const display = unavailable
      ? '数据源暂不可用'
      : `${rawValue ?? ''}${def.showUnit && metric?.unit ? metric.unit : ''}`
    const observedClock = formatClock(source?.observed_at)
    const sourceText = source
      ? `${source.name} · ${observedClock ?? '观测时间未知'}${
          !unavailable && source.realtime === false ? '（非实时）' : ''
        }`
      : '数据源暂不可用'
    const sourceTitle = source
      ? [
          source.name,
          source.url,
          `观测时间：${source.observed_at ?? '未知'}`,
          `取数时间：${source.fetched_at}`,
          estimated ? '注意：这是模型估算，不是实测' : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '数据源暂不可用'

    let sub: string | null = null
    if (def.subKey) {
      const subMetric = byKey.get(def.subKey)
      const subValue = formatMetricValue(subMetric)
      if (subValue && def.subLabel) {
        const unit = subMetric?.unit && subMetric.unit !== '指数' ? ` ${subMetric.unit}` : ''
        sub = `${def.subLabel} ${subValue}${unit}`
      }
    }

    return {
      key: def.key,
      label: def.label,
      display,
      // 取不到时**不显示**分级徽标：没取到数据就不知道分级，
      // 留着上一档的「良」是拿旧值冒充。
      badge: unavailable ? null : (metric?.level_label ?? null),
      tone: resolveAirTone(metric?.level),
      estimated,
      unavailable,
      sub,
      sourceText,
      sourceTitle,
    }
  })
})

// 城市指标的轮询间隔（毫秒）。
// 空气质量是小时级数据，天气源本身也不实时 —— 60 秒足够；
// 再快只是反复打同一个上游。
const CITY_OVERVIEW_POLL_INTERVAL_MS = 60000

let cityOverviewTimer: ReturnType<typeof setInterval> | null = null

// 挂上轮询：城市指标每 60 秒刷新一次。
const startCityOverviewPolling = () => {
  stopCityOverviewPolling()
  cityOverviewTimer = setInterval(() => {
    refreshCityOverview()
  }, CITY_OVERVIEW_POLL_INTERVAL_MS)
}

// 停掉轮询：组件卸载后不再发请求。
const stopCityOverviewPolling = () => {
  if (cityOverviewTimer === null) return
  clearInterval(cityOverviewTimer)
  cityOverviewTimer = null
}

/* ---------------------------------------------------------------------------
 * 深色底座
 * ------------------------------------------------------------------------- */

/** 数字底座的网格间距（米）。 */
const GRID_SPACING_M = 200

/** 网格线离地面的高度（米）：抬一点点，避免与地面 z-fighting。 */
const GRID_ALTITUDE_M = 1.5

/** 网格线的透明度：只要一点点存在感。 */
const GRID_ALPHA = 0.15

/** 网格线的辉光强度。 */
const GRID_GLOW_POWER = 0.3

/** 每纬度一度约合多少米（把米换算成经纬度偏移时用）。 */
const METERS_PER_DEGREE_LAT = 111320

/** 数据的经纬度范围。 */
interface MapExtent {
  west: number
  south: number
  east: number
  north: number
}

/** 算出所有要素的经纬度范围；算不出来就返回 null（不画网格）。 */
function computeExtent(collections: Array<{ features: Array<{ geometry: { type: string; coordinates: unknown } }> }>): MapExtent | null {
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
  const primitive = new Cesium.Primitive({
    geometryInstances: instances,
    appearance: new Cesium.PolylineMaterialAppearance({
      material: createPrimitiveGlowMaterial(GRID_COLOR, GRID_GLOW_POWER, GRID_ALPHA)
    }),
    asynchronous: false
  })
  activeViewer.scene.primitives.add(primitive)
}

/* ---------------------------------------------------------------------------
 * 相机：缓慢自转 + 交互打断
 * ------------------------------------------------------------------------- */

/** 鸟瞰相机相对城心的俯角（弧度）。正数 = 从上往下看。 */
const OVERHEAD_TILT_RAD = Math.PI / 4

/** 鸟瞰相机相对城心的水平距离（米）= 高度 / tan(俯角)。 */
const OVERHEAD_DISTANCE_M = cityConfig.zoomLevel / Math.tan(OVERHEAD_TILT_RAD)

/** 自转速度（弧度/秒）。0.02 rad/s ≈ 1.1°/s，一圈约 5 分钟。 */
const ORBIT_SPEED_RAD_PER_S = 0.02

/** 距上次交互超过这个时长才恢复自转（毫秒）。 */
const ORBIT_RESUME_DELAY_MS = 4000

/** 恢复自转后，距离/高度回到目标值的时间常数（秒）。 */
const ORBIT_RESUME_TAU_S = 0.8

/** 相机飞行期间不推进自转（飞行与自转会打架）。 */
const CAMERA_FLIGHT_GUARD_MS = 2600

/** 自转状态：相机相对城心的位置。 */
interface CameraOrbit {
  /** 相机在城心 ENU 平面上的方位角（自北顺时针，弧度）。 */
  azimuth: number
  /** 相机相对城心的水平距离（米）。 */
  distance: number
  /** 相机相对城心的高度（米）。 */
  altitude: number
  /** 恢复自转时是否需要重新读取相机位置（用户动过相机）。 */
  needsResync: boolean
}

const cameraOrbit: CameraOrbit = {
  azimuth: 0,
  distance: OVERHEAD_DISTANCE_M,
  altitude: cityConfig.zoomLevel,
  needsResync: false
}

/** 最后一次相机交互的时间戳（performance.now() 口径）。 */
let lastInteractionAt = 0

/** 相机飞行结束前的时间戳：这段时间里不推进自转。 */
let cameraFlightUntil = 0

/** 上一帧推进自转的时间戳。 */
let lastOrbitFrameAt = 0

/** 交互监听器：记录「最后一次交互时间」。 */
let interactionHandler: Cesium.ScreenSpaceEventHandler | null = null

/** 建筑描边的批量 Primitive（一个绘制调用管全部 3854 栋楼）。 */
let buildingGlowPrimitive: Cesium.Primitive | null = null

/** 城心在城心 ENU 平面上的经纬度换算系数。 */
const centerLatRad = (cityConfig.center.lat * Math.PI) / 180

/** 把「城心 ENU 平面上的方位角 + 距离」换算成经纬度偏移。 */
const offsetToLngLat = (azimuth: number, distance: number): { lng: number; lat: number } => ({
  lng: cityConfig.center.lng + (distance * Math.sin(azimuth)) / (METERS_PER_DEGREE_LAT * Math.cos(centerLatRad)),
  lat: cityConfig.center.lat + (distance * Math.cos(azimuth)) / METERS_PER_DEGREE_LAT
})

/** 自转落点：相机位置与朝向（始终看向城心）。 */
const overheadView = (): { destination: Cesium.Cartesian3; heading: number; pitch: number } => {
  const { lng, lat } = offsetToLngLat(cameraOrbit.azimuth, cameraOrbit.distance)
  return {
    destination: Cesium.Cartesian3.fromDegrees(lng, lat, cameraOrbit.altitude),
    // 相机在城心的方位角 + 180° = 它看向城心的罗盘方位
    heading: cameraOrbit.azimuth + Math.PI,
    pitch: -OVERHEAD_TILT_RAD
  }
}

/** 把鸟瞰视角落到相机上。 */
const applyOverheadView = (activeViewer: Cesium.Viewer) => {
  const view = overheadView()
  activeViewer.camera.setView({
    destination: view.destination,
    orientation: { heading: view.heading, pitch: view.pitch, roll: 0 }
  })
}

/**
 * 重新从相机当前位置读取自转状态。
 *
 * 用户操作过相机之后，相机已经不在轨道上了；恢复自转时先按它当前的位置
 * 重新起算，这样恢复的那一刻**不会跳**。
 */
const readOrbitFromCamera = (activeViewer: Cesium.Viewer) => {
  const cartographic = activeViewer.camera.positionCartographic
  if (!cartographic) return
  const dLng =
    ((cartographic.longitude * 180) / Math.PI - cityConfig.center.lng) *
    METERS_PER_DEGREE_LAT *
    Math.cos(centerLatRad)
  const dLat = ((cartographic.latitude * 180) / Math.PI - cityConfig.center.lat) * METERS_PER_DEGREE_LAT
  cameraOrbit.distance = Math.hypot(dLng, dLat)
  cameraOrbit.azimuth = Math.atan2(dLng, dLat)
  cameraOrbit.altitude = cartographic.height
}

/**
 * 每帧推进自转。
 *
 * 三条规则：
 * 1. **平视不转**（1.7 m 高度自转会让人晕）。
 * 2. **用户刚操作过就不转**（距上次交互 > 4 秒才恢复）。
 * 3. 相机在飞行途中也不转（飞行与自转会互相打架）。
 */
const onScenePreRender = () => {
  const activeViewer = viewer.value
  if (!activeViewer) return
  if (state.viewMode !== 'overhead') return

  const now = performance.now()
  if (now < cameraFlightUntil) return
  if (now - lastInteractionAt < ORBIT_RESUME_DELAY_MS) return

  const deltaSeconds = lastOrbitFrameAt === 0 ? 0 : Math.min(0.1, (now - lastOrbitFrameAt) / 1000)
  lastOrbitFrameAt = now

  if (cameraOrbit.needsResync) {
    readOrbitFromCamera(activeViewer)
    cameraOrbit.needsResync = false
  }

  cameraOrbit.azimuth += ORBIT_SPEED_RAD_PER_S * deltaSeconds

  // 流动光效推进：改材质的 dashLength 即可（渲染器每帧从 material.uniforms 读值）。
  if (flowMaterial) {
    flowMaterial.uniforms.dashLength = flowDashLength(FLOW_DASH_LENGTH, FLOW_PERIOD_SECONDS)
  }

  // 恢复自转时把距离/高度平滑收敛回目标值：用户拉近拉远的视角会被拉回大屏构图。
  const blend = 1 - Math.exp(-deltaSeconds / ORBIT_RESUME_TAU_S)
  cameraOrbit.distance += (OVERHEAD_DISTANCE_M - cameraOrbit.distance) * blend
  cameraOrbit.altitude += (cityConfig.zoomLevel - cameraOrbit.altitude) * blend

  applyOverheadView(activeViewer)
}

/** 任何相机输入都记一笔「最后一次交互时间」。 */
const markCameraInteraction = () => {
  lastInteractionAt = performance.now()
  cameraOrbit.needsResync = true
}

/** 装上交互监听：鼠标一操作就停自转。 */
const installCameraInteractionWatcher = (activeViewer: Cesium.Viewer) => {
  const handler = new Cesium.ScreenSpaceEventHandler(activeViewer.canvas)
  const eventTypes = [
    Cesium.ScreenSpaceEventType.LEFT_DOWN,
    Cesium.ScreenSpaceEventType.RIGHT_DOWN,
    Cesium.ScreenSpaceEventType.MIDDLE_DOWN,
    Cesium.ScreenSpaceEventType.MOUSE_MOVE,
    Cesium.ScreenSpaceEventType.WHEEL,
    Cesium.ScreenSpaceEventType.PINCH_START
  ]
  eventTypes.forEach((type) => handler.setInputAction(markCameraInteraction, type))
  interactionHandler = handler
}

/* ---------------------------------------------------------------------------
 * 场景装配
 * ------------------------------------------------------------------------- */

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
  scene.globe.baseColor = cssColor(DARK_PALETTE.screen)
  scene.globe.enableLighting = false
  scene.globe.showGroundAtmosphere = false
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false
  scene.backgroundColor = cssColor(DARK_PALETTE.screen)
}

// 初始化Cesium
const initCesium = async () => {
  if (!cesiumContainer.value) return

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
  // 将来若有人把高德瓦片加回来，偏移会**立刻回来**，详见 CLAUDE.md。
  //
  // errorHandler 不在 Cesium 1.134 的 Viewer.ConstructorOptions 里（运行时支持），
  // 所以用补过的 ViewerConstructorOptions——见 types/city.ts。
  //
  // 选项对象必须**内联**在 Viewer 的构造调用里：测试有一条源码文本断言，
  // 专门从这个调用的参数块里抠出选项、确认底图相关的三个开关都是 false
  // （见 src/components/__tests__/SmartCity.lifecycle.test.ts）。
  viewer.value = new Cesium.Viewer(cesiumContainer.value, {
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
  installCameraInteractionWatcher(viewer.value)
  viewer.value.scene.preRender.addEventListener(onScenePreRender)

  // 底座自绘：影像图层数是 0（既没有高德瓦片，也没有 ion 底图）。
  // 这行日志是回归脚本的探针 —— 它按 "Viewer created" 判定 Viewer 起来了。
  console.log(
    '[SmartCity] Viewer created. imagery layers:',
    viewer.value.imageryLayers.length,
    '(0 = 底座自绘，没有外部瓦片)'
  )

  // 定位到城市中心（鸟瞰视角），同时把自转的起手位置定好。
  const view = overheadView()
  cameraFlightUntil = performance.now() + CAMERA_FLIGHT_GUARD_MS
  viewer.value.camera.flyTo({
    destination: view.destination,
    orientation: { heading: view.heading, pitch: view.pitch, roll: 0 },
    duration: 2,
  })
}

// 飞到平视视角：贴近地面（1.7m），pitch=0 水平看出去
const flyToStreetLevel = () => {
  if (!viewer.value) return
  cameraFlightUntil = performance.now() + CAMERA_FLIGHT_GUARD_MS
  viewer.value.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      cityConfig.center.lng,
      cityConfig.center.lat,
      cityConfig.streetLevel.height
    ),
    orientation: {
      heading: cityConfig.streetLevel.heading,
      pitch: 0, // 水平
      roll: 0,
    },
    duration: 2,
  })
}

// 飞到鸟瞰视角：城心上空 1500m，俯角 45°，并恢复自转
const flyToOverhead = () => {
  if (!viewer.value) return
  cameraFlightUntil = performance.now() + CAMERA_FLIGHT_GUARD_MS
  // 恢复自转时从相机当前位置重新起算，不硬拽回轨道。
  cameraOrbit.needsResync = true
  const view = overheadView()
  viewer.value.camera.flyTo({
    destination: view.destination,
    orientation: { heading: view.heading, pitch: view.pitch, roll: 0 },
    duration: 2,
  })
}

// 优化3D场景性能
const optimizePerformance = () => {
  // viewer 在 onMounted 里初始化成功后才会调到这里，不会是 null。
  const activeViewer = viewer.value!
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

/* ---------------------------------------------------------------------------
 * 建筑：深色本体 + 批量发光描边
 * ------------------------------------------------------------------------- */

/** 建筑描边的辉光强度。 */
const BUILDING_GLOW_POWER = 0.25

/** 建筑描边的线宽（像素）。 */
const BUILDING_GLOW_WIDTH = 2

/** 描边相对顶面的抬高（米）：避免与顶面 z-fighting。 */
const BUILDING_OUTLINE_LIFT_M = 0.5

/**
 * 批量生成建筑描边。
 *
 * **必须批量**：3854 栋楼各建一个描边实体，实体数会翻倍到 ~7700，帧率会掉。
 * 这里把所有楼的闭合轮廓合成**一个** Primitive（一次绘制调用）。
 *
 * 描边画在**顶面高度**处：俯视看到的是屋顶轮廓，斜视看到的是发光的屋顶边线。
 */
const createBuildingGlow = (features: Array<{ geometry: { type: string; coordinates: unknown }; properties?: Record<string, unknown> }>) => {
  const activeViewer = viewer.value
  if (!activeViewer) return

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
  if (instances.length === 0) return

  // asynchronous: false —— 同步建几何，不去动剪过枝的 worker（见 createBaseGrid 的说明）。
  const primitive = new Cesium.Primitive({
    geometryInstances: instances,
    appearance: new Cesium.PolylineMaterialAppearance({
      material: createPrimitiveGlowMaterial(DARK_PALETTE.accent, BUILDING_GLOW_POWER)
    }),
    asynchronous: false
  })
  activeViewer.scene.primitives.add(primitive)
  buildingGlowPrimitive = primitive
}

// 加载真实GeoJSON建筑数据（替换随机生成的建筑）
const loadGeoJSONBuildings = async () => {
  if (!buildings.value) return
  try {
    // 使用 useCityData 已加载到内存的 GeoJSON 对象，避免再次发起 HTTP 请求。
    const dataSource = await Cesium.GeoJsonDataSource.load(buildings.value, {
      clampToGround: false,
    })
    if (!isMounted) return

    const entities = dataSource.entities.values
    entities.forEach(entity => {
      if (!isMounted) return
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
      polygon.material = cssColor(DARK_PALETTE.building)
      // 不画 1px 描边：描边由下面的批量 Primitive 负责（带辉光）。
      // 留着 outline 会让每栋楼多一次绘制调用（3854 → 7708 次）。
      polygon.outline = false

      // 存入状态管理，用于控制显示/隐藏。
      // markRaw：Cesium Entity 是引擎对象，不是视图状态，
      // 别让 Vue 给它套一层响应式代理（几千个实体的代理开销与被代理对象内部行为都有风险）。
      state.buildingEntities.push(markRaw(entity))
    })

    if (isMounted) {
      // isMounted 为真时 viewer 一定还在（onUnmounted 会把两者一起置空）。
      viewer.value!.dataSources.add(dataSource)
      // 建筑描边：一次批量 Primitive 管全部建筑。
      createBuildingGlow(buildings.value.features)
    }
  } catch (error) {
    console.error('加载建筑 GeoJSON 失败:', error)
  }
}

/* ---------------------------------------------------------------------------
 * 道路：深色分级 + 辉光 + 流动光效
 * ------------------------------------------------------------------------- */

/**
 * 道路辉光强度。
 *
 * 别调大：辉光材质的饱和白芯宽度正比于 glowPower，
 * 0.3 会把 14px 的主干道烧成一条白带，四级分级的配色就全看不见了。
 * 0.12 留一条细白芯，其余宽度显示各自的线色。
 */
const ROAD_GLOW_POWER = 0.12

/** 道路线的不透明度：留一点点通透，别像油漆。 */
const ROAD_ALPHA = 0.95

/** 流动光效的虚线基准长度（米）。 */
const FLOW_DASH_LENGTH = 24

/** 流动光效一个完整来回的时长（秒）。 */
const FLOW_PERIOD_SECONDS = 6

/** 流动光效图层：一个 Primitive 管全部 1~2 级道路。 */
let flowPrimitive: Cesium.Primitive | null = null

/** 流动光效的材质：每帧改 `uniforms.dashLength` 推进相位。 */
let flowMaterial: Cesium.Material | null = null

/** 加载真实GeoJSON道路数据 */
const loadGeoJSONRoads = async () => {
  if (!roads.value) return
  try {
    // 使用 useCityData 已加载到内存的 GeoJSON 对象，避免再次发起 HTTP 请求。
    const dataSource = await Cesium.GeoJsonDataSource.load(roads.value, {
      clampToGround: true,
    })
    if (!isMounted) return

    const entities = dataSource.entities.values
    entities.forEach(entity => {
      if (!isMounted) return
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
          surface.material = cssColor(DARK_PALETTE.panel, 0.9)
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
      polyline.material = createGlowMaterial(tier.color, ROAD_GLOW_POWER, ROAD_ALPHA)
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
            width: Math.max(3, width),
            vertexFormat: Cesium.PolylineMaterialAppearance.VERTEX_FORMAT,
            arcType: Cesium.ArcType.GEODESIC
          })
        })
      )
    }
    if (flowInstances.length > 0) {
      flowMaterial = createFlowDashMaterial(DARK_PALETTE.flow, FLOW_DASH_LENGTH)
      flowPrimitive = new Cesium.Primitive({
        geometryInstances: flowInstances,
        appearance: new Cesium.PolylineMaterialAppearance({ material: flowMaterial }),
        asynchronous: false
      })
      viewer.value!.scene.primitives.add(flowPrimitive)
    }

    if (isMounted) {
      viewer.value!.dataSources.add(dataSource)
    }
  } catch (error) {
    console.error('加载道路 GeoJSON 失败:', error)
  }
}

/* ---------------------------------------------------------------------------
 * 交通：小车改成发光体
 * ------------------------------------------------------------------------- */

// 创建交通系统
const createTrafficSystem = () => {
  // 组件可能已经卸载（onUnmounted 里 viewer.value 被置空），
  // 此时直接返回，避免 "Cannot read properties of null (reading 'entities')"。
  if (!viewer.value) return

  // 取一次局部引用：viewer.value 是 ref 的属性，在闭包里会被类型系统当成
  // 可能为 null；createTrafficSystem 是同步的，中途不会被换掉。
  const activeViewer = viewer.value

  const centerLng = cityConfig.center.lng
  const centerLat = cityConfig.center.lat

  // 创建交通灯
  const createTrafficLight = (position: LngLat) => {
    const trafficLight = activeViewer.entities.add({
      name: 'Traffic Light',
      position: Cesium.Cartesian3.fromDegrees(position.lng, position.lat, 0),
      cylinder: {
        length: 5,
        topRadius: 0.1,
        bottomRadius: 0.1,
        // 灯杆用暗蓝：深色底上要看得见，又不能抢主体
        material: cssColor(DARK_PALETTE.secondary, 0.55),
      },
      point: {
        pixelSize: 12,
        // 顶部发光点：预警色（琥珀）
        color: cssColor(DARK_PALETTE.warning),
        outlineColor: cssColor(DARK_PALETTE.warning),
        outlineWidth: 2,
      },
    })

    state.trafficEntities.push(markRaw(trafficLight))
  }

  // 创建车辆
  const createVehicles = () => {
    const vehiclePositions: VehiclePosition[] = [
      { lng: centerLng - 0.01, lat: centerLat, direction: 'east' },
      { lng: centerLng + 0.01, lat: centerLat, direction: 'west' },
      { lng: centerLng, lat: centerLat - 0.01, direction: 'north' },
      { lng: centerLng, lat: centerLat + 0.01, direction: 'south' }
    ]

    vehiclePositions.forEach((pos, index) => {
      const vehicle = activeViewer.entities.add({
        name: `Vehicle ${index + 1}`,
        position: Cesium.Cartesian3.fromDegrees(pos.lng, pos.lat, 0.5),
        box: {
          dimensions: new Cesium.Cartesian3(2.0, 1.0, 0.6),
          // 车身：数据流色（青），在深色底上是发光的
          material: cssColor(DARK_PALETTE.flow, 0.95),
        },
        description: `<h3>车辆 ${index + 1}</h3><p>方向: ${pos.direction}</p>`,
      })

      state.trafficEntities.push(markRaw(vehicle))

      // 车辆动画。记录返回的 restart 回调，
      // 供 toggleTraffic 在"停止 → 启动"时重新拉起被中断的动画链。
      vehicleAnimations.push(animateVehicle(vehicle, pos))
    })
  }

  // 创建路灯
  const createStreetLights = () => {
    const lightPositions: LngLat[] = [
      { lng: centerLng - 0.005, lat: centerLat - 0.005 },
      { lng: centerLng + 0.005, lat: centerLat - 0.005 },
      { lng: centerLng - 0.005, lat: centerLat + 0.005 },
      { lng: centerLng + 0.005, lat: centerLat + 0.005 }
    ]

    lightPositions.forEach((pos, index) => {
      const light = activeViewer.entities.add({
        name: `Street Light ${index + 1}`,
        position: Cesium.Cartesian3.fromDegrees(pos.lng, pos.lat, 8),
        cylinder: {
          length: 8,
          topRadius: 0.1,
          bottomRadius: 0.1,
          material: cssColor(DARK_PALETTE.secondary, 0.55),
        },
        // 灯头：预警色（琥珀），大小与透明度沿用原来的量级
        point: {
          pixelSize: 20,
          color: cssColor(DARK_PALETTE.warning, 0.6)
        }
      })

      state.trafficEntities.push(markRaw(light))
    })
  }

  const animateVehicle = (vehicle: Cesium.Entity, pos: VehiclePosition): VehicleAnimation => {
    let distance = 0
    const speed = 0.00001 // 移动速度
    // 该车辆当前是否挂着一条动画链。用于保证 restart 幂等：
    // 链还在跑的时候不再启动第二条，否则快速反复点击"启动/停止"
    // 会开出多条并行链，每帧做多倍无用功。
    let running = false

    const moveVehicle = () => {
      // 每次进入先清掉运行标记：如果下面因为交通隐藏而提前返回，
      // 就说明这条链已经断开，toggleTraffic 可以安全地重新拉起它。
      running = false
      if (!state.trafficVisible) return

      distance += speed
      if (distance > 0.02) distance = -0.02

      let newLng = pos.lng
      let newLat = pos.lat

      switch (pos.direction) {
        case 'east':
          newLng = cityConfig.center.lng - 0.01 + distance
          break
        case 'west':
          newLng = cityConfig.center.lng + 0.01 - distance
          break
        case 'north':
          newLat = cityConfig.center.lat - 0.01 + distance
          break
        case 'south':
          newLat = cityConfig.center.lat + 0.01 - distance
          break
      }

      // Entity.position 运行时同样接受裸的 Cartesian3（自动包成
      // ConstantPositionProperty），见 types/city.ts 的 WritableEntity。
      const writableVehicle = vehicle as WritableEntity
      writableVehicle.position = Cesium.Cartesian3.fromDegrees(newLng, newLat, 0.5)
      running = true
      safeRequestAnimationFrame(moveVehicle)
    }

    // 重新拉起这条动画链。幂等：链还在跑的时候不重复启动。
    const restart = () => {
      if (running) return
      moveVehicle()
    }

    moveVehicle()

    return { vehicle, pos, restart }
  }

  // 执行创建
  createTrafficLight({ lng: centerLng + 0.001, lat: centerLat })
  createTrafficLight({ lng: centerLng, lat: centerLat + 0.001 })
  createVehicles()
  createStreetLights()
}

/* ---------------------------------------------------------------------------
 * 控制函数
 * ------------------------------------------------------------------------- */

const toggleBuildings = () => {
  state.buildingVisible = !state.buildingVisible
  state.buildingEntities.forEach(entity => {
    entity.show = state.buildingVisible
  })
  // 描边是建筑的另一半，隐藏建筑时也要一起藏
  if (buildingGlowPrimitive) buildingGlowPrimitive.show = state.buildingVisible
}

const toggleRoads = () => {
  state.roadVisible = !state.roadVisible
  state.roadEntities.forEach(entity => {
    entity.show = state.roadVisible
  })
  // 流动光效层是 Primitive，不在实体列表里，要单独开关
  if (flowPrimitive) flowPrimitive.show = state.roadVisible
}

const toggleTraffic = () => {
  state.trafficVisible = !state.trafficVisible
  state.trafficEntities.forEach(entity => {
    entity.show = state.trafficVisible
  })

  // moveVehicle 在交通隐藏时会提前 return（不再排下一帧），动画链就此断掉。
  // 重新显示交通时必须显式 restart 每辆车，否则车辆会永远停在最后一次的位置，
  // 只有刷新页面才能恢复运动。restart 本身是幂等的，不会开出第二条并行链。
  if (state.trafficVisible) {
    vehicleAnimations.forEach(animation => animation.restart())
  }
}

const toggleView = () => {
  state.viewMode = state.viewMode === 'overhead' ? 'street' : 'overhead'
  if (state.viewMode === 'street') {
    flyToStreetLevel()
  } else {
    flyToOverhead()
  }
}

// 生命周期钩子
onMounted(async () => {
  // 色板写进 CSS 自定义属性：面板样式表与 3D 场景共用同一份配色
  applyThemeVariables()
  // 交通状态与 Cesium 无关：先把轮询挂上，
  // 即使 3D 初始化失败，控制面板上的实时读数也还在动。
  startTrafficPolling()
  // 城市指标要走外部上游（慢的时候最多 5 秒）——**不 await**：
  // 绝不能让它拖慢 3D 场景的装配。失败也只影响指标带，不影响城市本身。
  loadCityOverview()
  startCityOverviewPolling()
  try {
    await initCesium()
    if (!viewer.value) return
    optimizePerformance()
    await loadAll()
    if (!isMounted) return
    // 让浏览器**先**把面板画出来，再去做后面的同步场景装配。
    // 首屏 LCP 量的是页面文字块（面板上那行大号数字），不是画布：
    // 不让出这一帧的话，这行字要等几百毫秒的装配做完才画得出来，
    // LCP 会直接被推到 3 秒以后（实测 3.9 s）。
    await nextTick()
    await nextPaint()
    if (!isMounted) return
    await loadGeoJSONBuildings()
    await loadGeoJSONRoads()
    // 两次 await 之后组件可能已经被卸载，viewer.value 也会被置空
    if (!isMounted || !viewer.value) return
    // 数字底座的发光网格：铺在数据范围上
    const collections: Array<{ features: Array<{ geometry: { type: string; coordinates: unknown } }> }> = []
    if (buildings.value) collections.push(buildings.value)
    if (roads.value) collections.push(roads.value)
    const extent = computeExtent(collections)
    if (extent) createBaseGrid(extent)
    createTrafficSystem()
    // 城市真的入场景了：横幅可以撤了
    sceneAssembled.value = true
  } catch (error) {
    console.error('初始化错误:', error)
    // 出错了也要撤横幅，否则「正在加载城市数据…」会一直挂着
    sceneAssembled.value = true
  }
})

onUnmounted(() => {
  isMounted = false
  cancelAllAnimations()
  stopTrafficPolling()
  stopCityOverviewPolling()
  if (interactionHandler) {
    interactionHandler.destroy()
    interactionHandler = null
  }
  if (viewer.value) {
    viewer.value.scene.preRender.removeEventListener(onScenePreRender)
    viewer.value.destroy()
    viewer.value = null
  }
})
</script>

<style scoped>
.smart-city-container {
  position: relative;
  width: 100vw;
  height: 100vh;
  background: var(--dc-screen, #050a14);
}

.cesium-container {
  width: 100%;
  height: 100%;
}

/* 控制面板：深色半透明 + 1px 蓝色描边 */
.control-panel {
  position: absolute;
  top: 20px;
  left: 20px;
  z-index: 100;
  min-width: 268px;
  padding: 16px 18px 14px;
  background: var(--dc-panel-bg, rgba(13, 26, 46, 0.82));
  border: 1px solid rgba(22, 93, 255, 0.55);
  border-radius: 2px;
  color: var(--dc-text, #e2e8f0);
  box-shadow: 0 0 28px rgba(22, 93, 255, 0.18);
  /* 不用 backdrop-filter：软件渲染（headless SwiftShader）下它会在
     WebGL 画布上采出彩色噪点。半透明底 + 描边已经够「科技风」了。 */
}

/* 四角 L 形切角装饰 */
.control-panel::before,
.control-panel::after {
  content: '';
  position: absolute;
  width: 13px;
  height: 13px;
  border: 1px solid var(--dc-flow, #22d3ee);
  pointer-events: none;
}

.control-panel::before {
  top: -1px;
  left: -1px;
  border-right: none;
  border-bottom: none;
}

.control-panel::after {
  right: -1px;
  bottom: -1px;
  border-left: none;
  border-top: none;
}

.control-panel button {
  display: block;
  width: 100%;
  margin: 8px 0 0;
  padding: 8px 14px;
  background: rgba(5, 10, 20, 0.72);
  color: var(--dc-text, #e2e8f0);
  border: 1px solid rgba(59, 130, 246, 0.5);
  border-radius: 2px;
  font-family: inherit;
  font-size: 13px;
  letter-spacing: 0.06em;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
}

.control-panel button:hover {
  border-color: var(--dc-flow, #22d3ee);
  color: var(--dc-flow, #22d3ee);
  box-shadow: 0 0 14px rgba(34, 211, 238, 0.25);
}

/* 数据加载状态提示：与控制面板同一套深色半透明观感 */
.status-hint,
.status-error {
  margin-bottom: 8px;
  padding: 6px 8px;
  border-radius: 2px;
  background: var(--dc-panel-surface, rgba(5, 10, 20, 0.55));
  font-size: 13px;
  line-height: 1.4;
  word-break: break-all;
}

.status-hint {
  color: var(--dc-flow, #22d3ee);
}

.status-error {
  color: var(--dc-alert, #f43f5e);
}

/* 城市运行指标带：一格一个指标，带来源标注与时间戳 */
.metric-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.metric-slot {
  flex: 1 1 118px;
  min-width: 118px;
  padding: 8px 10px;
  background: var(--dc-panel-surface, rgba(5, 10, 20, 0.55));
  border: 1px solid rgba(22, 93, 255, 0.28);
  border-radius: 2px;
}

.metric-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
}

.metric-label {
  font-size: 11px;
  letter-spacing: 0.12em;
  color: rgba(226, 232, 240, 0.72);
}

/* 模型估算标记：橙色（预警色），与「实测」区分开 */
.metric-estimate {
  font-size: 10px;
  white-space: nowrap;
  color: var(--dc-warning, #f59e0b);
}

.metric-body {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-top: 4px;
}

.metric-value {
  font-family: Consolas, 'SF Mono', 'Roboto Mono', ui-monospace, monospace;
  font-size: 21px;
  font-weight: 600;
  line-height: 1.15;
  color: var(--dc-flow, #22d3ee);
  text-shadow: 0 0 12px rgba(34, 211, 238, 0.35);
}

/* 取不到的值：不冒充 0，也不冒充旧值 —— 直说「数据源暂不可用」 */
.metric-value-unavailable {
  font-family: inherit;
  font-size: 11px;
  font-weight: 400;
  line-height: 1.4;
  color: rgba(226, 232, 240, 0.45);
  text-shadow: none;
}

.metric-badge {
  padding: 1px 6px;
  border: 1px solid currentColor;
  border-radius: 2px;
  font-size: 11px;
  letter-spacing: 0.08em;
}

.metric-badge.tone-ok {
  color: var(--dc-flow, #22d3ee);
}

.metric-badge.tone-warn {
  color: var(--dc-warning, #f59e0b);
}

.metric-badge.tone-alert {
  color: var(--dc-alert, #f43f5e);
}

.metric-sub {
  margin-top: 3px;
  font-size: 11px;
  color: rgba(226, 232, 240, 0.6);
}

/* 来源标注：来源名 + 观测时间。悬停出完整信息（地址、观测时间、取数时间） */
.metric-source {
  margin-top: 3px;
  font-size: 10px;
  line-height: 1.35;
  color: rgba(226, 232, 240, 0.42);
  cursor: help;
}

/* 实时交通读数：标签 + 大号等宽数字 + 拥堵徽标 + 时间 */
.traffic-status {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 10px;
  margin-bottom: 10px;
  padding: 10px 12px;
  background: var(--dc-panel-surface, rgba(5, 10, 20, 0.55));
  border: 1px solid rgba(22, 93, 255, 0.28);
  border-radius: 2px;
}

.traffic-label {
  font-size: 12px;
  letter-spacing: 0.16em;
  color: rgba(226, 232, 240, 0.72);
}

.traffic-value {
  font-family: Consolas, 'SF Mono', 'Roboto Mono', ui-monospace, monospace;
  font-size: 25px;
  font-weight: 600;
  line-height: 1;
  color: var(--dc-flow, #22d3ee);
  text-shadow: 0 0 14px rgba(34, 211, 238, 0.45);
}

.traffic-badge {
  padding: 2px 8px;
  border: 1px solid currentColor;
  border-radius: 2px;
  font-size: 12px;
  letter-spacing: 0.08em;
}

.traffic-badge.tone-ok {
  color: var(--dc-flow, #22d3ee);
}

.traffic-badge.tone-warn {
  color: var(--dc-warning, #f59e0b);
}

.traffic-badge.tone-alert {
  color: var(--dc-alert, #f43f5e);
}

.traffic-clock {
  font-family: Consolas, 'SF Mono', ui-monospace, monospace;
  font-size: 12px;
  color: rgba(226, 232, 240, 0.55);
}

/* OSM 署名：ODbL 要求，不可删除 */
.attribution {
  margin-top: 12px;
  padding-top: 9px;
  border-top: 1px solid rgba(22, 93, 255, 0.28);
  color: rgba(226, 232, 240, 0.5);
  font-size: 12px;
  line-height: 1.4;
}
</style>
