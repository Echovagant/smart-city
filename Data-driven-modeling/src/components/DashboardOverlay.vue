<script setup lang="ts">
import { computed, onMounted } from 'vue'
import BarChart from './dashboard/BarChart.vue'
import DonutChart from './dashboard/DonutChart.vue'
import EventStream from './dashboard/EventStream.vue'
import LineChart from './dashboard/LineChart.vue'
import MetricCard from './dashboard/MetricCard.vue'
import PanelCard from './dashboard/PanelCard.vue'
import TopBar from './dashboard/TopBar.vue'
import { useDashboardState } from '@/composables/useDashboardState'
import { resolveTabView } from '@/composables/useDashboardData'
import { applyDashboardVariables } from '@/theme/dashboard'
import type { CityEvent, CityOverview, DashboardTab } from '../../types/city'

/**
 * 16:9 大屏骨架：顶栏（标题 + 页签）/ 左列 / 中心 3D 场景 / 右列 / 底栏。
 *
 * **面板浮在场景之上**，不做左右分栏裁切（计划书 §1.2）：
 * Cesium 容器保持全屏，中间留空让 3D 场景透出来，
 * 所以一行 Cesium 逻辑都不用改。
 *
 * `pointer-events` 的规则：容器 `none`、面板 `auto` ——
 * 否则中心的 Cesium 交互（拖拽 / 滚轮）会被 overlay 整块吃掉。
 */
const props = withDefaults(
  defineProps<{
    /** 城市运行指标（`/api/city/overview` 的响应）。null = 还没取到。 */
    overview?: CityOverview | null
    /** 大屏标题。 */
    title?: string
    /**
     * 事件流。
     *
     * 本轮（S2）恒为空 —— 本项目没有告警系统，线框稿里的事件是占位符，
     * 编出来就是假数据。S3 接上真实事件源后才会有内容。
     */
    events?: CityEvent[]
  }>(),
  {
    overview: null,
    title: '智慧城市运行管理中心',
    events: () => [],
  },
)

const { tabs, activeTabKey, activeTab, setTab } = useDashboardState()

/** 当前页签的视图数据（纯函数算出来的）。 */
const view = computed(() => resolveTabView(activeTab.value, props.overview))

/** 切页签。 */
const onSelect = (tab: DashboardTab) => setTab(tab.key)

onMounted(() => {
  // 大屏的尺寸 token 写进 CSS 自定义属性（颜色由 dark.ts 的 applyThemeVariables 写）。
  applyDashboardVariables()
})
</script>

<template>
  <div class="dashboard-overlay">
    <div class="dashboard-grid">
      <!-- 顶栏：居中标题 + 页签 -->
      <div class="dashboard-area-top">
        <TopBar :title="title" :tabs="tabs" :active-key="activeTabKey" @select="onSelect" />
      </div>

      <!-- 左列：核心指标 + 24 小时趋势（控制面板由 SmartCity.vue 通过插槽塞进来） -->
      <div class="dashboard-area-left">
        <slot name="left" />
        <PanelCard title="核心指标" :badge="view.tab.label">
          <div class="dashboard-metric-grid">
            <MetricCard
              v-for="card in view.metrics"
              :key="card.key"
              :label="card.label"
              :value="card.value"
              :unit="card.unit"
              :badge="card.badge"
              :tone="card.tone"
              :source="card.source"
              :estimated="card.estimated"
              :unavailable="card.unavailable"
            />
          </div>
        </PanelCard>
        <PanelCard title="24 小时趋势" :badge="view.line.source?.name">
          <LineChart :points="view.line.points" :unit="view.line.unit" :empty-text="view.line.emptyText" />
        </PanelCard>
      </div>

      <!-- 中心：留空，3D 场景从后面透出来 -->
      <div class="dashboard-area-scene" aria-hidden="true"></div>

      <!-- 右列：分类分布 + 实时事件流 -->
      <div class="dashboard-area-right">
        <PanelCard title="分类分布" :badge="view.donut.source?.name">
          <DonutChart
            :slices="view.donut.slices"
            :center-label="view.donut.centerLabel"
            :center-value="view.donut.centerValue"
          />
        </PanelCard>
        <PanelCard title="实时事件流" badge="待接入">
          <EventStream :events="events" />
        </PanelCard>
      </div>

      <!-- 底栏：城市资源概览 -->
      <div class="dashboard-area-bottom">
        <PanelCard title="城市资源概览" :badge="view.barsSource?.name">
          <BarChart :bars="view.bars" />
        </PanelCard>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dashboard-overlay {
  position: absolute;
  inset: 0;
  z-index: 90;
  /* 容器不吃鼠标事件：中心的 Cesium 交互必须还能用 */
  pointer-events: none;
  overflow: hidden;
}

.dashboard-grid {
  display: grid;
  grid-template-areas:
    'top    top    top'
    'left   scene  right'
    'left   bottom right';
  grid-template-columns:
    minmax(220px, var(--dc-column-width, 340px))
    1fr
    minmax(220px, var(--dc-column-width, 340px));
  grid-template-rows: var(--dc-topbar-height, 96px) 1fr var(--dc-bottom-height, 150px);
  gap: var(--dc-panel-gap, 12px);
  padding: var(--dc-panel-gap, 12px);
  width: 100%;
  height: 100%;
}

.dashboard-area-top {
  grid-area: top;
  pointer-events: auto;
}

.dashboard-area-left {
  grid-area: left;
  display: flex;
  flex-direction: column;
  gap: var(--dc-panel-gap, 12px);
  min-height: 0;
  pointer-events: auto;
}

.dashboard-area-scene {
  grid-area: scene;
  /* 中心留空：3D 场景从后面透出来 */
  pointer-events: none;
}

.dashboard-area-right {
  grid-area: right;
  display: flex;
  flex-direction: column;
  gap: var(--dc-panel-gap, 12px);
  min-height: 0;
  pointer-events: auto;
}

.dashboard-area-bottom {
  grid-area: bottom;
  min-height: 0;
  pointer-events: auto;
}

.dashboard-metric-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

/* 窄屏降级：两列收窄、间距缩小、指标卡改成一列。
   不许出现横向滚动条 —— 整个 overlay 是 inset: 0 + overflow: hidden。 */
@media (max-width: 1280px) {
  .dashboard-grid {
    grid-template-columns:
      minmax(180px, 260px)
      1fr
      minmax(180px, 260px);
    gap: 8px;
    padding: 8px;
  }

  .dashboard-metric-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
