<script setup lang="ts">
/**
 * 通用面板卡：标题 + 可选角标 + 默认插槽。
 *
 * 大屏上的每一块（核心指标 / 趋势 / 分类分布 / 事件流 / 资源概览）都是它。
 */
defineProps<{
  /** 面板标题。 */
  title: string
  /** 右上角角标（可选，例如「实测」「模型估算」）。 */
  badge?: string
}>()
</script>

<template>
  <section class="dc-panel">
    <header class="dc-panel-head">
      <h2 class="dc-panel-title">{{ title }}</h2>
      <span v-if="badge" class="dc-panel-badge">{{ badge }}</span>
      <span class="dc-panel-rule" aria-hidden="true"></span>
    </header>
    <div class="dc-panel-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.dc-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: var(--dc-panel-padding, 12px);
  background: var(--dc-panel-bg, rgba(13, 26, 46, 0.82));
  border: var(--dc-panel-border-width, 1px) solid rgba(22, 93, 255, 0.35);
  border-radius: var(--dc-panel-radius, 2px);
  color: var(--dc-text, #e2e8f0);
  box-shadow: 0 0 18px rgba(22, 93, 255, 0.12);
}

.dc-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.dc-panel-title {
  margin: 0;
  font-size: var(--dc-panel-title-size, 13px);
  font-weight: 600;
  letter-spacing: 0.16em;
  color: var(--dc-flow, #22d3ee);
  white-space: nowrap;
}

.dc-panel-badge {
  padding: 1px 6px;
  border: 1px solid rgba(34, 211, 238, 0.5);
  border-radius: var(--dc-panel-radius, 2px);
  font-size: var(--dc-panel-small-size, 10px);
  letter-spacing: 0.08em;
  color: rgba(34, 211, 238, 0.85);
  white-space: nowrap;
}

/* 标题后面的一条细线：把标题和内容分开，不靠背景色块 */
.dc-panel-rule {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, rgba(22, 93, 255, 0.55), rgba(22, 93, 255, 0));
}

.dc-panel-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
