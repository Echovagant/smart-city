import { mount } from '@vue/test-utils'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'

vi.mock('cesium', async () => {
  const { createCesiumStub } = await import('../../composables/__tests__/cesiumStub')
  return createCesiumStub()
})

import DashboardOverlay from '../DashboardOverlay.vue'
import { DEFAULT_TAB_KEY, useDashboardState } from '@/composables/useDashboardState'
import type { SceneStage } from '@/composables/useSceneStage'
import type { CityOverview } from '../../../types/city'

/**
 * 大屏 overlay 的**行为断言**：页签切换、数据缺失时的诚实显示。
 *
 * 页签状态是模块级单例（`useDashboardState`），所以每个用例先复位。
 */

const SOURCE = {
  name: 'Open-Meteo 空气质量（CAMS 模型再分析）',
  url: 'https://air-quality-api.open-meteo.com/v1/air-quality',
  observed_at: '2026-10-22T04:00:00Z',
  fetched_at: '2026-10-22T04:30:00Z',
  realtime: true,
  estimated: false,
}

const overviewPayload = (): CityOverview => ({
  city: { id: 'barcelona', name: '巴塞罗那', latitude: 41.39585, longitude: 2.1652, timezone: 'Europe/Madrid' },
  generated_at: '2026-10-22T04:00:00Z',
  metrics: [
    {
      key: 'aqi',
      label: '空气质量',
      value: 51,
      unit: 'AQI',
      level: 2,
      level_label: '良',
      extra: { primary_pollutant: '颗粒物(PM10)' },
      source: SOURCE,
    },
    { key: 'building_count', label: '建筑总数', value: 3854, unit: '栋', source: SOURCE },
  ],
  series: [],
  facilities: [],
  degraded: [],
})

beforeEach(() => {
  useDashboardState().setTab(DEFAULT_TAB_KEY)
})

