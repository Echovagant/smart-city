<script setup lang="ts">
import { computed, ref } from 'vue'
import LineChart from './LineChart.vue'
import PanelCard from './PanelCard.vue'
import type { DashboardLine, SeriesPoint } from '../../../types/city'

/**
 * 趋势面板：**24 小时 / 日** 两个视图。
 *
 * - **24 小时视图**：后端的 `aqi_24h` 序列（逐小时 AQI）——
 *   回答「今天怎么样」。
 * - **日视图**：后端的 `aqi_daily` 序列（当天 AQI + 各项污染物的日均值）——
 *   回答「比昨天如何」「这几天趋势」。
 *
 * 折线一律用现成的 `LineChart.vue` 画 —— 它自己处理「v 为 null 就断线、
 * 没有数据就显示诚实的空态」这两件事，本组件**不改它**。
 *
 * 两条规矩
 * --------
 * 1. **本地时区，但不碰 `toLocaleTimeString`** —— 后者受运行环境的 ICU 数据影响，
 *    输出格式不保证一致（`useEventStream.ts` 已经这么做了，这里照它的写法：
 *    自己按 `getHours()` / `getMonth()` 拼）。
 * 2. **取不到就是空态** —— 逐日序列缺失时显示诚实的空态文案，
 *    不画一条假的平线，也不拿 24 小时的数据顶替。
 */

/** 视图切换项。 */
const VIEW_OPTIONS = [
  { key: 'hourly', label: '24 小时' },
  { key: 'daily', label: '日' },
] as const

/** 视图标识。 */
type TrendView = (typeof VIEW_OPTIONS)[number]['key']

const props = defineProps<{
  /** 趋势数据（`resolveTabView` 算出来的 `line`）。 */
  line: DashboardLine
}>()

/** 当前视图。 */
const activeView = ref<TrendView>('hourly')

/** 日视图里当前选中的指标。 */
const metricKey = ref('aqi')

/** 面板标题随视图走 —— 标题要说明现在看的是哪一段时间。 */
const title = computed(() => (activeView.value === 'daily' ? '逐日趋势' : '24 小时趋势'))

/** 当前视图的来源标注。 */
const source = computed(() =>
  activeView.value === 'daily'
    ? (props.line.dailySource ?? null)
    : (props.line.source ?? null),
)

/**
 * 一个点在某项指标上的取值。
 *
 * AQI 走 `v`（与逐小时序列同口径），污染物走 `values`。
 * 取不到就是 null —— 断线，不补 0（补 0 等于编一个不存在的读数）。
 */
