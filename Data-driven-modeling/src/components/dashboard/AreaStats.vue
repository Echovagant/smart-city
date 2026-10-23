<script setup lang="ts">
import { computed } from 'vue'
import PanelCard from './PanelCard.vue'
import { AREA_RADIUS_OPTIONS } from '@/composables/useAreaQuery'
import type { AreaStats, LngLat } from '../../../types/city'

/**
 * 区域统计面板：一片范围内的建筑数 / 路网长度 / 设施分类 / 密度。
 *
 * 数据来自后端 `GET /api/city/area`（`/api/city/area` 的每个数字都带 `source`）。
 * **三条硬规矩，与项目其它面板同口径**：
 *
 * 1. **取不到就写「数据源暂不可用」**，不显示 0、不显示上一次的旧值；
 * 2. **模型估算必须标出来**（这个端点的数据是本地 OSM 快照实测，`estimated = false`）；
 * 3. **每个数字都要能追到来源**（面板底部那行来源小字）。
 *
 * 面板本身**只渲染**：取数、点选、半径切换都由 `useAreaQuery` 负责，
 * 这里通过 props 收状态、通过 emits 把用户的动作抛回去。
 */

/** 道路分级 → 中文名。与后端 `city_data/sources/road_network.py` 的 ROAD_TIERS 同口径。 */
const ROAD_TIER_LABELS: Record<string, string> = {
  main: '主干道',
  secondary: '次干道',
  local: '支路',
  footway: '人行道/步行区',
  other: '其他道路',
}

/** 道路分级的显示顺序（与后端一致）。 */
const ROAD_TIER_ORDER = ['main', 'secondary', 'local', 'footway', 'other']

/** 设施分类的兜底名（后端给了分类名时一律用后端的）。 */
const FACILITY_FALLBACK_LABELS: Record<string, string> = {
  medical: '医疗设施',
  public_safety: '公共安全设施',
  education: '教育设施',
  heritage: '历史建筑',
  commerce: '商业与办公',
}

const props = withDefaults(
  defineProps<{
    /** 最近一次取到的统计；null = 还没选区域，或取失败。 */
    stats?: AreaStats | null
    /** 当前选中的中心点；null = 还没选区域。 */
    center?: LngLat | null
    /** 当前半径（米）。 */
    radiusM?: number
    /** 正在取数。 */
    loading?: boolean
    /** 错误文案（人话）；null = 没有错误。 */
    error?: string | null
    /** 错误的原始信息（悬停提示用）。 */
    errorDetail?: string | null
    /** 一次性提示（例如「刚才点到了天空」）。 */
    hint?: string | null
    /** 空态文案。 */
    emptyText?: string
    /**
     * 场景底座在不在（能不能拾取）。
     *
     * 底座没接上时，空态说的是「场景底座未就绪，无法拾取」，
     * **不是**「在场景里点一下地面」—— 后者会让人以为功能是好的。
     */
    sceneReady?: boolean
  }>(),
  {
    stats: null,
    center: null,
    radiusM: 300,
    loading: false,
    error: null,
    errorDetail: null,
    hint: null,
    emptyText: '在场景里点一下地面，查看该范围的统计',
    sceneReady: true,
  },
)

const emit = defineEmits<{
  /** 用户换了半径。 */
  'update:radius': [meters: number]
  /** 用户要清掉当前选区。 */
  clear: []
}>()

/** 数字 → 文本。取不到（null / 非有限数）返回 null。 */
const formatNumber = (value: unknown, digits = 0): string | null => {
  if (value === null || value === undefined || typeof value === 'boolean') return null
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  if (digits <= 0) return String(Math.round(number))
  return number.toFixed(digits)
}

/** 选中了没有。 */
const hasSelection = computed(() => props.center !== null)

/** 面板标题旁的角标：取到了就说来源，没取到就提示怎么用。 */
const badge = computed(() => (props.stats ? props.stats.source?.name : '点选地面'))

