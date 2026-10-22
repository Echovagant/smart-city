<script setup lang="ts">
import { computed } from 'vue'
import { formatEventTime } from '@/composables/useEventStream'
import type { CityEvent } from '../../../types/city'

/**
 * 实时事件流。
 *
 * 每一条事件都是后端从**真实指标派生**出来的（`/api/city/overview` 的 `events`）。
 * 本项目没有告警系统 —— 派生不出来就是**空数组**，所以空态要说清楚
 * 「检查了哪些条件、为什么没触发」（文案由 `emptyText` 传入）。
 *
 * 点一行 → 向上抛 `select` → 相机飞到事件位置（由 `SmartCity.vue` 执行）。
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

const emit = defineEmits<{
  /** 用户点了某一条事件。 */
  select: [event: CityEvent]
}>()

const isEmpty = computed(() => props.events.length === 0)

/** 严重度 → 徽标文案。 */
const LEVEL_LABELS: Record<CityEvent['level'], string> = {
  info: '提示',
  warn: '预警',
  alert: '告警',
}

/** 点一行：把事件抛给上层（上层负责飞相机）。 */
const onSelect = (event: CityEvent) => emit('select', event)
</script>

<template>
  <div class="dc-event-stream">
    <p v-if="isEmpty" class="dc-event-empty">{{ emptyText }}</p>
    <ul v-else class="dc-event-list">
      <li
        v-for="event in events"
        :key="event.id"
        class="dc-event-row"
        :class="`tone-${event.level}`"
      >
        <button
          type="button"
          class="dc-event-item"
          :title="event.detail || event.title"
          @click="onSelect(event)"
        >
          <span class="dc-event-dot" aria-hidden="true"></span>
          <span class="dc-event-title">{{ event.title }}</span>
          <span v-if="event.estimated" class="dc-event-estimate">（模型估算）</span>
          <span v-if="event.location" class="dc-event-place">{{ event.location.label }}</span>
          <span class="dc-event-badge">{{ LEVEL_LABELS[event.level] }}</span>
          <span v-if="formatEventTime(event.time)" class="dc-event-time">{{
            formatEventTime(event.time)
          }}</span>
        </button>
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

.dc-event-row {
  border-bottom: 1px solid rgba(22, 93, 255, 0.18);
}

.dc-event-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 4px 0;
  background: none;
  border: 0;
  font-family: inherit;
  font-size: var(--dc-label-size, 11px);
  color: rgba(226, 232, 240, 0.78);
  text-align: left;
  cursor: pointer;
}

.dc-event-item:hover {
  color: var(--dc-text, #e2e8f0);
}

.dc-event-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dc-accent, #165dff);
}

.tone-warn .dc-event-dot {
  background: var(--dc-warning, #f59e0b);
}

.tone-alert .dc-event-dot {
  background: var(--dc-alert, #f43f5e);
}

.dc-event-title {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 模型估算标记：与 S1 指标带的说法一致（模型估算必须标出来） */
.dc-event-estimate {
  flex: 0 0 auto;
  font-size: 9px;
  white-space: nowrap;
  color: var(--dc-warning, #f59e0b);
}

.dc-event-place {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 40%;
  color: rgba(226, 232, 240, 0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 严重度徽标：提示=强调蓝 / 预警=预警橙 / 告警=告警红 */
.dc-event-badge {
  flex: 0 0 auto;
  padding: 0 4px;
  border: 1px solid currentColor;
  border-radius: 2px;
  font-size: 9px;
  letter-spacing: 0.06em;
  color: var(--dc-accent, #165dff);
}

.tone-warn .dc-event-badge {
  color: var(--dc-warning, #f59e0b);
}

.tone-alert .dc-event-badge {
  color: var(--dc-alert, #f43f5e);
}

.dc-event-time {
  flex: 0 0 auto;
  font-family: Consolas, 'SF Mono', 'Roboto Mono', ui-monospace, monospace;
  color: rgba(226, 232, 240, 0.5);
}

/* 空态：诚实地说「没有事件」，不编一条出来 */
.dc-event-empty {
  margin: 0;
  font-size: var(--dc-label-size, 11px);
  line-height: 1.5;
  color: rgba(226, 232, 240, 0.42);
}
</style>
