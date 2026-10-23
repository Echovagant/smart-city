<script setup lang="ts">
import { computed } from 'vue'
import { THEMES } from '@/theme/themes'
import type { ThemeDefinition, ThemeOverrides } from '@/theme/themes/types'
import { useTheme } from '@/composables/useTheme'

/**
 * 主题选择器：3 套默认主题 + 2 个取色器 + 2 个滑块 + 恢复默认。
 *
 * **只开放四项可编辑**（道路主色 / 建筑本体色 / 辉光强度 / 路面不透明度）：
 *
 * - 预警橙与告警红是**语义色**，跨主题恒定，不开放自选；
 * - 图表 6 档不开放逐档取色 —— 逐档乱调会让 6 档失去可区分性。
 *
 * 面板里的每一个颜色都**来自主题变量**（`--dc-*`）：
 * 需要透明度的地方一律用 `color-mix(in srgb, var(--dc-xxx) N%, transparent)`，
 * 这样换主题时边框、文字、底色会**跟着主题一起变**，
 * 组件里不写死任何色值。
 *
 * 状态全部来自 `useTheme()`（模块级单例）：面板自己不存主题状态，
 * 所以大屏与 3D 场景看到的一定是同一份。
 */
const { themeId, overrides, theme, setTheme, setOverride, resetOverrides } = useTheme()

/** 主题卡列表（顺序即展示顺序）。 */
const themeCards = computed<readonly ThemeDefinition[]>(() => THEMES)

/**
 * 色板预览要显示哪几档。
 *
 * 取主题自己的关键色（底 / 面板 / 强调 / 数据流 / 主干道）。
 * **刻意不含 warning / alert**：那两档是语义色，不是配色，
 * 放进预览里会让人以为「这套主题的告警色是红的」。
 */
const previewColors = (target: ThemeDefinition): string[] => [
  target.palette.screen,
  target.palette.panel,
  target.palette.accent,
  target.palette.flow,
  target.roadColors.main,
]

/** 当前生效的道路主色（含用户覆盖）。 */
const roadColor = computed(() => theme.value.roadColors.main)

/** 当前生效的建筑本体色（含用户覆盖）。 */
const buildingColor = computed(() => theme.value.palette.building)

/** 当前生效的道路辉光强度。 */
const glowPower = computed(() => theme.value.glow.roadPower)

/** 当前生效的路面不透明度。 */
const roadAlpha = computed(() => theme.value.glow.roadAlpha)

/** 这一项有没有被用户改过（改了才标「已改」）。 */
const isOverridden = (key: keyof ThemeOverrides): boolean => overrides.value[key] !== undefined

/** 改过的项数（用来决定「恢复默认」是不是有意义）。 */
const overrideCount = computed(() =>
  Object.values(overrides.value).filter(value => value !== undefined).length,
)

/** 取色器 / 滑块的值：一律走 `setOverride`，不直接改状态。 */
const readValue = (event: Event): string => (event.target as HTMLInputElement).value

/** 道路主色。 */
const onRoadColor = (event: Event): void => {
  setOverride('roadMain', readValue(event))
}

/** 建筑本体色。 */
const onBuildingColor = (event: Event): void => {
  setOverride('building', readValue(event))
}

/** 道路辉光强度（0 ~ 0.3）。 */
const onGlowPower = (event: Event): void => {
  setOverride('glowPower', Number(readValue(event)))
}

/** 路面不透明度（0.3 ~ 1）。 */
const onRoadAlpha = (event: Event): void => {
  setOverride('roadAlpha', Number(readValue(event)))
}
</script>

