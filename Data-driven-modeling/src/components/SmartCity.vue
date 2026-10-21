<template>
  <div class="smart-city-container">
    <!-- Cesium容器 -->
    <div ref="cesiumContainer" class="cesium-container"></div>

    <!-- 控制面板 -->
    <div class="control-panel">
      <!-- 数据加载状态 / 后端错误提示：后端挂了必须看得见，不能只剩一个空地球 -->
      <div v-if="loading" class="status-hint">正在加载城市数据…</div>
      <div v-if="error" class="status-error">
        数据加载失败：{{ error.message }}<span v-if="error.status">（状态码 {{ error.status }}）</span>
      </div>

      <!-- 实时交通读数：后端按时间推导的交通状态。
           没有数据时不渲染这一行，绝不显示 undefined / NaN。 -->
      <div v-if="trafficSummary" class="traffic-status">{{ trafficSummary }}</div>

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

<script setup>
import { ref, computed, onMounted, onUnmounted, reactive, markRaw } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { useCityData } from '@/composables/useCityData'

// 移除手动设置的CESIUM_BASE_URL，让Vite自动处理

// 跟踪所有 requestAnimationFrame handle，onUnmounted 时统一取消
const animationFrames = new Set()

// 记录每辆车的动画句柄（{ vehicle, pos, restart }）。
// moveVehicle 在交通隐藏时会提前返回、动画链就此断掉，
// 重新显示交通时靠这里的 restart 把链重新拉起来。
const vehicleAnimations = []

