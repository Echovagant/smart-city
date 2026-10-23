<script setup lang="ts">
import { computed } from 'vue'
import type { SourceInfo } from '../../../types/city'

/**
 * 指标卡：标签 / 数值 / 分级徽标 / 来源小字。
 *
 * 三条硬要求（与 SmartCity.vue 的指标带同口径）：
 * - `value` 为 null → 显示「**数据源暂不可用**」，不显示 0、不显示旧值；
 * - `estimated` → 显示「（模型估算）」；
 * - `source` → 小字（来源 · 观测时间），`title` 挂完整信息。
 */
const props = withDefaults(
  defineProps<{
    /** 指标名。 */
    label: string
    /** 数值；null 表示这个源没取到。 */
    value: number | string | null
    /** 单位（跟在数值后面）。 */
    unit?: string
    /** 分级徽标（例如空气质量的「良」）。 */
    badge?: string | null
    /** 色调。 */
    tone?: 'ok' | 'warn' | 'alert' | 'accent'
    /** 来源标注。 */
    source?: SourceInfo | null
    /** 这是模型估算吗。 */
    estimated?: boolean
    /** 这个源没取到吗。 */
    unavailable?: boolean
  }>(),
  {
    unit: undefined,
    badge: null,
    tone: 'accent',
    source: null,
    estimated: false,
    unavailable: false,
  },
)

/** 取不到就算 unavailable（不靠调用方记得传这个标志）。 */
const isUnavailable = computed(() => props.unavailable || props.value === null || props.value === undefined)

/** 显示用的数值文本。 */
const display = computed(() => {
  if (isUnavailable.value) return '数据源暂不可用'
  const value = props.value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '数据源暂不可用'
    // 最多两位小数：63.5 → "63.5"，51 → "51"
    return String(Math.round(value * 100) / 100)
  }
  return String(value)
})

/** 观测时间 → "MM-DD HH:MM:SS"（本地时区）。解析不了就说「观测时间未知」。 */
const observedText = computed(() => {
  const raw = props.source?.observed_at
  if (typeof raw !== 'string' || !raw.trim()) return '观测时间未知'
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return '观测时间未知'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(
    parsed.getMinutes(),
  )}:${pad(parsed.getSeconds())}`
})

/** 来源小字：来源名 · 观测时间（非实时时照实标）。 */
const sourceText = computed(() => {
  if (!props.source) return '数据源暂不可用'
  const stale = !isUnavailable.value && props.source.realtime === false
  return `${props.source.name} · ${observedText.value}${stale ? '（非实时）' : ''}`
})

/** 悬停提示：完整来源信息。 */
const sourceTitle = computed(() => {
  if (!props.source) return '数据源暂不可用'
  return [
    props.source.name,
    props.source.url,
    `观测时间：${props.source.observed_at ?? '未知'}`,
    `取数时间：${props.source.fetched_at}`,
    props.estimated ? '注意：这是模型估算，不是实测' : '',
  ]
    .filter(Boolean)
    .join('\n')
})
</script>

<template>
  <div class="dc-metric-card" :class="`tone-${tone}`">
    <div class="dc-metric-head">
      <span class="dc-metric-label">{{ label }}</span>
      <span v-if="estimated" class="dc-metric-estimate">（模型估算）</span>
    </div>
    <div class="dc-metric-body">
      <span class="dc-metric-value" :class="{ 'is-unavailable': isUnavailable }">{{ display }}</span>
      <span v-if="!isUnavailable && unit" class="dc-metric-unit">{{ unit }}</span>
      <span v-if="!isUnavailable && badge" class="dc-metric-badge">{{ badge }}</span>
    </div>
    <div class="dc-metric-source" :title="sourceTitle">{{ sourceText }}</div>
  </div>
</template>

<style scoped>
.dc-metric-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 6px 8px;
  background: var(
    --dc-panel-surface,
    color-mix(in srgb, var(--dc-screen, #04070f) 55%, transparent)
  );
  border: 1px solid color-mix(in srgb, var(--dc-accent, #1e40af) 24%, transparent);
  border-radius: var(--dc-panel-radius, 2px);
}

.dc-metric-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
}

.dc-metric-label {
  font-size: var(--dc-label-size, 11px);
  letter-spacing: 0.1em;
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 72%, var(--dc-screen, #04070f));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 模型估算标记：橙色（预警色），与「实测」区分开 */
.dc-metric-estimate {
  font-size: var(--dc-panel-small-size, 10px);
  white-space: nowrap;
  color: var(--dc-warning, #f59e0b);
}

.dc-metric-body {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
}

.dc-metric-value {
  font-family: Consolas, 'SF Mono', 'Roboto Mono', ui-monospace, monospace;
  font-size: var(--dc-value-size, 24px);
  font-weight: 600;
  line-height: 1.15;
  color: var(--dc-flow, #0e7490);
  text-shadow: 0 0 12px color-mix(in srgb, var(--dc-flow, #0e7490) 35%, transparent);
}

/* 取不到的值：不冒充 0，也不冒充旧值 —— 直说「数据源暂不可用」 */
.dc-metric-value.is-unavailable {
  font-family: inherit;
  font-size: var(--dc-label-size, 11px);
  font-weight: 400;
  line-height: 1.6;
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 45%, var(--dc-screen, #04070f));
  text-shadow: none;
}

.dc-metric-unit {
  font-size: var(--dc-label-size, 11px);
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 65%, var(--dc-screen, #04070f));
}

.dc-metric-badge {
  padding: 0 5px;
  border: 1px solid currentColor;
  border-radius: var(--dc-panel-radius, 2px);
  font-size: var(--dc-panel-small-size, 10px);
  letter-spacing: 0.06em;
  white-space: nowrap;
}

.tone-ok .dc-metric-badge {
  color: var(--dc-flow, #0e7490);
}

.tone-warn .dc-metric-badge {
  color: var(--dc-warning, #f59e0b);
}

.tone-alert .dc-metric-badge {
  color: var(--dc-alert, #f43f5e);
}

.tone-accent .dc-metric-badge {
  color: var(--dc-accent, #1e40af);
}

/* 来源标注：来源名 + 观测时间。悬停出完整信息 */
.dc-metric-source {
  font-size: var(--dc-panel-small-size, 10px);
  line-height: 1.3;
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 42%, var(--dc-screen, #04070f));
  cursor: help;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