<template>
  <section class="dc-theme-picker" aria-label="主题选择">
    <header class="dc-theme-picker-head">
      <h2 class="dc-theme-picker-title">主题</h2>
      <span class="dc-theme-picker-current">{{ theme.label }}</span>
    </header>

    <!-- 主题卡：点击切换。当前主题有边框 + 「当前」标记，不只靠颜色区分 -->
    <div class="dc-theme-cards" role="group" aria-label="默认主题">
      <button
        v-for="card in themeCards"
        :key="card.id"
        type="button"
        class="dc-theme-card"
        :class="{ 'is-active': card.id === themeId }"
        :aria-pressed="card.id === themeId"
        @click="setTheme(card.id)"
      >
        <span class="dc-theme-card-head">
          <span class="dc-theme-card-label">{{ card.label }}</span>
          <span v-if="card.id === themeId" class="dc-theme-card-marker">当前</span>
        </span>
        <span class="dc-theme-card-desc">{{ card.description }}</span>
        <span class="dc-theme-swatches" aria-hidden="true">
          <span
            v-for="(color, index) in previewColors(card)"
            :key="index"
            class="dc-theme-swatch"
            :style="{ backgroundColor: color }"
            :data-color="color"
          ></span>
        </span>
      </button>
    </div>

    <!-- 自选：只有四项可改 -->
    <div class="dc-theme-fields">
      <label class="dc-theme-field">
        <span class="dc-theme-field-label">
          道路主色
          <span v-if="isOverridden('roadMain')" class="dc-theme-field-flag">已改</span>
        </span>
        <input
          type="color"
          class="dc-theme-color"
          :value="roadColor"
          aria-label="道路主色"
          @input="onRoadColor"
        />
        <span class="dc-theme-field-value">{{ roadColor }}</span>
      </label>

      <label class="dc-theme-field">
        <span class="dc-theme-field-label">
          建筑本体色
          <span v-if="isOverridden('building')" class="dc-theme-field-flag">已改</span>
        </span>
        <input
          type="color"
          class="dc-theme-color"
          :value="buildingColor"
          aria-label="建筑本体色"
          @input="onBuildingColor"
        />
        <span class="dc-theme-field-value">{{ buildingColor }}</span>
      </label>

      <label class="dc-theme-field">
        <span class="dc-theme-field-label">
          辉光强度
          <span v-if="isOverridden('glowPower')" class="dc-theme-field-flag">已改</span>
        </span>
        <input
          type="range"
          class="dc-theme-range"
          min="0"
          max="0.3"
          step="0.01"
          :value="glowPower"
          aria-label="辉光强度"
          @input="onGlowPower"
        />
        <span class="dc-theme-field-value">{{ glowPower.toFixed(2) }}</span>
      </label>

      <label class="dc-theme-field">
        <span class="dc-theme-field-label">
          路面不透明度
          <span v-if="isOverridden('roadAlpha')" class="dc-theme-field-flag">已改</span>
        </span>
        <input
          type="range"
          class="dc-theme-range"
          min="0.3"
          max="1"
          step="0.01"
          :value="roadAlpha"
          aria-label="路面不透明度"
          @input="onRoadAlpha"
        />
        <span class="dc-theme-field-value">{{ roadAlpha.toFixed(2) }}</span>
      </label>
    </div>

    <div class="dc-theme-actions">
      <span class="dc-theme-status">
        {{ overrideCount > 0 ? `已自定义 ${overrideCount} 项` : '当前使用主题原值' }}
      </span>
      <button type="button" class="dc-theme-reset" @click="resetOverrides">恢复默认</button>
    </div>

    <p class="dc-theme-note">预警橙与告警红是跨主题恒定的语义色，不在自选范围内。</p>
  </section>
</template>

<style scoped>
/* 主题面板：浮在控制面板上方（不占底栏高度，也不挡中心场景）。
   定位由外层容器负责（position: relative），这里只管自己的盒子。 */