/** 四个头条数字。取不到的那一项是 null（界面显示「数据源暂不可用」，不显示 0）。 */
const headline = computed(() => {
  const stats = props.stats
  return [
    { key: 'area', label: '范围面积', value: formatNumber(stats?.area_km2, 4), unit: 'km²' },
    { key: 'building', label: '建筑数', value: formatNumber(stats?.building_count), unit: '栋' },
    { key: 'road', label: '路网总长', value: formatNumber(stats?.road_length_km, 2), unit: 'km' },
    {
      key: 'density',
      label: '建筑密度',
      value: formatNumber(stats?.building_density_per_km2, 2),
      unit: '栋/km²',
    },
  ]
})

/** 道路分级分解（按后端的顺序；分级之和 = 路网总长）。 */
const roadTiers = computed(() => {
  const breakdown = props.stats?.road_length_by_tier_km
  if (!breakdown) return []
  const keys = ROAD_TIER_ORDER.filter(key => key in breakdown)
  const extra = Object.keys(breakdown).filter(key => !ROAD_TIER_ORDER.includes(key))
  return [...keys, ...extra].map(key => ({
    key,
    label: ROAD_TIER_LABELS[key] ?? key,
    value: formatNumber(breakdown[key], 2),
  }))
})

/** 设施分类计数（分类名优先用后端给的）。 */
const facilities = computed(() => {
  const categories = props.stats?.facility_categories
  const list = Array.isArray(categories) ? categories : []
  if (list.length > 0) {
    return list.map(category => ({
      key: category.key,
      label: category.label || FACILITY_FALLBACK_LABELS[category.key] || category.key,
      value: formatNumber(category.count),
    }))
  }
  const counts = props.stats?.facility_counts ?? {}
  return Object.keys(counts).map(key => ({
    key,
    label: FACILITY_FALLBACK_LABELS[key] ?? key,
    value: formatNumber(counts[key]),
  }))
})

/**
 * 选中范围：中心点 + 半径（让人知道自己选的是哪一片）。
 *
 * 这一行只出现在**有选区**时（`hasSelection` 为真），所以中心点一定在。
 */
const selectionText = computed(() => {
  const center = props.center!
  return `${center.lng.toFixed(6)}, ${center.lat.toFixed(6)} · 半径 ${props.radiusM} m`
})

/** 来源小字：来源名 · 观测时间（非实时时照实标）。 */
const sourceText = computed(() => {
  const source = props.stats?.source
  if (!source) return '数据源暂不可用'
  const observed = typeof source.observed_at === 'string' ? source.observed_at : '观测时间未知'
  const stale = source.realtime === false ? '（非实时）' : ''
  return `${source.name} · ${observed}${stale}`
})

/** 悬停提示：完整来源信息。 */
const sourceTitle = computed(() => {
  const source = props.stats?.source
  if (!source) return '数据源暂不可用'
  return [
    source.name,
    source.url,
    `观测时间：${source.observed_at ?? '未知'}`,
    `取数时间：${source.fetched_at}`,
    source.estimated === true ? '注意：这是模型估算，不是实测' : '',
  ]
    .filter(Boolean)
    .join('\n')
})

/** 切半径。 */
const onRadius = (meters: number): void => emit('update:radius', meters)
</script>

