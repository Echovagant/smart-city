<script setup lang="ts">
import type { DashboardTab } from '../../../types/city'

/**
 * 顶栏：居中标题 + 标题下方一行页签。
 *
 * 组件是「哑」的：当前页签由 `activeKey` 传进来，
 * 点击时通过 `@select` 把页签抛出去（状态在 `useDashboardState` 里）。
 */
defineProps<{
  /** 大屏标题。 */
  title: string
  /** 页签组。 */
  tabs: DashboardTab[]
  /** 当前页签的 key。 */
  activeKey?: string
}>()

const emit = defineEmits<{
  /** 选中某个页签。 */
  select: [tab: DashboardTab]
}>()
</script>

<template>
  <header class="dc-topbar">
    <h1 class="dc-topbar-title">{{ title }}</h1>
    <nav class="dc-tabs" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        role="tab"
        class="dc-tab"
        :class="{ 'is-active': tab.key === activeKey }"
        :aria-selected="tab.key === activeKey"
        @click="emit('select', tab)"
      >
        {{ tab.label }}
      </button>
    </nav>
    <!-- 右侧读数带插槽：S1 的指标带与实时交通读数都挂在这里 -->
    <div class="dc-topbar-extra">
      <slot name="extra" />
    </div>
  </header>
</template>

<style scoped>
.dc-topbar {
  position: relative;
  /* 两行三列：标题在中间列（视口居中），读数带在右列，页签独占第二行。
     读数带与页签**分属两行** —— 它们不再抢同一条水平线，
     所以窄屏（1600px 上下）也不会出现「读数带压住最后一个页签」的重叠。 */
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  grid-template-rows: auto auto;
  align-items: center;
  justify-items: center;
  gap: 6px 0;
  height: 100%;
  padding: 8px 12px;
  background: linear-gradient(
    180deg,
    rgba(13, 26, 46, 0.92) 0%,
    rgba(13, 26, 46, 0.55) 70%,
    rgba(13, 26, 46, 0) 100%
  );
  border-bottom: 1px solid rgba(22, 93, 255, 0.45);
}

.dc-topbar-title {
  grid-area: 1 / 2 / 2 / 3;
  margin: 0;
  font-size: var(--dc-title-size, 20px);
  font-weight: 600;
  letter-spacing: 0.24em;
  text-indent: 0.24em;
  color: var(--dc-text, #e2e8f0);
  text-shadow: 0 0 18px rgba(34, 211, 238, 0.45);
  white-space: nowrap;
}

.dc-tabs {
  /* 页签行通栏居中：它与读数带不在同一行，横向互不影响。 */
  grid-area: 2 / 1 / 3 / 4;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: center;
  min-width: 0;
}

.dc-tab {
  padding: 3px 14px;
  background: rgba(5, 10, 20, 0.72);
  border: 1px solid rgba(59, 130, 246, 0.4);
  border-radius: var(--dc-panel-radius, 2px);
  font-family: inherit;
  font-size: var(--dc-label-size, 11px);
  letter-spacing: 0.14em;
  color: rgba(226, 232, 240, 0.68);
  cursor: pointer;
  transition: border-color 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
}

.dc-tab:hover {
  border-color: var(--dc-flow, #22d3ee);
  color: var(--dc-flow, #22d3ee);
}

.dc-tab.is-active {
  border-color: var(--dc-flow, #22d3ee);
  color: var(--dc-flow, #22d3ee);
  box-shadow: 0 0 14px rgba(34, 211, 238, 0.28);
}

/* 右侧读数带：S1 的指标带 + 实时交通读数。
   与标题**同一行**（页签在第二行），靠右对齐。
   宽度要克制 —— 读数带一旦压到标题上，大屏就废了。
   `min-width: 0` 让它能在窄屏里收缩（内部格子会截断，不换行）。 */
.dc-topbar-extra {
  grid-area: 1 / 3 / 2 / 4;
  justify-self: end;
  align-self: center;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}

/* 窄屏：读数带压缩 —— 来源小字收窄（完整内容在 title 属性里），
   但**不隐藏数值**：隐藏 = 大屏上少了一组读数。 */
@media (max-width: 1500px) {
  .dc-topbar-extra {
    max-width: 100%;
  }
}
</style>
