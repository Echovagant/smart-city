import { mount } from '@vue/test-utils'
import { describe, it, expect, beforeEach } from 'vitest'

import DashboardOverlay from '../DashboardOverlay.vue'
import { DEFAULT_TAB_KEY, useDashboardState } from '@/composables/useDashboardState'
import type { CityOverview } from '../../../types/city'

/**
 * 大屏 overlay 的**行为断言**：页签切换、数据缺失时的诚实显示。
 *
 * 页签状态是模块级单例（`useDashboardState`），所以每个用例先复位。
 */

const SOURCE = {
  name: '中国环境监测总站',
  url: 'https://air.cnemc.cn:18007/CityData/GetAllCityRealTimeAQIModels',
  observed_at: '2026-10-22T04:00:00Z',
  fetched_at: '2026-10-22T04:30:00Z',
  realtime: true,
  estimated: false,
}

const overviewPayload = (): CityOverview => ({
  city: { code: 110000, name: '北京市', latitude: 40.05, longitude: 116.4 },
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
    const aqi = overview.metrics.find(metric => metric.key === 'aqi')
    if (aqi) aqi.value = null

    const wrapper = mount(DashboardOverlay, { props: { overview } })
    const airCard = wrapper
      .findAll('.dc-metric-card')
      .find(card => card.find('.dc-metric-label').text() === '空气质量')
    expect(airCard).toBeDefined()
    const value = airCard!.find('.dc-metric-value')
    expect(value.text()).toBe('数据源暂不可用')
    expect(value.text()).not.toContain('0')
    // 没取到数据就不知道分级 —— 不显示上一档的「良」
    expect(airCard!.find('.dc-metric-badge').exists()).toBe(false)
    // 其它源照常显示
    const buildingCard = wrapper
      .findAll('.dc-metric-card')
      .find(card => card.find('.dc-metric-label').text() === '建筑总数')
    expect(buildingCard!.find('.dc-metric-value').text()).toBe('3854')
  })

  it('shows an honest empty state before the overview arrives', () => {
    const wrapper = mount(DashboardOverlay, { props: { overview: null } })
    expect(wrapper.findAll('.dc-metric-value')[0].text()).toBe('数据源暂不可用')
    // 事件流本轮没有数据 → 空态，不编造事件
    expect(wrapper.find('.dc-event-empty').text()).toBe('暂无事件数据')
  })

  it('renders the slot content of the left column', () => {
    const wrapper = mount(DashboardOverlay, {
      props: { overview: overviewPayload() },
      slots: { left: '<div class="fake-control-panel">控制面板</div>' },
    })
    expect(wrapper.find('.fake-control-panel').exists()).toBe(true)
  })
})
