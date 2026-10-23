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
  background: var(--dc-panel-bg, color-mix(in srgb, var(--dc-panel, #0b1526) 82%, transparent));
  border: var(--dc-panel-border-width, 1px) solid
    color-mix(in srgb, var(--dc-accent, #1e40af) 35%, transparent);
  border-radius: var(--dc-panel-radius, 2px);
  color: var(--dc-text, #cbd5e1);
  box-shadow: 0 0 18px color-mix(in srgb, var(--dc-accent, #1e40af) 12%, transparent);
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
  color: var(--dc-flow, #0e7490);
  white-space: nowrap;
}

.dc-panel-badge {
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--dc-flow, #0e7490) 50%, transparent);
  border-radius: var(--dc-panel-radius, 2px);
  font-size: var(--dc-panel-small-size, 10px);
  letter-spacing: 0.08em;
  color: color-mix(in srgb, var(--dc-flow, #0e7490) 85%, var(--dc-panel, #0b1526));
  white-space: nowrap;
}

/* 标题后面的一条细线：把标题和内容分开，不靠背景色块 */
.dc-panel-rule {
  flex: 1;
  height: 1px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--dc-accent, #1e40af) 55%, transparent),
    transparent
  );
}

.dc-panel-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
