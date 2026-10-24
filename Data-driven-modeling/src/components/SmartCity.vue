<template>
  <div class="smart-city-container">
    <!-- Cesium容器：保持全屏。
         大屏面板以 overlay 的形式浮在它上面（计划书 §1.2），
         中心留空让 3D 场景透出来 —— 所以一行 Cesium 逻辑都不用改。 -->
    <div ref="cesiumContainer" class="cesium-container"></div>

    <!-- 16:9 大屏骨架：顶栏（标题 + 页签 + 读数带）/ 左列 / 中心场景 / 右列 / 通栏底栏 -->
    <DashboardOverlay
      :overview="cityOverview"
      :events="resolvedEvents"
      :stage="stage"
      @select-event="flyToEvent"
    >
      <!-- 顶栏右侧读数带：S1 的城市运行指标带 + 实时交通读数。
           类名与内容一个字没改，只是从左列搬到了顶栏右侧 ——
           同一个数字不在大屏上出现两次（左列的指标卡不再重复它们）。 -->
      <template #top-extra>
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
      </template>

      <!-- 底栏右侧：控制面板（4 个按钮 + 主题入口 + OSM 署名 + 加载/错误横幅）。
           类名与行为都不变，只是位置搬进了通栏底栏。 -->
      <template #bottom-right>
        <!-- 外层壳：主题面板浮在它上方（壳是它的定位参照）。
             主题面板**不在 .control-panel 里** —— 那样它自己的按钮会混进
             控制面板的按钮集合，DOM 契约就不稳了。 -->
        <div class="control-panel-shell">
          <div class="control-panel">
            <!-- 数据加载状态 / 后端错误提示：后端挂了必须看得见，不能只剩一个空地球。
                 横幅要等「数据到位 **且** 建筑/道路都挂进场景」才消失 ——
                 这一刻才是城市真的画出来了（不只是 API 回来了）。 -->
            <div v-if="loading || !sceneAssembled" class="status-hint">正在加载城市数据…</div>
            <div v-if="error" class="status-error">
              数据加载失败：{{ error.message }}<span v-if="error.status">（状态码 {{ error.status }}）</span>
            </div>

            <div class="control-panel-actions">
              <!-- 城市切换：换一整套场景数据（建筑 / 道路 / 指标 / 相机），
                   所以走**整页导航**（带 ?city= 的固定链接），不做局部热替换 ——
                   局部热替换要重装几千个实体，还要重算相机轨道与底座网格，
                   容易出「画面是旧城的、数字是新城的」这种不一致。 -->
              <label class="control-panel-city">
                <span>城市</span>
                <select :value="cityId" @change="onCityChange">
                  <option v-for="option in cityOptions" :key="option.id" :value="option.id">
                    {{ option.label }}
                  </option>
                </select>
              </label>
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

            <!-- 主题入口：展开 / 收起主题面板。
                 当前主题名直接写在按钮上 —— 不点开也知道现在用的是哪一套。 -->
            <button
              type="button"
              class="control-panel-theme"
              :class="{ 'is-open': themePanelOpen }"
              :aria-expanded="themePanelOpen"
              @click="themePanelOpen = !themePanelOpen"
            >
              主题 · {{ theme.label }}
            </button>

            <!-- OSM 数据遵循 ODbL：展示这份数据必须署名。删掉这一行等于违反许可证。 -->
            <div class="attribution">数据 © OpenStreetMap contributors</div>
          </div>

          <!-- 主题面板：3 套默认主题 + 自选色 / 辉光 / 不透明度 -->
          <ThemePicker v-if="themePanelOpen" />
        </div>
      </template>
    </DashboardOverlay>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { useCityData } from '@/composables/useCityData'
