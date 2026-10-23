<script setup lang="ts">
import { computed } from 'vue'
import { DASHBOARD_TOKENS, chartColor } from '@/theme/dashboard'
import type { DashboardSlice } from '../../../types/city'

/**
 * 环形图（纯 SVG，无图表库）。
 *
 * - 用 `stroke-dasharray` 画环：每一段的长度 = 该段占圆周的比例；
 * - `centerValue` 是**各段之和**（不是编出来的数）；
 * - 段位不够时按色序循环取色（见 `theme/dashboard.ts` 的 CHART_COLORS）。
 */
const props = withDefaults(
  defineProps<{
    /** 环形图的段。空数组 → 空态。 */
    slices: DashboardSlice[]
    /** 圆心的标签。 */
    centerLabel?: string
    /** 圆心的数值（各段之和）。 */
    centerValue?: number
    /** 空态文案。 */
    emptyText?: string
  }>(),
  {
    centerLabel: '',
    centerValue: 0,
    emptyText: '暂无分类数据',
  },
)

const SIZE = DASHBOARD_TOKENS.chart.donutSize
const STROKE = DASHBOARD_TOKENS.chart.donutStroke
const CENTER = SIZE / 2
const RADIUS = CENTER - STROKE / 2 - 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

const total = computed(() =>
  props.slices.reduce((sum, slice) => sum + (Number.isFinite(slice.value) ? slice.value : 0), 0),
)

const isEmpty = computed(() => props.slices.length === 0 || total.value <= 0)

/** 每一段的弧长与起始偏移。 */
const segments = computed(() => {
  let offset = 0
  return props.slices.map((slice, index) => {
    const ratio = total.value > 0 ? slice.value / total.value : 0
    const length = ratio * CIRCUMFERENCE
    const segment = {
      key: slice.key,
      label: slice.label,
      value: slice.value,
      color: chartColor(index),
      dasharray: `${length.toFixed(3)} ${(CIRCUMFERENCE - length).toFixed(3)}`,
      dashoffset: (-offset).toFixed(3),
    }
    offset += length
    return segment
  })
})

/** 图例：色块 + 名称 + 数值。 */
const legend = computed(() =>
  props.slices.map((slice, index) => ({
    key: slice.key,
    label: slice.label,
    value: slice.value,
    color: chartColor(index),
  })),
)
</script>

<template>
  <div class="dc-donut">
    <p v-if="isEmpty" class="dc-chart-empty">{{ emptyText }}</p>
    <template v-else>
      <svg
        class="dc-donut-svg"
        :viewBox="`0 0 ${SIZE} ${SIZE}`"
        role="img"
        aria-label="分类分布环形图"
      >
        <circle
          :cx="CENTER"
          :cy="CENTER"
          :r="RADIUS"
          fill="none"
          class="dc-donut-track"
          stroke="var(--dc-donut-track, #16375f)"
          :stroke-width="STROKE"
        />
        <circle
          v-for="segment in segments"
          :key="segment.key"
          :cx="CENTER"
          :cy="CENTER"
          :r="RADIUS"
          fill="none"
          :stroke="segment.color"
          :stroke-width="STROKE"
          :stroke-dasharray="segment.dasharray"
          :stroke-dashoffset="segment.dashoffset"
          :transform="`rotate(-90 ${CENTER} ${CENTER})`"
        />
        <text :x="CENTER" :y="CENTER - 2" class="dc-donut-value">{{ centerValue }}</text>
        <text :x="CENTER" :y="CENTER + 12" class="dc-donut-label">{{ centerLabel }}</text>
      </svg>
      <ul class="dc-donut-legend">
        <li v-for="item in legend" :key="item.key" class="dc-legend-item">
          <span class="dc-legend-dot" :style="{ background: item.color }"></span>
          <span class="dc-legend-label">{{ item.label }}</span>
          <span class="dc-legend-value">{{ item.value }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.dc-donut {
  display: flex;
  align-items: center;
  gap: 10px;
  /* 窄容器里图例换到环形下面（窄屏降级：列宽只有 260 px 时图例放不下） */
  flex-wrap: wrap;
  width: 100%;
  height: 100%;
}

.dc-donut-svg {
  flex: 0 0 auto;
  width: var(--dc-chart-donut-size, 150px);
  height: var(--dc-chart-donut-size, 150px);
}

.dc-donut-value {
  fill: var(--dc-flow, #0e7490);
  font-size: 15px;
  font-weight: 600;
  text-anchor: middle;
}

/* 环形轨道：底色描边。颜色放进 CSS 规则而不是 SVG 表现属性 ——
   表现属性里用 color-mix() 的支持度不如 CSS 属性稳。 */
.dc-donut-track {
  stroke: color-mix(in srgb, var(--dc-secondary, #24507f) 16%, transparent);
}

.dc-donut-label {
  fill: color-mix(in srgb, var(--dc-text, #cbd5e1) 55%, var(--dc-panel, #0b1526));
  font-size: 7px;
  text-anchor: middle;
}

.dc-donut-legend {
  flex: 1 1 120px;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.dc-legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  font-size: var(--dc-label-size, 11px);
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 78%, var(--dc-panel, #0b1526));
}

.dc-legend-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 1px;
}

.dc-legend-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dc-legend-value {
  flex: 0 0 auto;
  font-family: Consolas, 'SF Mono', 'Roboto Mono', ui-monospace, monospace;
  color: var(--dc-flow, #0e7490);
}

.dc-chart-empty {
  margin: 0;
  font-size: var(--dc-label-size, 11px);
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 42%, var(--dc-panel, #0b1526));
}
</style>