function safeRequestAnimationFrame(callback) {
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

// 组件状态
const cesiumContainer = ref(null)
const viewer = ref(null)
const state = reactive({
  buildingVisible: true,
  roadVisible: true,
  trafficVisible: true,
  viewMode: 'overhead', // 'overhead' 鸟瞰 | 'street' 平视
  buildingEntities: [],
  roadEntities: [],
  trafficEntities: []
})

// 城市配置参数
const cityConfig = {
  // 天安门广场中央：开阔地带，平视模式不会穿模；朝北（heading=0）能看到天安门城楼
  center: { lng: 116.3976, lat: 39.9055 },
  zoomLevel: 1500,
  // 平视视角：1.7m 是人眼高度，朝向正北（heading=0）
  streetLevel: { height: 1.7, heading: 0 },
  buildingColors: [
    Cesium.Color.fromCssColorString('#4A90E2'),
    Cesium.Color.fromCssColorString('#7ED321'),
    Cesium.Color.fromCssColorString('#F5A623'),
    Cesium.Color.fromCssColorString('#D0021B'),
    Cesium.Color.fromCssColorString('#9013FE')
  ],
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
  // 宽度单位是米，配合 clampToGround 渲染：
  // 14m 的主干道配 4m 的人行道，就是预期的视觉层级。
  roadTiers: [
    {
      name: '主干道',
      highway: ['motorway', 'trunk', 'primary'],
      color: Cesium.Color.fromCssColorString('#3A3A3A'),
      width: 14
    },
    {
      name: '次干道',
      highway: ['secondary', 'tertiary'],
      color: Cesium.Color.fromCssColorString('#6E6E6E'),
      width: 10
    },
    {
      name: '支路',
      highway: ['residential', 'unclassified', 'service'],
      color: Cesium.Color.fromCssColorString('#9E9E9E'),
      width: 7
    },
    {
      name: '人行道/步行区',
      highway: ['footway', 'pedestrian', 'steps', 'path', 'cycleway'],
      color: Cesium.Color.fromCssColorString('#C8C8C8'),
      width: 4
    }
  ],
  // 兜底分级：highway 标签缺失、或取值不在上表里时用它。
  // OSM 的 highway 取值比上表多（motorway_link / living_street / track 等都在表外），
  // 没有兜底的话这些道路会没有样式。
  // 宽度取最低等级（4m，与人行道同级），避免把未知道路画得比主干道还宽。
  roadFallbackTier: {
    name: '其他道路',
    color: Cesium.Color.fromCssColorString('#C0C0C0'),
    width: 4
  }
}

// highway 标签 → 分级 的查表，建一次就够（2260 条道路各查一次）。
const ROAD_TIER_BY_HIGHWAY = cityConfig.roadTiers.reduce((map, tier) => {
  tier.highway.forEach(tag => map.set(tag, tier))
  return map
}, new Map())

// 按 highway 标签查道路分级：标签缺失或不在表内 → 兜底分级。
function resolveRoadTier(highwayTag) {
  if (typeof highwayTag !== 'string') return cityConfig.roadFallbackTier
  const tier = ROAD_TIER_BY_HIGHWAY.get(highwayTag.trim().toLowerCase())
  return tier || cityConfig.roadFallbackTier
}

// 读一个 OSM 标签值：Cesium 的 properties 是 PropertyBag，取值必须经过 getValue()。
// 标签缺失时返回 undefined。
function readTag(properties, key) {
  const prop = properties?.[key]
  if (!prop || typeof prop.getValue !== 'function') return undefined
  return prop.getValue()
}

// 把一个 OSM 高度类标签转成正数米数；无效或缺失时返回 null。
function parseHeightMeters(raw) {
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
function resolveBuildingHeight(properties, fallback) {
  const direct = parseHeightMeters(readTag(properties, 'height'))
  if (direct !== null) return direct
  const levels = parseHeightMeters(readTag(properties, 'building:levels'))
  if (levels !== null) return levels * 3
  return fallback
}

// 城市数据来源（通过 useCityData composable 从后端 /api/* 拉取 GeoJSON）
// error / loading 必须一起取出来，否则后端挂了界面上一片空白、毫无提示
// trafficStatus 同样要取：它此前请求了却被丢弃，界面上看不到任何实时读数
const { buildings, roads, trafficStatus, refreshTrafficStatus, loadAll, error, loading } = useCityData()

// 把任意取值转成有限数字；null / undefined / 空串 / 非数字一律返回 null。
function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

// 0..1 的指数 → 百分比文本；拿不到就返回 null（整段略过）。
function formatRatio(value) {
  const num = toFiniteNumber(value)
  if (num === null) return null
  return `${Math.round(num * 100)}%`
}

// 拥堵描述：优先用后端给的中文标签；没有标签时按拥堵指数自己分档。
function formatCongestion(label, level) {
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
function formatClock(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`
}

// 交通状态摘要：把后端返回的小对象整理成一行可读文本。
// 任何一项字段缺失都整段略过，绝不把 undefined / NaN 显示到界面上。
const trafficSummary = computed(() => {
  const status = trafficStatus.value
  if (!status || typeof status !== 'object') return null

  const segments = ['实时交通']
  const flow = formatRatio(status.flow)
  if (flow) segments.push(`流量 ${flow}`)
  const congestion = formatCongestion(status.congestion, status.congestion_level)
  if (congestion) segments.push(congestion)
  const clock = formatClock(status.update_time)
  if (clock) segments.push(`更新于 ${clock}`)
  return segments.join(' · ')
})

// 交通状态轮询间隔（毫秒）。计划书里的实时性主张是「5 秒级更新」；
// 这个端点不带 API key，前端可以直接轮询。
const TRAFFIC_POLL_INTERVAL_MS = 5000

let trafficTimer = null

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

// 高德 UrlTemplateImageryProvider —— 构造失败由 try/catch 包住，
// 但即使失败也要继续（地球没底图也能看到星空，至少能验证 Viewer 起来了）。
// 关键：必须在 new Cesium.Viewer 之前构造好 baseLayer。
// 因为 Cesium 1.134 Viewer 构造函数会读 baseLayer 选项决定是否透传给
// CesiumWidget；漏传或传 undefined 都会触发 fromWorldImagery() → ion 警告。
let gaodeLayer = null
try {
  const gaodeProvider = new Cesium.UrlTemplateImageryProvider({
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    subdomains: ['1', '2', '3', '4'],
    credit: new Cesium.Credit('© AutoNavi'),
    maximumLevel: 18,
  })
  gaodeLayer = new Cesium.ImageryLayer(gaodeProvider)
} catch (e) {
  console.warn('构造高德底图 provider 失败:', e)
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
  viewer.value = new Cesium.Viewer(cesiumContainer.value, {
    timeline: false,
    animation: false,
    baseLayerPicker: false, // 禁用底图切换 UI（避免 ion 401）
    geocoder: false,        // 禁用地理编码 UI（避免 ion 401）
    infoBox: false,         // 禁用信息框（消除 about:blank sandboxed iframe 警告）
    selectionIndicator: false, // 禁用选择指示器
    baseLayer: false,       // 显式告诉 CesiumWidget 完全不加底图（避免 fromWorldImagery）
    terrainProvider: undefined,
    useDefaultRenderLoop: true,
    sceneMode: Cesium.SceneMode.SCENE3D,
    errorHandler: function(error) {
      console.warn('Cesium初始化错误:', error)
    },
  })

  // Viewer 构造完成后,显式把高德底图 add 到 CesiumWidget 的 imageryLayers。
  if (gaodeLayer && gaodeLayer.imageryProvider) {
    viewer.value.imageryLayers.add(gaodeLayer)
    console.log('[SmartCity] Viewer created, gaode layer added. total layers:',
      viewer.value.imageryLayers.length,
      'first layer provider:',
      viewer.value.imageryLayers.get(0)?.imageryProvider?.constructor?.name)
  } else {
    console.warn('[SmartCity] gaodeLayer not available; no base imagery will be loaded')
  }

  // 定位到城市中心（鸟瞰视角）
  viewer.value.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      cityConfig.center.lng,
      cityConfig.center.lat,
      cityConfig.zoomLevel
    ),
    duration: 2,
  })
}

// 飞到平视视角：贴近地面（1.7m），pitch=0 水平看出去
const flyToStreetLevel = () => {
  if (!viewer.value) return
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

// 飞到鸟瞰视角：1500m 高空向下看
const flyToOverhead = () => {
  if (!viewer.value) return
  viewer.value.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      cityConfig.center.lng,
      cityConfig.center.lat,
      cityConfig.zoomLevel
    ),
    duration: 2,
  })
}

// 保持简单，不单独初始化影像图层，使用Cesium默认配置

// 优化3D场景性能
const optimizePerformance = () => {
  // 开启视锥体剔除（只渲染可见区域）
  viewer.value.scene.globe.enableLighting = true

  // 添加雾效果（远处建筑渐隐，减少渲染压力）
  viewer.value.scene.fog.density = 0.0002
  viewer.value.scene.fog.near = 1000 // 雾开始生效的距离
  viewer.value.scene.fog.far = 5000 // 雾完全遮挡的距离

  // 开启抗锯齿
  viewer.value.scene.postProcessStages.fxaa.enabled = true

  // 限制最大帧率（避免过度消耗GPU）
  viewer.value.scene.maximumFrameRate = 60
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
      const height = resolveBuildingHeight(entity.properties, cityConfig.defaultBuildingHeight)
      // 随机选择建筑颜色
      const color = cityConfig.buildingColors[Math.floor(Math.random() * cityConfig.buildingColors.length)]

      // 将多边形拉伸为3D建筑
      entity.polygon.extrudedHeight = height // 拉伸高度（米）
      entity.polygon.material = color.withAlpha(0.8) // 建筑颜色
      entity.polygon.outline = true // 显示轮廓
      entity.polygon.outlineColor = Cesium.Color.WHITE // 轮廓颜色

      // 存入状态管理，用于控制显示/隐藏。
      // markRaw：Cesium Entity 是引擎对象，不是视图状态，
      // 别让 Vue 给它套一层响应式代理（几千个实体的代理开销与被代理对象内部行为都有风险）。
      state.buildingEntities.push(markRaw(entity))
    })

    if (isMounted) {
      viewer.value.dataSources.add(dataSource)
    }
  } catch (error) {
    console.error('加载建筑 GeoJSON 失败:', error)
  }
}

// 加载真实GeoJSON道路数据
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
      // OSM 道路数据里可能混进 Polygon/MultiPolygon（广场、人造地面等），
      // 它们没有 polyline 属性，直接 entity.polyline.width = ... 会抛
      // "Cannot set properties of undefined"。用 Cesium.defined 守门。
      if (!entity.polyline) return
      // 按 OSM 的 highway 标签定级（type 标签在道路数据里根本不存在）
      const tier = resolveRoadTier(readTag(entity.properties, 'highway'))
      // 宽度：优先用 OSM 的 width 标签（单位：米），但只在它是正数、
      // 且不超过该分级的默认宽度时才采用——数据里存在 '30' 这种异常值，
      // 直接采用会把人行道画成 30 米宽。非法或超纲一律用分级默认宽度。
      const taggedWidth = Number(readTag(entity.properties, 'width'))
      const width = Number.isFinite(taggedWidth) && taggedWidth > 0 && taggedWidth <= tier.width
        ? taggedWidth
        : tier.width

      // 配置道路样式
      entity.polyline.width = width // 道路宽度（米，始终是数字）
      entity.polyline.material = tier.color // 道路颜色（按 highway 分级）
      entity.polyline.clampToGround = true // 贴地显示

      // 存入状态管理，用于控制显示/隐藏
      state.roadEntities.push(markRaw(entity))
    })

    if (isMounted) {
      viewer.value.dataSources.add(dataSource)
    }
  } catch (error) {
    console.error('加载道路 GeoJSON 失败:', error)
  }
}

// 创建交通系统
const createTrafficSystem = () => {
  // 组件可能已经卸载（onUnmounted 里 viewer.value 被置空），
  // 此时直接返回，避免 "Cannot read properties of null (reading 'entities')"。
  if (!viewer.value) return

  const centerLng = cityConfig.center.lng
  const centerLat = cityConfig.center.lat

  // 创建交通灯
  const createTrafficLight = (position) => {
    const trafficLight = viewer.value.entities.add({
      name: 'Traffic Light',
      position: Cesium.Cartesian3.fromDegrees(position.lng, position.lat, 0),
      cylinder: {
        length: 5,
        topRadius: 0.1,
        bottomRadius: 0.1,
        material: Cesium.Color.DARKGRAY,
      },
      point: {
        pixelSize: 12,
        color: Cesium.Color.RED,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
      },
    })

    state.trafficEntities.push(markRaw(trafficLight))
  }

  // 创建车辆
  const createVehicles = () => {
    const vehiclePositions = [
      { lng: centerLng - 0.01, lat: centerLat, direction: 'east' },
      { lng: centerLng + 0.01, lat: centerLat, direction: 'west' },
      { lng: centerLng, lat: centerLat - 0.01, direction: 'north' },
      { lng: centerLng, lat: centerLat + 0.01, direction: 'south' }
    ]

    vehiclePositions.forEach((pos, index) => {
      const vehicle = viewer.value.entities.add({
        name: `Vehicle ${index + 1}`,
        position: Cesium.Cartesian3.fromDegrees(pos.lng, pos.lat, 0.5),
        box: {
          dimensions: new Cesium.Cartesian3(2.0, 1.0, 0.6),
          material: Cesium.Color.fromCssColorString('#4A90E2'),
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
    const lightPositions = [
      { lng: centerLng - 0.005, lat: centerLat - 0.005 },
      { lng: centerLng + 0.005, lat: centerLat - 0.005 },
      { lng: centerLng - 0.005, lat: centerLat + 0.005 },
      { lng: centerLng + 0.005, lat: centerLat + 0.005 }
    ]

    lightPositions.forEach((pos, index) => {
      const light = viewer.value.entities.add({
        name: `Street Light ${index + 1}`,
        position: Cesium.Cartesian3.fromDegrees(pos.lng, pos.lat, 8),
        cylinder: {
          length: 8,
          topRadius: 0.1,
          bottomRadius: 0.1,
          material: Cesium.Color.DARKGRAY,
        },
        // 添加灯光效果
        point: {
          pixelSize: 20,
          color: Cesium.Color.YELLOW.withAlpha(0.6)
        }
      })

      state.trafficEntities.push(markRaw(light))
    })
  }

  const animateVehicle = (vehicle, pos) => {
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

      vehicle.position = Cesium.Cartesian3.fromDegrees(newLng, newLat, 0.5)
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

// 控制函数
const toggleBuildings = () => {
  state.buildingVisible = !state.buildingVisible
  state.buildingEntities.forEach(entity => {
    entity.show = state.buildingVisible
  })
}

const toggleRoads = () => {
  state.roadVisible = !state.roadVisible
  state.roadEntities.forEach(entity => {
    entity.show = state.roadVisible
  })
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
  // 交通状态与 Cesium 无关：先把轮询挂上，
  // 即使 3D 初始化失败，控制面板上的实时读数也还在动。
  startTrafficPolling()
  try {
    await initCesium()
    if (!viewer.value) return
    optimizePerformance()
    await loadAll()
    if (!isMounted) return
    await loadGeoJSONBuildings()
    await loadGeoJSONRoads()
    // 两次 await 之后组件可能已经被卸载，viewer.value 也会被置空
    if (!isMounted || !viewer.value) return
    createTrafficSystem()
  } catch (error) {
    console.error('初始化错误:', error)
  }
})

onUnmounted(() => {
  isMounted = false
  cancelAllAnimations()
  stopTrafficPolling()
  if (viewer.value) {
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
}

.cesium-container {
  width: 100%;
  height: 100%;
}

.control-panel {
  position: absolute;
  top: 20px;
  left: 20px;
  z-index: 100;
  background: rgba(0, 0, 0, 0.7);
  padding: 15px;
  border-radius: 8px;
}

.control-panel button {
  display: block;
  margin: 8px 0;
  padding: 8px 16px;
  background: #4A90E2;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.3s;
}

.control-panel button:hover {
  background: #357ABD;
}

/* 数据加载状态提示：与控制面板同一套深色半透明观感 */
.status-hint,
.status-error,
.traffic-status {
  margin-bottom: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.7);
  font-size: 13px;
  line-height: 1.4;
  word-break: break-all;
}

.status-hint {
  color: #9ad;
}

.status-error {
  color: #ff6b6b;
}

/* 实时交通读数：与加载/错误提示同一套观感，只是换个颜色区分 */
.traffic-status {
  color: #7ed321;
}

/* OSM 署名：ODbL 要求，不可删除 */
.attribution {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.2);
  color: #aaa;
  font-size: 12px;
  line-height: 1.4;
}

.building-info {
  padding: 10px;
  font-family: Arial, sans-serif;
}

.building-info h3 {
  margin: 0 0 10px 0;
  color: #4A90E2;
}

.building-info p {
  margin: 5px 0;
  color: #333;
}
</style>