describe('DashboardOverlay', () => {
  it('renders the title and the five tabs', () => {
    const wrapper = mount(DashboardOverlay, { props: { overview: overviewPayload() } })
    expect(wrapper.find('.dc-topbar-title').text()).toBe('智慧城市运行管理中心')
    const tabs = wrapper.findAll('.dc-tab')
    expect(tabs).toHaveLength(5)
    expect(tabs.map(tab => tab.text())).toEqual([
      '区域概览',
      '空气质量',
      '公共安全',
      '城市文旅',
      '路网运行',
    ])
  })

  it('switches the metric cards when a tab is clicked', async () => {
    const wrapper = mount(DashboardOverlay, { props: { overview: overviewPayload() } })

    // 区域概览：建筑总数
    expect(wrapper.text()).toContain('建筑总数')

    await wrapper.findAll('.dc-tab')[1].trigger('click')

    // 空气质量页：首要污染物（AQI 指标 extra 里的字段）
    expect(wrapper.text()).toContain('首要污染物')
    expect(wrapper.text()).toContain('颗粒物(PM10)')
    expect(wrapper.findAll('.dc-tab')[1].classes()).toContain('is-active')
  })

  it('shows 数据源暂不可用 instead of 0 when the source is degraded', () => {
    const overview = overviewPayload()
    const building = overview.metrics.find(metric => metric.key === 'building_count')
    if (building) building.value = null

    const wrapper = mount(DashboardOverlay, { props: { overview } })
    const buildingCard = wrapper
      .findAll('.dc-metric-card')
      .find(card => card.find('.dc-metric-label').text() === '建筑总数')
    expect(buildingCard).toBeDefined()
    const value = buildingCard!.find('.dc-metric-value')
    expect(value.text()).toBe('数据源暂不可用')
    expect(value.text()).not.toContain('0')
    // 没取到数据就不知道分级 —— 不显示上一档的「良」
    expect(buildingCard!.find('.dc-metric-badge').exists()).toBe(false)
  })

  it('shows an honest empty state before the overview arrives', () => {
    const wrapper = mount(DashboardOverlay, { props: { overview: null } })
    expect(wrapper.findAll('.dc-metric-value')[0].text()).toBe('数据源暂不可用')
    // 事件流没有数据 → 空态，不编造事件
    expect(wrapper.find('.dc-event-empty').text()).toBe('暂无事件数据')
  })

  it('places the readout band in the top bar and the controls in the bottom bar', () => {
    const wrapper = mount(DashboardOverlay, {
      props: { overview: overviewPayload() },
      slots: {
        'top-extra': '<div class="fake-readout-band">读数带</div>',
        'bottom-right': '<div class="fake-control-panel">控制面板</div>',
      },
    })

    // 读数带在顶栏里
    const top = wrapper.find('.dashboard-area-top')
    expect(top.find('.fake-readout-band').exists()).toBe(true)
    // 控制面板在通栏底栏里
    const bottom = wrapper.find('.dashboard-area-bottom')
    expect(bottom.find('.fake-control-panel').exists()).toBe(true)
    // 左列只剩「核心指标」+ 趋势面板两块
    const left = wrapper.find('.dashboard-area-left')
    expect(left.findAll('.dc-panel')).toHaveLength(2)
  })

  it('puts the trend panel in the left column with both time views', async () => {
    const wrapper = mount(DashboardOverlay, { props: { overview: overviewPayload() } })

    const left = wrapper.find('.dashboard-area-left')
    const trend = left.find('.dashboard-trend-panel')
    expect(trend.exists()).toBe(true)
    // 趋势面板：24 小时 / 日 两个视图
    expect(trend.findAll('.dc-trend-view').map(button => button.text())).toEqual([
      '24 小时',
      '日',
    ])
    // 默认是 24 小时视图，标题说清楚看的是哪一段时间
    expect(trend.find('.dc-panel-title').text()).toBe('24 小时趋势')

    const daily = trend.findAll('.dc-trend-view').find(button => button.text() === '日')
    await daily!.trigger('click')
    expect(trend.find('.dc-panel-title').text()).toBe('逐日趋势')
  })

  it('puts the area statistics panel at the top of the right column', () => {
    const wrapper = mount(DashboardOverlay, { props: { overview: overviewPayload() } })

    const right = wrapper.find('.dashboard-area-right')
    const area = right.find('.dashboard-area-stats')
    expect(area.exists()).toBe(true)
    // 区域统计排在右列第一块（点完地面数字就在视线里）
    expect(right.element.firstElementChild?.classList.contains('dashboard-area-stats')).toBe(true)
    // 三档半径都在
    expect(area.findAll('.dc-area-radius-option').map(option => option.text())).toEqual([
      '200 m',
      '300 m',
      '500 m',
    ])
  })

  it('says so when the scene stage is not wired up', () => {
    const wrapper = mount(DashboardOverlay, { props: { overview: overviewPayload() } })
    const area = wrapper.find('.dashboard-area-stats')
    // 没有底座就没有拾取：直说，不装成「在场景里点一下地面」
    expect(area.find('.dc-area-empty-text').text()).toBe('场景底座未就绪，无法拾取')
    expect(area.find('.dc-area-empty-text').classes()).toContain('is-not-ready')
  })

  it('shows the picking hint once the scene stage is wired up', async () => {
    const stage = { viewer: ref(null) } as unknown as SceneStage
    const wrapper = mount(DashboardOverlay, {
      props: { overview: overviewPayload(), stage },
    })
    const area = wrapper.find('.dashboard-area-stats')
    expect(area.find('.dc-area-empty-text').text()).toBe('在场景里点一下地面，查看该范围的统计')
    expect(area.find('.dc-area-empty-text').classes()).not.toContain('is-not-ready')
  })

  it('picks up a scene stage that arrives later', async () => {
    const wrapper = mount(DashboardOverlay, { props: { overview: overviewPayload() } })
    expect(wrapper.find('.dc-area-empty-text').text()).toBe('场景底座未就绪，无法拾取')

    const stage = { viewer: ref(null) } as unknown as SceneStage
    await wrapper.setProps({ stage })

    expect(wrapper.find('.dc-area-empty-text').text()).toBe('在场景里点一下地面，查看该范围的统计')
  })

  it('keeps the left column to the two panels it had', () => {
    const wrapper = mount(DashboardOverlay, { props: { overview: overviewPayload() } })
    const left = wrapper.find('.dashboard-area-left')
    expect(left.findAll('.dc-panel')).toHaveLength(2)
    // 右列多了区域统计这一块
    expect(wrapper.find('.dashboard-area-right').findAll('.dc-panel')).toHaveLength(3)
  })
})
