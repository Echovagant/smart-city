<script setup lang="ts">
import { computed } from 'vue'
import { chartColor } from '@/theme/dashboard'
import type { DashboardBar } from '../../../types/city'

/**
 * 横向条形图（纯 SVG + HTML 条）。
 *
 * `value` 为 null → 该条画成**空槽**并标「暂无」——
 * 不拿 0 冒充，也不拿上一次的旧值冒充。
 */
const props = withDefaults(
  defineProps<{
    /** 条形。 */
    bars: DashboardBar[]
    /** 空态文案。 */
    emptyText?: string
  }>(),
  {
    emptyText: '暂无数据',
  },
)

const isEmpty = computed(() => props.bars.length === 0)

/** 刻度上限：取所有取得到的值里的最大值。 */
const scaleMax = computed(() => {
  const values = props.bars
    .map(bar => bar.value)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return values.length > 0 ? Math.max(...values) : 0
})

/** 每一段的宽度百分比（0–100）与显示文本。 */
const rows = computed(() =>
  props.bars.map((bar, index) => {
    const hasValue = typeof bar.value === 'number' && Number.isFinite(bar.value)
    const ratio = hasValue && scaleMax.value > 0 ? (bar.value as number) / scaleMax.value : 0
    const text = hasValue
      ? String(Math.round((bar.value as number) * 100) / 100)
      : '暂无'
    return {
      key: bar.key,
      label: bar.label,
      hasValue,
      color: chartColor(index),
      width: `${(ratio * 100).toFixed(2)}%`,
      display: bar.unit && hasValue ? `${text} ${bar.unit}` : text,
    }
  }),
)
</script>

<template>
  <div class="dc-bar-chart">
    <p v-if="isEmpty" class="dc-chart-empty">{{ emptyText }}</p>
    <ul v-else class="dc-bar-list">
      <li v-for="row in rows" :key="row.key" class="dc-bar-row">
        <span class="dc-bar-label">{{ row.label }}</span>
        <span class="dc-bar-track">
          <span
            class="dc-bar-fill"
            :class="{ 'is-empty': !row.hasValue }"
            :style="row.hasValue ? { width: row.width, background: row.color } : undefined"
          ></span>
        </span>
        <span class="dc-bar-value" :class="{ 'is-unavailable': !row.hasValue }">{{ row.display }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.dc-bar-chart {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.dc-bar-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.dc-bar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: calc(var(--dc-chart-bar-height, 14px) + var(--dc-chart-bar-gap, 8px));
}

.dc-bar-label {
  flex: 0 0 84px;
  font-size: var(--dc-label-size, 11px);
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 72%, var(--dc-panel, #0b1526));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dc-bar-track {
  flex: 1;
  min-width: 0;
  height: var(--dc-chart-bar-height, 14px);
  background: color-mix(in srgb, var(--dc-screen, #04070f) 60%, transparent);
  border: 1px solid color-mix(in srgb, var(--dc-accent, #1e40af) 22%, transparent);
  border-radius: var(--dc-panel-radius, 2px);
  overflow: hidden;
}

.dc-bar-fill {
  display: block;
  height: 100%;
  box-shadow: 0 0 10px color-mix(in srgb, var(--dc-flow, #0e7490) 30%, transparent);
}

/* 取不到的那一条：留一个空槽（不画长度），旁边标「暂无」 */
.dc-bar-fill.is-empty {
  width: 100%;
  background: repeating-linear-gradient(
    45deg,
    color-mix(in srgb, var(--dc-text, #cbd5e1) 6%, transparent),
    color-mix(in srgb, var(--dc-text, #cbd5e1) 6%, transparent) 4px,
    transparent 4px,
    transparent 8px
  );
  box-shadow: none;
}

.dc-bar-value {
  flex: 0 0 76px;
  text-align: right;
  font-family: Consolas, 'SF Mono', 'Roboto Mono', ui-monospace, monospace;
  font-size: var(--dc-label-size, 11px);
  color: var(--dc-flow, #0e7490);
}

.dc-bar-value.is-unavailable {
  font-family: inherit;
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 42%, var(--dc-panel, #0b1526));
}

.dc-chart-empty {
  margin: 0;
  font-size: var(--dc-label-size, 11px);
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 42%, var(--dc-panel, #0b1526));
}
</style>