const metricValue = (point: SeriesPoint, key: string): number | null => {
  if (key === 'aqi') {
    return typeof point.v === 'number' && Number.isFinite(point.v) ? point.v : null
  }
  const values = point.values
  if (!values) return null
  const raw = values[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

/** 日视图里选中指标的那条曲线。 */
const dailyPoints = computed<SeriesPoint[]>(() =>
  props.line.daily.map(point => ({ t: point.t, v: metricValue(point, metricKey.value) })),
)

/** 当前视图要画的点。 */
const points = computed<SeriesPoint[]>(() =>
  activeView.value === 'daily' ? dailyPoints.value : props.line.points,
)

/** 当前视图的单位。 */
const unit = computed(() => {
  if (activeView.value === 'hourly') return props.line.unit
  return props.line.dailyMetrics.find(item => item.key === metricKey.value)?.unit
})

/** 当前视图的空态文案。 */
const emptyText = computed(() =>
  activeView.value === 'daily'
    ? (props.line.dailyEmptyText ?? '暂无逐日 AQI 数据')
    : (props.line.emptyText ?? '暂无数据'),
)

/** 补零（时间与日期都要两位）。 */
const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * 时间戳 → 本地时间文本。
 *
 * `withTime` 为真时给到分钟（24 小时视图），否则只给到日（逐日视图）。
 * 自己按 `getMonth()` / `getDate()` / `getHours()` 拼 —— 不用 `toLocaleTimeString`。
 */
const formatLocal = (value: string, withTime: boolean): string | null => {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  const day = `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`
  return withTime ? `${day} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}` : day
}

/** 当前视图覆盖的时间范围（本地时区）。 */
const rangeText = computed(() => {
  const list = points.value
  if (list.length === 0) return ''
  const withTime = activeView.value === 'hourly'
  const first = formatLocal(list[0].t, withTime)
  const last = formatLocal(list[list.length - 1].t, withTime)
  if (!first || !last) return ''
  return `${first} → ${last}`
})
</script>

<template>
  <PanelCard :title="title" :badge="source?.name" class="dashboard-trend-panel">
    <div class="dc-trend">
      <div class="dc-trend-bar">
        <div class="dc-trend-views" role="group" aria-label="趋势时间范围">
          <button
            v-for="option in VIEW_OPTIONS"
            :key="option.key"
            type="button"
            class="dc-trend-view"
            :class="{ 'is-active': option.key === activeView }"
            :aria-pressed="option.key === activeView"
            @click="activeView = option.key"
          >
            {{ option.label }}
          </button>
        </div>
        <span v-if="rangeText" class="dc-trend-range">{{ rangeText }}（本地时间）</span>
      </div>

      <div class="dc-trend-chart">
        <LineChart :points="points" :unit="unit" :empty-text="emptyText" />
      </div>

      <div v-if="activeView === 'daily' && line.dailyMetrics.length > 0" class="dc-trend-metrics">
        <button
          v-for="metric in line.dailyMetrics"
          :key="metric.key"
          type="button"
          class="dc-trend-metric"
          :class="{ 'is-active': metric.key === metricKey }"
          :aria-pressed="metric.key === metricKey"
          @click="metricKey = metric.key"
        >
          {{ metric.label }}
        </button>
      </div>
    </div>
  </PanelCard>
</template>

<style scoped>
.dc-trend {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  min-height: 0;
}

/* 视图切换 + 时间范围：两头对齐，中间留空 */
.dc-trend-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: 0 0 auto;
}

.dc-trend-views {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

/* 切换按钮与顶栏页签同一套视觉语言（细边 + 青色选中态） */
.dc-trend-view {
  padding: 2px 10px;
  background: rgba(5, 10, 20, 0.72);
  border: 1px solid rgba(59, 130, 246, 0.4);
  border-radius: var(--dc-panel-radius, 2px);
  font-family: inherit;
  font-size: var(--dc-label-size, 11px);
  letter-spacing: 0.1em;
  color: rgba(226, 232, 240, 0.68);
  cursor: pointer;
  transition: border-color 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
}

.dc-trend-view:hover {
  border-color: var(--dc-flow, #22d3ee);
  color: var(--dc-flow, #22d3ee);
}

.dc-trend-view.is-active {
  border-color: var(--dc-flow, #22d3ee);
  color: var(--dc-flow, #22d3ee);
  box-shadow: 0 0 14px rgba(34, 211, 238, 0.28);
}

/* 时间范围：本地时区，说清楚是本地时间 */
.dc-trend-range {
  font-size: var(--dc-panel-small-size, 10px);
  color: rgba(226, 232, 240, 0.42);
  white-space: nowrap;
}

/* 折线吃掉剩余高度 */
.dc-trend-chart {
  flex: 1 1 auto;
  min-height: 0;
}

/* 指标切换（一行放不下就换行） */
.dc-trend-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  flex: 0 0 auto;
}

.dc-trend-metric {
  padding: 1px 6px;
  background: transparent;
  border: 1px solid rgba(59, 130, 246, 0.3);
  border-radius: var(--dc-panel-radius, 2px);
  font-family: inherit;
  font-size: var(--dc-panel-small-size, 10px);
  color: rgba(226, 232, 240, 0.55);
  cursor: pointer;
  transition: border-color 0.2s ease, color 0.2s ease;
}

.dc-trend-metric:hover {
  border-color: var(--dc-flow, #22d3ee);
  color: var(--dc-flow, #22d3ee);
}

.dc-trend-metric.is-active {
  border-color: var(--dc-flow, #22d3ee);
  color: var(--dc-flow, #22d3ee);
}
</style>