import { useDashboardState } from '@/composables/useDashboardState'
import { useCameraRig } from '@/composables/useCameraRig'
import { useEventMarkers } from '@/composables/useEventMarkers'
import { useSceneLinkageEffect } from '@/composables/useSceneLinkageEffect'
import { useSceneStage, computeExtent, nextPaint, setActiveCityScene } from '@/composables/useSceneStage'
import { useTheme } from '@/composables/useTheme'
import { useTrafficFleet } from '@/composables/useTrafficFleet'
import DashboardOverlay from './DashboardOverlay.vue'
import ThemePicker from './dashboard/ThemePicker.vue'
import { applyThemeVariables, resolveTrafficTone } from '@/theme/dark'
import type { TrafficTone } from '@/theme/dark'
import type { Metric } from '../../types/city'

/**
 * 场景层已经拆成五个 composable（都在 `src/composables/` 下）：
 *
 * - `useSceneStage` —— Cesium 初始化、深色底座、发光网格、建筑与道路装配、批量描边；
 * - `useCameraRig` —— 鸟瞰/平视、环绕自转、交互打断与恢复、相机飞行；
 * - `useTrafficFleet` —— 车辆与路灯；
 * - `useEventMarkers` —— 事件光柱 / 体量圆柱 / 脉冲环，点事件飞过去；
 * - `useSceneLinkageEffect` —— 页签联动在场景里的副作用。
 *
 * 共享可变状态（viewer、各 Primitive 引用、自转状态、事件标记）**各只有一份**，
 * 都归场景底座管；这个组件只做接线，不再直接调 Cesium API。
 */

/** Cesium 容器（场景底座建 Viewer 时用）。 */
const cesiumContainer = ref<HTMLDivElement | null>(null)

/**
 * 场景是否已装配完成（数据到位 **且** 建筑/道路都挂进场景）。
 *
 * 加载横幅要等它也为 true 才消失：横幅消失的那一刻，城市是真的画出来了。
 * 3854 个建筑实体 + 3854 条批量描边几何的装配是**同步**的（几百毫秒），
 * 这段时间必须被横幅盖住，否则用户会看到「横幅没了但城市还没出来」。
 */
const sceneAssembled = ref(false)

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
  cityId,
  cityOptions,
} = useCityData()

/** 换城市：整页导航到新城市的固定链接（?city=milano）。 */
function onCityChange(event: Event) {
  const next = (event.target as HTMLSelectElement).value
  if (!next || next === cityId.value) return
  const url = new URL(window.location.href)
  url.searchParams.set('city', next)
  window.location.assign(url.toString())
}

// 大屏页签状态是**模块级单例**（S2 做的）：大屏与 3D 场景共用同一份 ——
// 「页签切换 → 场景联动」就靠它。
const { activeTabKey } = useDashboardState()

/* ---------------------------------------------------------------------------
 * 场景层接线
 * ------------------------------------------------------------------------- */

// 场景底座：viewer / 视图状态 / 各 Primitive 引用都归它管（全项目唯一一份）。
const stage = useSceneStage({ container: cesiumContainer, buildings, roads })
const { viewer, state } = stage
const { toggleBuildings, toggleRoads, loadGeoJSONBuildings, loadGeoJSONRoads } = stage

/* ---------------------------------------------------------------------------
 * 主题 → 场景换色
 * ------------------------------------------------------------------------- */

/**
 * 当前主题（主题 + 用户覆盖的解析结果）。
 *
 * 状态是**模块级单例**（`useTheme`），所以大屏面板与 3D 场景看到的是同一份。
 */
const { theme } = useTheme()

/** 主题面板是否展开。展开状态是纯界面状态，留在组件里。 */
const themePanelOpen = ref(false)

/**
 * 主题变了就换色。immediate：**首次挂载也要应用一次**（场景刚建好时配色已经是对的）。
 *
 * `stage.applyTheme` 只改材质 uniform 与 Property 的**值**，不重建任何几何
 * （3854 栋楼 / 2260 条路的 Primitive 与实体都不动）—— 这是切主题不卡的前提。
 */