.dc-theme-picker {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 320px;
  padding: var(--dc-panel-padding, 12px);
  /* 视口不够高时内部滚动：面板不许顶出屏幕 */
  max-height: calc(100vh - var(--dc-topbar-height, 96px) - 16px);
  overflow-y: auto;
  background: var(--dc-panel-bg, color-mix(in srgb, var(--dc-panel, #0b1526) 88%, transparent));
  border: var(--dc-panel-border-width, 1px) solid
    color-mix(in srgb, var(--dc-accent, #1e40af) 35%, transparent);
  border-radius: var(--dc-panel-radius, 2px);
  color: var(--dc-text, #cbd5e1);
  box-shadow: 0 0 18px color-mix(in srgb, var(--dc-accent, #1e40af) 12%, transparent);
  text-align: left;
}

.dc-theme-picker-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.dc-theme-picker-title {
  margin: 0;
  font-size: var(--dc-panel-title-size, 13px);
  font-weight: 600;
  letter-spacing: 0.16em;
  color: var(--dc-flow, #0e7490);
}

.dc-theme-picker-current {
  font-size: var(--dc-panel-small-size, 10px);
  letter-spacing: 0.08em;
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 60%, transparent);
}

/* 主题卡：整卡可点 */
.dc-theme-cards {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dc-theme-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 6px 8px;
  background: var(
    --dc-panel-surface,
    color-mix(in srgb, var(--dc-panel, #0b1526) 55%, transparent)
  );
  border: 1px solid color-mix(in srgb, var(--dc-accent, #1e40af) 32%, transparent);
  border-radius: var(--dc-panel-radius, 2px);
  font-family: inherit;
  color: var(--dc-text, #cbd5e1);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.dc-theme-card:hover {
  border-color: var(--dc-flow, #0e7490);
}

/* 选中态：边框 + 左侧标记条 + 「当前」文字 —— 不只靠颜色区分 */
.dc-theme-card.is-active {
  border-color: var(--dc-flow, #0e7490);
  box-shadow: inset 2px 0 0 var(--dc-flow, #0e7490);
}

.dc-theme-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
}

.dc-theme-card-label {
  font-size: var(--dc-label-size, 11px);
  font-weight: 600;
  letter-spacing: 0.08em;
}

.dc-theme-card-marker {
  padding: 0 5px;
  border: 1px solid currentColor;
  border-radius: var(--dc-panel-radius, 2px);
  font-size: var(--dc-panel-small-size, 10px);
  color: var(--dc-flow, #0e7490);
}

.dc-theme-card-desc {
  font-size: var(--dc-panel-small-size, 10px);
  line-height: 1.4;
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 55%, transparent);
}

/* 色板预览：颜色来自主题对象（内联样式），组件里不写死 */
.dc-theme-swatches {
  display: flex;
  gap: 3px;
  margin-top: 2px;
}

.dc-theme-swatch {
  width: 22px;
  height: 8px;
  border: 1px solid color-mix(in srgb, var(--dc-text, #cbd5e1) 16%, transparent);
  border-radius: 1px;
}

/* 自选项 */
.dc-theme-fields {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--dc-accent, #1e40af) 24%, transparent);
}

.dc-theme-field {
  display: grid;
  grid-template-columns: 84px 40px 1fr;
  align-items: center;
  gap: 6px;
  font-size: var(--dc-panel-small-size, 10px);
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 72%, transparent);
}

.dc-theme-field-label {
  display: flex;
  align-items: baseline;
  gap: 4px;
  letter-spacing: 0.08em;
  white-space: nowrap;
}

/* 「已改」标记：说明这一项偏离了主题原值 */
.dc-theme-field-flag {
  padding: 0 4px;
  border: 1px solid color-mix(in srgb, var(--dc-accent, #1e40af) 50%, transparent);
  border-radius: var(--dc-panel-radius, 2px);
  font-size: 9px;
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 60%, transparent);
}

.dc-theme-color {
  width: 40px;
  height: 18px;
  padding: 0;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--dc-accent, #1e40af) 40%, transparent);
  border-radius: var(--dc-panel-radius, 2px);
  cursor: pointer;
}

.dc-theme-range {
  width: 100%;
  min-width: 0;
  accent-color: var(--dc-flow, #0e7490);
  cursor: pointer;
}

.dc-theme-field-value {
  font-family: Consolas, 'SF Mono', ui-monospace, monospace;
  font-size: 10px;
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 55%, transparent);
  text-align: right;
}

/* 底部：状态 + 恢复默认 */
.dc-theme-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--dc-accent, #1e40af) 24%, transparent);
}

.dc-theme-status {
  font-size: var(--dc-panel-small-size, 10px);
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 50%, transparent);
}

.dc-theme-reset {
  padding: 2px 10px;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--dc-accent, #1e40af) 40%, transparent);
  border-radius: var(--dc-panel-radius, 2px);
  font-family: inherit;
  font-size: var(--dc-panel-small-size, 10px);
  letter-spacing: 0.08em;
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 72%, transparent);
  cursor: pointer;
  transition: border-color 0.2s ease, color 0.2s ease;
}

.dc-theme-reset:hover {
  border-color: var(--dc-flow, #0e7490);
  color: var(--dc-flow, #0e7490);
}

.dc-theme-note {
  margin: 0;
  font-size: 9px;
  line-height: 1.5;
  color: color-mix(in srgb, var(--dc-text, #cbd5e1) 42%, transparent);
}

/* 窄屏（1280 宽）：面板跟着右列一起收窄，不越到中间场景上 */
@media (max-width: 1280px) {
  .dc-theme-picker {
    width: 260px;
  }

  .dc-theme-field {
    grid-template-columns: 76px 36px 1fr;
  }
}
</style>