<template>
  <PanelCard title="区域统计" :badge="badge" class="dashboard-area-panel">
    <div class="dc-area">
      <!-- 半径档位：始终可见，用户随时能改下一次查询的范围 -->
      <div class="dc-area-radius" role="group" aria-label="查询半径">
        <span class="dc-area-radius-label">半径</span>
        <button
          v-for="option in AREA_RADIUS_OPTIONS"
          :key="option"
          type="button"
          class="dc-area-radius-option"
          :class="{ 'is-active': option === radiusM }"
          :aria-pressed="option === radiusM"
          @click="onRadius(option)"
        >
          {{ option }} m
        </button>
      </div>

      <!-- 还没选区域：说清楚怎么用 -->
      <div v-if="!hasSelection" class="dc-area-empty">
        <p class="dc-area-empty-text" :class="{ 'is-not-ready': !sceneReady }">
          {{ emptyText }}
        </p>
        <p v-if="hint" class="dc-area-hint">{{ hint }}</p>
        <p v-if="sceneReady" class="dc-area-empty-sub">当前半径 {{ radiusM }} m（可在上面切换）</p>
      </div>

      <!-- 取数失败：直说取不到，不显示 0 -->
      <div v-else-if="error" class="dc-area-error" :title="errorDetail ?? undefined">
        {{ error }}
      </div>

      <!-- 正在取数 -->
      <div v-else-if="loading" class="dc-area-loading">正在统计该范围…</div>

      <!-- 有结果 -->
      <div v-else-if="stats" class="dc-area-body">
        <div class="dc-area-grid">
          <div v-for="item in headline" :key="item.key" class="dc-area-stat">
            <span class="dc-area-stat-label">{{ item.label }}</span>
            <span class="dc-area-stat-body">
              <span
                class="dc-area-stat-value"
                :class="{ 'is-unavailable': item.value === null }"
              >{{ item.value ?? '数据源暂不可用' }}</span>
              <span v-if="item.value !== null" class="dc-area-stat-unit">{{ item.unit }}</span>
            </span>
          </div>
        </div>

        <div v-if="roadTiers.length" class="dc-area-line">
          <span class="dc-area-line-label">道路分级</span>
          <span class="dc-area-line-value">
            <span v-for="tier in roadTiers" :key="tier.key" class="dc-area-chip">
              {{ tier.label }} {{ tier.value ?? '—' }}
            </span>
          </span>
        </div>

        <div v-if="facilities.length" class="dc-area-line">
          <span class="dc-area-line-label">设施分类</span>
          <span class="dc-area-line-value">
            <span v-for="facility in facilities" :key="facility.key" class="dc-area-chip">
              {{ facility.label }} {{ facility.value ?? '—' }}
            </span>
          </span>
        </div>

        <div class="dc-area-line">
          <span class="dc-area-line-label">选中范围</span>
          <span class="dc-area-line-value dc-area-selection">{{ selectionText }}</span>
        </div>

        <div class="dc-area-source" :title="sourceTitle">{{ sourceText }}</div>
      </div>

      <div v-if="hasSelection" class="dc-area-actions">
        <button type="button" class="dc-area-clear" @click="emit('clear')">清除选区（Esc）</button>
      </div>
    </div>
  </PanelCard>
</template>

<style scoped>
.dc-area {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  min-height: 0;
}