watch(theme, next => stage.applyTheme(next), { immediate: true })

// 相机机位：自转状态（cameraOrbit）归它管。
const camera = useCameraRig({ viewer, state, primitives: stage.primitives })
const { toggleView } = camera

// 车队：车辆与路灯。
const fleet = useTrafficFleet({ viewer, state })
const { toggleTraffic, createTrafficSystem } = fleet

// 事件标记：光柱 / 体量圆柱 / 脉冲环。
const markers = useEventMarkers({ viewer, camera, cityOverview })
const { resolvedEvents, flyToEvent } = markers

// 页签联动在场景里的副作用（高亮焦点、压暗其余）。
const linkage = useSceneLinkageEffect({
  viewer,
  primitives: stage.primitives,
  buildings,
  cityOverview,
})

/* ---------------------------------------------------------------------------
 * 实时交通读数
 * ------------------------------------------------------------------------- */

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
 * 页签切换 → 场景联动
 * ------------------------------------------------------------------------- */

// 页签切换 → 重新应用联动（不移动相机：用户没点事件，就不许乱飞）。
watch(activeTabKey, () => {
  linkage.applySceneLinkage()
})

// 事件集合变化 → 重建场景里的标记（光柱 + 脉冲环）。
watch(resolvedEvents, () => {
  markers.syncEventMarkers()
})

// 数据到位后补一次：页签可能在建筑/指标加载完之前就切过了。
watch([() => cityOverview.value, () => buildings.value], () => {
  linkage.applySceneLinkage()
  markers.syncEventMarkers()
})

/* ---------------------------------------------------------------------------
 * 生命周期
 * ------------------------------------------------------------------------- */

onMounted(async () => {
  // 先把场景参数切到当前城市（城心 / 鸟瞰高度 / 平视落点都是**逐城不同**的事实）。
  // 必须在 initCesium 之前 —— 相机第一次定位读的就是它们。
  setActiveCityScene(cityId.value)
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
    await stage.initCesium(camera)
    if (!viewer.value) return
    stage.optimizePerformance()
    await loadAll()
    if (!stage.mounted.value) return
    // 让浏览器**先**把面板画出来，再去做后面的同步场景装配。
    // 首屏 LCP 量的是页面文字块（面板上那行大号数字），不是画布：
    // 不让出这一帧的话，这行字要等几百毫秒的装配做完才画得出来，
    // LCP 会直接被推到 3 秒以后（实测 3.9 s）。
    await nextTick()
    await nextPaint()
    if (!stage.mounted.value) return
    await loadGeoJSONBuildings()
    await loadGeoJSONRoads()
    // 两次 await 之后组件可能已经被卸载，viewer.value 也会被置空
    if (!stage.mounted.value || !viewer.value) return
    // 数字底座的发光网格：铺在数据范围上
    const collections: Array<{ features: Array<{ geometry: { type: string; coordinates: unknown } }> }> = []
    if (buildings.value) collections.push(buildings.value)
    if (roads.value) collections.push(roads.value)
    const extent = computeExtent(collections)
    if (extent) stage.createBaseGrid(extent)
    createTrafficSystem()
    // 事件标记与页签联动：场景装好了才挂（挂早了没有几何可定位）。
    markers.syncEventMarkers()
    linkage.applySceneLinkage()
    // 城市真的入场景了：横幅可以撤了
    sceneAssembled.value = true
  } catch (error) {
    console.error('初始化错误:', error)
    // 出错了也要撤横幅，否则「正在加载城市数据…」会一直挂着
    sceneAssembled.value = true
  }
})

onUnmounted(() => {
  stage.mounted.value = false
  fleet.cancelAllAnimations()
  stopTrafficPolling()
  stopCityOverviewPolling()
  // 事件标记与焦点描边必须清掉：重新挂载不许叠加。
  markers.clearEventMarkers()
  linkage.removeFocusGlow()
  camera.detach(viewer.value)
  stage.destroyViewer()
})
</script>

