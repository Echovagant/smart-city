<script setup lang="ts">
import { computed } from 'vue'
import type { CityEvent } from '../../../types/city'

/**
 * 实时事件流。
 *
 * **本轮（S2）事件流只有空态**：本项目没有告警系统、没有摄像头，
 * 线框稿里的那些事件是占位符 —— 不许编出来。
 * S3 接上真实事件源之后，这里才会渲染事件条目。
 */
const props = withDefaults(
  defineProps<{
    /** 事件列表。空数组 → 空态。 */
    events: CityEvent[]
    /** 空态文案。 */
    emptyText?: string
  }>(),
  {
    emptyText: '暂无事件数据',
  },
)

const isEmpty = computed(() => props.events.length === 0)

/** 时间戳 → HH:MM:SS（本地时区）。解析不了就不显示。 */
const formatClock = (value?: string): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`
}
</script>

<template>
  <div class="dc-event-stream">
    <p v-if="isEmpty" class="dc-event-empty">{{ emptyText }}</p>
    <ul v-else class="dc-event-list">
      <li v-for="event in events" :key="event.id" class="dc-event-item" :class="`tone-${event.level}`">
        <span class="dc-event-dot" aria-hidden="true"></span>
        <span class="dc-event-title">{{ event.title }}</span>
        <span v-if="event.detail" class="dc-event-detail">{{ event.detail }}</span>
        <span v-if="formatClock(event.time)" class="dc-event-time">{{ formatClock(event.time) }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.dc-event-stream {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.dc-event-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.dc-event-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 0;
  border-bottom: 1px solid rgba(22, 93, 255, 0.18);
  font-size: var(--dc-label-size, 11px);
  color: rgba(226, 232, 240, 0.78);
}

.dc-event-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dc-flow, #22d3ee);
}

.tone-warn .dc-event-dot {
  background: var(--dc-warning, #f59e0b);
}

.tone-alert .dc-event-dot {
  background: var(--dc-alert, #f43f5e);
}

.dc-event-title {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dc-event-detail {
  color: rgba(226, 232, 240, 0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dc-event-time {
  font-family: Consolas, 'SF Mono', 'Roboto Mono', ui-monospace, monospace;
  color: rgba(226, 232, 240, 0.5);
}

/* 空态：诚实地说「没有事件」，不编一条出来 */
.dc-event-empty {
  margin: 0;
  font-size: var(--dc-label-size, 11px);
  color: rgba(226, 232, 240, 0.42);
}
</style>