/* 半径档位：与趋势面板的视图切换同一套视觉语言 */
.dc-area-radius {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.dc-area-radius-label {
  font-size: var(--dc-label-size, 11px);
  letter-spacing: 0.1em;
  color: rgba(226, 232, 240, 0.55);
}

.dc-area-radius-option {
  padding: 1px 8px;
  background: rgba(5, 10, 20, 0.72);
  border: 1px solid rgba(59, 130, 246, 0.4);
  border-radius: var(--dc-panel-radius, 2px);
  font-family: inherit;
  font-size: var(--dc-label-size, 11px);
  letter-spacing: 0.06em;
  color: rgba(226, 232, 240, 0.68);
  cursor: pointer;
  transition: border-color 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
}

.dc-area-radius-option:hover {
  border-color: var(--dc-flow, #22d3ee);
  color: var(--dc-flow, #22d3ee);
}

.dc-area-radius-option.is-active {
  border-color: var(--dc-flow, #22d3ee);
  color: var(--dc-flow, #22d3ee);
  box-shadow: 0 0 14px rgba(34, 211, 238, 0.28);
}

/* 空态：说清楚怎么用 */
.dc-area-empty {
  padding: 8px 2px;
}

.dc-area-empty-text,
.dc-area-empty-sub,
.dc-area-hint {
  margin: 0 0 4px;
  font-size: var(--dc-label-size, 11px);
  line-height: 1.6;
  color: rgba(226, 232, 240, 0.6);
}

.dc-area-hint {
  color: var(--dc-warning, #f59e0b);
}

/* 底座没接上：直说不能拾取（别让人以为「点了也没反应」） */
.dc-area-empty-text.is-not-ready {
  color: var(--dc-warning, #f59e0b);
}

.dc-area-empty-sub {
  color: rgba(226, 232, 240, 0.38);
}

.dc-area-error {
  padding: 8px 2px;
  font-size: var(--dc-label-size, 11px);
  line-height: 1.6;
  color: var(--dc-alert, #f43f5e);
  cursor: help;
}

.dc-area-loading {
  padding: 8px 2px;
  font-size: var(--dc-label-size, 11px);
  color: rgba(226, 232, 240, 0.5);
}

/* 四个头条数字：2 × 2 */
.dc-area-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.dc-area-stat {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  padding: 5px 7px;
  background: var(--dc-panel-surface, rgba(5, 10, 20, 0.55));
  border: 1px solid rgba(22, 93, 255, 0.24);
  border-radius: var(--dc-panel-radius, 2px);
}

.dc-area-stat-label {
  font-size: var(--dc-panel-small-size, 10px);
  letter-spacing: 0.1em;
  color: rgba(226, 232, 240, 0.6);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dc-area-stat-body {
  display: flex;
  align-items: baseline;
  gap: 3px;
  min-width: 0;
}

.dc-area-stat-value {
  font-family: Consolas, 'SF Mono', 'Roboto Mono', ui-monospace, monospace;
  font-size: 18px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--dc-flow, #22d3ee);
  text-shadow: 0 0 12px rgba(34, 211, 238, 0.35);
}

/* 取不到的值：不冒充 0 */
.dc-area-stat-value.is-unavailable {
  font-family: inherit;
  font-size: var(--dc-panel-small-size, 10px);
  font-weight: 400;
  color: rgba(226, 232, 240, 0.45);
  text-shadow: none;
}

.dc-area-stat-unit {
  font-size: var(--dc-panel-small-size, 10px);
  color: rgba(226, 232, 240, 0.6);
}

/* 分解行：道路分级 / 设施分类 / 选中范围 */
.dc-area-line {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.dc-area-line-label {
  flex: 0 0 auto;
  font-size: var(--dc-panel-small-size, 10px);
  letter-spacing: 0.1em;
  color: rgba(226, 232, 240, 0.5);
}

.dc-area-line-value {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
  font-size: var(--dc-panel-small-size, 10px);
  color: rgba(226, 232, 240, 0.72);
}

.dc-area-chip {
  padding: 0 5px;
  border: 1px solid rgba(59, 130, 246, 0.28);
  border-radius: var(--dc-panel-radius, 2px);
  white-space: nowrap;
}

.dc-area-selection {
  font-family: Consolas, 'SF Mono', 'Roboto Mono', ui-monospace, monospace;
}

.dc-area-source {
  font-size: var(--dc-panel-small-size, 10px);
  line-height: 1.3;
  color: rgba(226, 232, 240, 0.42);
  cursor: help;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dc-area-actions {
  display: flex;
  justify-content: flex-end;
  flex: 0 0 auto;
}

.dc-area-clear {
  padding: 1px 8px;
  background: transparent;
  border: 1px solid rgba(59, 130, 246, 0.3);
  border-radius: var(--dc-panel-radius, 2px);
  font-family: inherit;
  font-size: var(--dc-panel-small-size, 10px);
  color: rgba(226, 232, 240, 0.55);
  cursor: pointer;
  transition: border-color 0.2s ease, color 0.2s ease;
}

.dc-area-clear:hover {
  border-color: var(--dc-flow, #22d3ee);
  color: var(--dc-flow, #22d3ee);
}
</style>