<style scoped>
.smart-city-container {
  position: relative;
  width: 100vw;
  height: 100vh;
  /* 大屏 overlay 是 inset: 0 + overflow: hidden：窄屏也不许出现横向滚动条 */
  overflow: hidden;
  background: var(--dc-screen, #04070f);
}

.cesium-container {
  width: 100%;
  height: 100%;
}

/* 控制面板的外层壳：主题面板浮在它上方（壳是它的定位参照）。
   壳只是定位与尺寸的容器，不改变面板本身的视觉。 */
.control-panel-shell {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
}

/* 控制面板：现在是**通栏底栏右侧**的一块（不是独立浮层）。
   外框由底栏那张卡片提供，这里只留内容 —— 免得「框里套框」。 */
.control-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  height: 100%;
  min-height: 0;
  color: var(--dc-text, #cbd5e1);
}

/* 四个控制按钮：2×2 排布（类名与行为不变） */
.control-panel-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

/* 城市切换：占满一行（它比按钮重要 —— 它决定整套数据）。
   下拉框沿用按钮的视觉：同样的底色、描边与字号。 */
.control-panel-city {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--dc-label-size, 11px);
  color: var(--dc-text, #cbd5e1);
}

.control-panel-city select {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  font: inherit;
  font-size: var(--dc-label-size, 11px);
  color: var(--dc-text, #cbd5e1);
  background: var(--dc-panel, #0b1526);
  border: 1px solid var(--dc-border, #1e3a5f);
  border-radius: 4px;
  cursor: pointer;
}

.control-panel-city select:focus-visible {
  outline: 2px solid var(--dc-flow, #0e7490);
  outline-offset: 1px;
}

/* 主题入口按钮：和其它控制按钮同一套视觉。
   展开时加一道左侧标记条 —— 选中态不只靠颜色传达。 */
.control-panel-theme.is-open {
  border-color: var(--dc-flow, #0e7490);
  box-shadow: inset 2px 0 0 var(--dc-flow, #0e7490);
}

.control-panel button {
  display: block;
  width: 100%;
  margin: 0;
  padding: 5px 10px;
  background: color-mix(in srgb, var(--dc-screen, #04070f) 72%, transparent);
  color: var(--dc-text, #cbd5e1);
  border: 1px solid color-mix(in srgb, var(--dc-secondary, #24507f) 50%, transparent);
  border-radius: 2px;
  font-family: inherit;
  font-size: 12px;
  letter-spacing: 0.06em;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
}

.control-panel button:hover {
  border-color: var(--dc-flow, #0e7490);
  color: var(--dc-flow, #0e7490);
  box-shadow: 0 0 14px color-mix(in srgb, var(--dc-flow, #0e7490) 25%, transparent);
}

/* 数据加载状态提示：与控制面板同一套深色半透明观感 */
.status-hint,
.status-error {
  margin-bottom: 4px;
  padding: 4px 8px;
  border-radius: 2px;
  background: var(
    --dc-panel-surface,
    color-mix(in srgb, var(--dc-screen, #04070f) 55%, transparent)
  );
  font-size: 11px;
  line-height: 1.4;
  word-break: break-all;
}

.status-hint {
  color: var(--dc-flow, #0e7490);
}

.status-error {
  color: var(--dc-alert, #f43f5e);
}

/* 城市运行指标带：**顶栏右侧**的一条紧凑横向读数带。
   三个槽并排，每槽「标签 + 数值 + 来源小字」。
   槽位**允许收缩**（`min-width: 0` + 省略号）：窄屏时宁可截断标签，
   也不能把读数带撑到压住标题或页签。 */
.metric-strip {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  min-width: 0;
}

.metric-slot {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  padding: 4px 8px;
  background: var(
    --dc-panel-surface,
    color-mix(in srgb, var(--dc-screen, #04070f) 55%, transparent)
  );
  border: 1px solid color-mix(in srgb, var(--dc-accent, #1e40af) 28%, transparent);
  border-radius: 2px;
}

.metric-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}

.metric-label {
  font-size: 10px;
  letter-spacing: 0.1em;
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 72%, var(--dc-screen, #04070f));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 模型估算标记：橙色（预警色），与「实测」区分开 */
.metric-estimate {
  font-size: 9px;
  white-space: nowrap;
  color: var(--dc-warning, #f59e0b);
}

.metric-body {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
}

.metric-value {
  font-family: Consolas, 'SF Mono', 'Roboto Mono', ui-monospace, monospace;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.15;
  color: var(--dc-flow, #0e7490);
  text-shadow: 0 0 10px color-mix(in srgb, var(--dc-flow, #0e7490) 30%, transparent);
}

/* 取不到的值：不冒充 0，也不冒充旧值 —— 直说「数据源暂不可用」 */
.metric-value-unavailable {
  font-family: inherit;
  font-size: 11px;
  font-weight: 400;
  line-height: 1.4;
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 45%, var(--dc-screen, #04070f));
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
  color: var(--dc-flow, #0e7490);
}

.metric-badge.tone-warn {
  color: var(--dc-warning, #f59e0b);
}

.metric-badge.tone-alert {
  color: var(--dc-alert, #f43f5e);
}

.metric-sub {
  margin-top: 2px;
  max-width: 104px;
  font-size: 9px;
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 60%, var(--dc-screen, #04070f));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 来源标注：来源名 + 观测时间。悬停出完整信息（地址、观测时间、取数时间） */
.metric-source {
  margin-top: 2px;
  max-width: 100%;
  font-size: 9px;
  line-height: 1.3;
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 42%, var(--dc-screen, #04070f));
  cursor: help;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 实时交通读数：标签 + 大号等宽数字 + 拥堵徽标 + 时间（顶栏右侧，紧凑版） */
.traffic-status {
  display: flex;
  flex-wrap: nowrap;
  align-items: baseline;
  gap: 6px 8px;
  min-width: 0;
  padding: 4px 8px;
  background: var(
    --dc-panel-surface,
    color-mix(in srgb, var(--dc-screen, #04070f) 55%, transparent)
  );
  border: 1px solid color-mix(in srgb, var(--dc-accent, #1e40af) 28%, transparent);
  border-radius: 2px;
}

.traffic-label {
  font-size: 10px;
  letter-spacing: 0.14em;
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 72%, var(--dc-screen, #04070f));
  white-space: nowrap;
}

.traffic-value {
  font-family: Consolas, 'SF Mono', 'Roboto Mono', ui-monospace, monospace;
  font-size: 17px;
  font-weight: 600;
  line-height: 1;
  color: var(--dc-flow, #0e7490);
  text-shadow: 0 0 10px color-mix(in srgb, var(--dc-flow, #0e7490) 35%, transparent);
}

.traffic-badge {
  padding: 1px 6px;
  border: 1px solid currentColor;
  border-radius: 2px;
  font-size: 10px;
  letter-spacing: 0.06em;
  white-space: nowrap;
}

.traffic-badge.tone-ok {
  color: var(--dc-flow, #0e7490);
}

.traffic-badge.tone-warn {
  color: var(--dc-warning, #f59e0b);
}

.traffic-badge.tone-alert {
  color: var(--dc-alert, #f43f5e);
}

.traffic-clock {
  font-family: Consolas, 'SF Mono', ui-monospace, monospace;
  font-size: 10px;
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 55%, var(--dc-screen, #04070f));
  white-space: nowrap;
}

/* OSM 署名：ODbL 要求，不可删除（现在跟着控制按钮在底栏右侧） */
.attribution {
  margin-top: auto;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--dc-accent, #1e40af) 28%, transparent);
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 50%, var(--dc-panel, #0b1526));
  font-size: 11px;
  line-height: 1.4;
}
</style>
