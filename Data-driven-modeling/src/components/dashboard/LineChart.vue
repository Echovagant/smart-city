<script setup lang="ts">
import { computed } from 'vue'
import { DARK_PALETTE } from '@/theme/dark'
import { DASHBOARD_TOKENS } from '@/theme/dashboard'
import type { SeriesPoint } from '../../../types/city'

/**
 * 折线图（纯 SVG，无图表库）。
 *
 * - `v` 为 null 的点**断线** —— 不补 0（补 0 等于编一个不存在的读数）；
 * - 空数据 → 诚实的空态文案，不画一条假的平线；
 * - 网格线 + 首末点的数值标注。
 */
const props = withDefaults(
  defineProps<{
    /** 数据点。`v` 为 null 表示那一刻没有值。 */
    points: SeriesPoint[]
    /** 单位（画在数值标注后面）。 */
    unit?: string
    /** 空态文案。 */
    emptyText?: string
  }>(),
  {
    unit: '',
    emptyText: '暂无数据',
  },
)

const W = DASHBOARD_TOKENS.chart.lineWidth
const H = DASHBOARD_TOKENS.chart.lineHeight
const PAD = { left: 30, right: W - 10, top: 12, bottom: H - 18 }

/** 有值的点。 */
const valid = computed(() =>
  props.points.filter(point => typeof point.v === 'number' && Number.isFinite(point.v)),
)

const isEmpty = computed(() => valid.value.length === 0)

/** 值的取值范围（留 5% 余量；只有一个值时上下各留 1）。 */
const range = computed(() => {
  const values = valid.value.map(point => point.v as number)
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return { min: min - 1, max: max + 1 }
  const pad = (max - min) * 0.05
  return { min: min - pad, max: max + pad }
})

const xAt = (index: number): number => {
  const count = props.points.length
  if (count <= 1) return (PAD.left + PAD.right) / 2
  return PAD.left + (index * (PAD.right - PAD.left)) / (count - 1)
}

const yAt = (value: number): number => {
  const { min, max } = range.value
  const span = max - min || 1
  return PAD.bottom - ((value - min) * (PAD.bottom - PAD.top)) / span
}

/** 连续的有值点 → 一段折线（null 处断开）。 */
const segments = computed(() => {
  const result: string[] = []
  let current: string[] = []
  props.points.forEach((point, index) => {
    const value = point.v
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      if (current.length > 1) result.push(current.join(' '))
      current = []
      return
    }
    current.push(`${xAt(index).toFixed(2)},${yAt(value).toFixed(2)}`)
  })
  if (current.length > 1) result.push(current.join(' '))
  return result
})

/** 有值的点（画圆点）。 */
const dots = computed(() =>
  props.points
    .map((point, index) => ({ point, index }))
    .filter(item => typeof item.point.v === 'number' && Number.isFinite(item.point.v))
    .map(item => ({
      x: xAt(item.index),
      y: yAt(item.point.v as number),
      value: item.point.v as number,
    })),
)

/** 网格线（4 条水平线 + 左侧刻度值）。 */
const gridLines = computed(() => {
  const steps = 4
  return Array.from({ length: steps + 1 }, (_, index) => {
    const ratio = index / steps
    const y = PAD.bottom - ratio * (PAD.bottom - PAD.top)
    const value = range.value.min + ratio * (range.value.max - range.value.min)
    return { y, label: String(Math.round(value * 10) / 10) }
  })
})

/** 数值标注的文本。 */
const formatValue = (value: number): string => {
  const text = String(Math.round(value * 100) / 100)
  return props.unit ? `${text} ${props.unit}` : text
}

/** 首末点的数值标注。 */
const annotations = computed(() => {
  const list = dots.value
  if (list.length === 0) return []
  const first = list[0]
  const last = list[list.length - 1]
  return [
    { x: first.x, y: first.y, text: formatValue(first.value), anchor: 'start' as const },
    { x: last.x, y: last.y, text: formatValue(last.value), anchor: 'end' as const },
  ]
})
</script>

<template>
  <div class="dc-line-chart">
    <p v-if="isEmpty" class="dc-chart-empty">{{ emptyText }}</p>
    <svg
      v-else
      class="dc-line-svg"
      :viewBox="`0 0 ${W} ${H}`"
      preserveAspectRatio="none"
      role="img"
      aria-label="趋势折线图"
    >
      <g class="dc-line-grid">
        <line
          v-for="line in gridLines"
          :key="`grid-${line.y}`"
          :x1="PAD.left"
          :x2="PAD.right"
          :y1="line.y"
          :y2="line.y"
        />
        <text v-for="line in gridLines" :key="`label-${line.y}`" :x="PAD.left - 4" :y="line.y + 3">
          {{ line.label }}
        </text>
      </g>
      <polyline
        v-for="(segment, index) in segments"
        :key="`segment-${index}`"
        :points="segment"
        fill="none"
        :stroke="DARK_PALETTE.flow"
        stroke-width="1.6"
        stroke-linejoin="round"
        stroke-linecap="round"
        vector-effect="non-scaling-stroke"
      />
      <circle
        v-for="(dot, index) in dots"
        :key="`dot-${index}`"
        :cx="dot.x"
        :cy="dot.y"
        r="2"
        :fill="DARK_PALETTE.flow"
        vector-effect="non-scaling-stroke"
      />
      <text
        v-for="(note, index) in annotations"
        :key="`note-${index}`"
        :x="note.x"
        :y="note.y - 5"
        :text-anchor="note.anchor"
        class="dc-line-note"
      >
        {{ note.text }}
      </text>
    </svg>
  </div>
</template>

<style scoped>
.dc-line-chart {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}

.dc-line-svg {
  width: 100%;
  height: 100%;
  overflow: visible;
}

.dc-line-grid line {
  stroke: rgba(59, 130, 246, 0.18);
  stroke-width: 0.6;
}

.dc-line-grid text {
  fill: rgba(226, 232, 240, 0.38);
  font-size: 7px;
  text-anchor: end;
}

.dc-line-note {
  fill: var(--dc-flow, #22d3ee);
  font-size: 8px;
}

/* 空态：诚实地说「没有数据」，不画一条假的平线 */
.dc-chart-empty {
  margin: 0;
  font-size: var(--dc-label-size, 11px);
  color: rgba(226, 232, 240, 0.42);
}
</style>
