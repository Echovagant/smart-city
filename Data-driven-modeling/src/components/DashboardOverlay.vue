<script setup lang="ts">
import { computed, onMounted } from 'vue'
import BarChart from './dashboard/BarChart.vue'
import DonutChart from './dashboard/DonutChart.vue'
import EventStream from './dashboard/EventStream.vue'
import MetricCard from './dashboard/MetricCard.vue'
import PanelCard from './dashboard/PanelCard.vue'
import TopBar from './dashboard/TopBar.vue'
import TrendPanel from './dashboard/TrendPanel.vue'
import { useDashboardState } from '@/composables/useDashboardState'
import { resolveTabView } from '@/composables/useDashboardData'
import { explainEmptyEvents } from '@/composables/useEventStream'
import { resolveSceneLinkage } from '@/composables/useSceneLinkage'
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
     * **全部是从真实指标派生出来的**（后端 `city_data/events.py`）：
     * 派生不出来就是空数组 —— 空事件流是数据现实，不是故障。
     */
    events?: CityEvent[]
  }>(),
  {
    overview: null,
    title: '智慧城市运行管理中心',
    events: () => [],
  },
)

const emit = defineEmits<{
  /** 用户点了事件流里的一条事件。 */
  'select-event': [event: CityEvent]
}>()

const { tabs, activeTabKey, activeTab, setTab } = useDashboardState()

/** 当前页签的视图数据（纯函数算出来的）。 */
const view = computed(() => resolveTabView(activeTab.value, props.overview))

/**
 * 事件流为空时的文案。
 *
 * 说清楚「检查了哪些条件、为什么没触发」——
 * 这比编三条假事件有信息量得多。
 */
const eventEmptyText = computed(() =>
  props.overview ? explainEmptyEvents(props.overview) : '暂无事件数据',
)

/** 当前页签的联动说明（有的页签没有空间定位，就直说）。 */
const linkageNote = computed(() => resolveSceneLinkage(activeTab.value.key).note)

/** 事件流角标：有几条 / 没有。 */
const eventBadge = computed(() => (props.events.length > 0 ? `${props.events.length} 条` : '派生'))

/** 切页签。 */
const onSelect = (tab: DashboardTab) => setTab(tab.key)

/** 点了事件：抛给上层（上层负责把相机飞过去）。 */
const onSelectEvent = (event: CityEvent) => emit('select-event', event)

onMounted(() => {
  // 大屏的尺寸 token 写进 CSS 自定义属性（颜色由 dark.ts 的 applyThemeVariables 写）。
  applyDashboardVariables()
})
</script>

<template>
  <div class="dashboard-overlay">
    <div class="dashboard-grid">
      <!-- 顶栏：居中标题 + 页签；右侧是读数带插槽（S1 指标带 + 实时交通） -->
      <div class="dashboard-area-top">
        <TopBar :title="title" :tabs="tabs" :active-key="activeTabKey" @select="onSelect">
          <template #extra>
            <slot name="top-extra" />
          </template>
        </TopBar>
      </div>

      <!-- 左列：核心指标 + 趋势面板（24 小时 / 日两个视图） -->
      <div class="dashboard-area-left">
        <PanelCard title="核心指标" :badge="view.tab.label" class="dashboard-metrics-panel">
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
        <TrendPanel :line="view.line" />
      </div>

      <!-- 中心：留空，3D 场景从后面透出来 -->
      <div class="dashboard-area-scene" aria-hidden="true"></div>

      <!-- 右列：分类分布 + 实时事件流 -->
      <div class="dashboard-area-right">
        <PanelCard
          title="分类分布"
          :badge="view.donut.source?.name"
          class="dashboard-distribution-panel"
        >
          <DonutChart
            :slices="view.donut.slices"
            :center-label="view.donut.centerLabel"
            :center-value="view.donut.centerValue"
          />
        </PanelCard>
        <PanelCard title="实时事件流" :badge="eventBadge" class="dashboard-events-panel">
          <p v-if="linkageNote" class="dc-event-note">{{ linkageNote }}</p>
          <EventStream :events="events" :empty-text="eventEmptyText" @select="onSelectEvent" />
        </PanelCard>
      </div>

      <!-- 底栏：**通栏**（风格板线框的 1280 全宽横条）。
           左侧条形图，右侧控制按钮 + OSM 署名。 -->
      <div class="dashboard-area-bottom">
        <PanelCard
          title="城市资源概览"
          :badge="view.barsSource?.name"
          class="dashboard-resources-panel"
        >
          <div class="dashboard-bottom-row">
            <div class="dashboard-bottom-chart">
              <BarChart :bars="view.bars" />
            </div>
            <div class="dashboard-bottom-actions">
              <slot name="bottom-right" />
            </div>
          </div>
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
    'bottom bottom bottom';
  grid-template-columns:
    minmax(220px, var(--dc-column-width, 340px))
    1fr
    minmax(220px, var(--dc-column-width, 340px));
  grid-template-rows: var(--dc-topbar-height, 96px) 1fr var(--dc-bottom-height, 160px);
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
  /* 屏幕不够高时纵向滚动：内容不许被裁掉（横向永远不滚动） */
  overflow-y: auto;
  overflow-x: hidden;
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
  overflow-y: auto;
  overflow-x: hidden;
}

.dashboard-area-bottom {
  grid-area: bottom;
  min-height: 0;
  pointer-events: auto;
}

/* 底栏内部：左侧条形图，右侧控制按钮 + OSM 署名 */
.dashboard-bottom-row {
  display: flex;
  align-items: stretch;
  gap: var(--dc-panel-gap, 12px);
  height: 100%;
  min-height: 0;
}

.dashboard-bottom-chart {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.dashboard-bottom-actions {
  flex: 0 0 320px;
  min-width: 0;
  overflow: hidden;
}

.dashboard-metric-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: minmax(52px, 1fr);
  gap: 6px;
  height: 100%;
  min-height: 0;
}

/* 面板在列里的伸缩规则：
   核心指标 / 分类分布按内容高度起步，趋势与事件流吃掉剩余空间，
   但都有上限 —— 不许长成一根「空条」。
   屏幕不够高时由列的纵向滚动兜住（内容不许被裁掉）。 */
.dashboard-metrics-panel {
  flex: 1 1 auto;
  max-height: 340px;
}

.dashboard-distribution-panel {
  flex: 0 0 auto;
}

.dashboard-trend-panel {
  flex: 1 1 auto;
  min-height: 200px;
  max-height: 420px;
}

.dashboard-events-panel {
  flex: 1 1 auto;
  min-height: 90px;
  max-height: 340px;
}

/* 联动说明（例如「空气质量为全市指标，无空间定位」） */
.dc-event-note {
  margin: 0 0 6px;
  font-size: var(--dc-label-size, 11px);
  line-height: 1.4;
  color: rgba(226, 232, 240, 0.5);
}

/* 底栏卡片：内部一行（条形图 + 右侧操作区），不滚动 */
.dashboard-resources-panel {
  height: 100%;
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
