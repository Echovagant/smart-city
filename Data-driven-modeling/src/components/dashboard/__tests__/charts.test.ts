import { mount } from '@vue/test-utils'
import { describe, it, expect } from 'vitest'

import BarChart from '../BarChart.vue'
import DonutChart from '../DonutChart.vue'
import EventStream from '../EventStream.vue'
import LineChart from '../LineChart.vue'
import MetricCard from '../MetricCard.vue'
import PanelCard from '../PanelCard.vue'
import TopBar from '../TopBar.vue'
import type { SourceInfo } from '../../../../types/city'

/**
 * 大屏图表组件的**行为断言**。
 *
 * 断言的是渲染出来的文本与元素，不读源码文本。
 * 每个组件都测两条：给数据 → 渲染出该有的东西；给空数据 → 诚实的空态。
 */

/** 一份来源标注。 */
const SOURCE: SourceInfo = {
  name: '中国环境监测总站',
  url: 'https://air.cnemc.cn:18007/CityData/GetAllCityRealTimeAQIModels',
  observed_at: '2026-10-22T04:00:00Z',
  fetched_at: '2026-10-22T04:30:00Z',
  realtime: true,
  estimated: false,
}

describe('MetricCard', () => {
  it('shows the label, the value and the unit', () => {
    const wrapper = mount(MetricCard, {
      props: { label: 'AQI', value: 51, unit: 'AQI', source: SOURCE },
    })
    expect(wrapper.text()).toContain('AQI')
    expect(wrapper.text()).toContain('51')
  })

  it('shows 数据源暂不可用 instead of 0 when the source is unavailable', () => {
    const wrapper = mount(MetricCard, {
      props: { label: 'AQI', value: null, unavailable: true, source: SOURCE },
    })
    const value = wrapper.find('.dc-metric-value')
    expect(value.text()).toBe('数据源暂不可用')
    expect(value.text()).not.toContain('0')
  })

  it('marks a model estimate as （模型估算）', () => {
    const wrapper = mount(MetricCard, {
      props: { label: '路网负载', value: 63.5, estimated: true, source: SOURCE },
    })
    expect(wrapper.text()).toContain('（模型估算）')
  })

  it('does not mark a measured value as an estimate', () => {
    const wrapper = mount(MetricCard, {
      props: { label: 'AQI', value: 51, source: SOURCE },
    })
    expect(wrapper.text()).not.toContain('（模型估算）')
  })

  it('shows the source name and marks a stale source as 非实时', () => {
    const wrapper = mount(MetricCard, {
      props: {
        label: '气温',
        value: 18,
        source: { ...SOURCE, name: '中国天气网', realtime: false },
      },
    })
    expect(wrapper.text()).toContain('中国天气网')
    expect(wrapper.text()).toContain('（非实时）')
  })

  it('hides the level badge when the value is unavailable', () => {
    // 没取到数据就不知道分级 —— 不能显示上一档的「良」
    const wrapper = mount(MetricCard, {
      props: { label: '空气质量', value: null, unavailable: true, badge: null, source: SOURCE },
    })
    expect(wrapper.find('.dc-metric-badge').exists()).toBe(false)
  })

  it('shows the level badge when the value is available', () => {
    const wrapper = mount(MetricCard, {
      props: { label: '空气质量', value: 51, badge: '良', source: SOURCE },
    })
    expect(wrapper.find('.dc-metric-badge').text()).toBe('良')
  })

  it('puts the full source information into the title attribute', () => {
    const wrapper = mount(MetricCard, {
      props: { label: 'AQI', value: 51, source: SOURCE },
    })
    const title = wrapper.find('.dc-metric-source').attributes('title')
    expect(title).toContain('中国环境监测总站')
    expect(title).toContain(SOURCE.url)
    expect(title).toContain('取数时间')
  })
})

describe('LineChart', () => {
  const points = [
    { t: '2026-10-21T05:00:00Z', v: 30 },
    { t: '2026-10-21T06:00:00Z', v: 45 },
    { t: '2026-10-21T07:00:00Z', v: 60 },
  ]

  it('draws a polyline and labels the first and last value', () => {
    const wrapper = mount(LineChart, { props: { points } })
    expect(wrapper.find('svg').exists()).toBe(true)
    expect(wrapper.findAll('polyline')).toHaveLength(1)
    const text = wrapper.text()
    expect(text).toContain('30')
    expect(text).toContain('60')
  })

  it('breaks the line at a missing point instead of drawing it down to 0', () => {
    const wrapper = mount(LineChart, {
      props: {
        points: [
          { t: 'a', v: 30 },
          { t: 'b', v: 45 },
          { t: 'c', v: null },
          { t: 'd', v: 60 },
          { t: 'e', v: 75 },
        ],
      },
    })
    // 中间断了一个点 → 两段折线（而不是一条拉到 0 的线）
    expect(wrapper.findAll('polyline')).toHaveLength(2)
  })

  it('shows an honest empty state when there is no data', () => {
    const wrapper = mount(LineChart, { props: { points: [], emptyText: '暂无 24 小时 AQI 数据' } })
    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.text()).toContain('暂无 24 小时 AQI 数据')
  })

  it('shows the empty state when every point is missing', () => {
    const wrapper = mount(LineChart, {
      props: { points: [{ t: 'a', v: null }], emptyText: '暂无数据' },
    })
    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.text()).toContain('暂无数据')
  })
})

describe('DonutChart', () => {
  const slices = [
    { key: 'main', label: '主干道', value: 40 },
    { key: 'secondary', label: '次干道', value: 20 },
    { key: 'local', label: '支路', value: 118 },
  ]

  it('draws one arc per slice and shows the legend and the center value', () => {
    const wrapper = mount(DonutChart, {
      props: { slices, centerLabel: '道路分级合计', centerValue: 178 },
    })
    expect(wrapper.findAll('circle').length).toBeGreaterThanOrEqual(slices.length + 1)
    expect(wrapper.find('.dc-donut-value').text()).toBe('178')
    expect(wrapper.find('.dc-donut-label').text()).toBe('道路分级合计')
    const legend = wrapper.findAll('.dc-legend-item')
    expect(legend).toHaveLength(3)
    expect(legend[0].text()).toContain('主干道')
    expect(legend[0].text()).toContain('40')
  })

  it('shows an empty state when there are no slices', () => {
    const wrapper = mount(DonutChart, { props: { slices: [] } })
    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.text()).toContain('暂无分类数据')
  })
})

describe('BarChart', () => {
  it('renders one row per bar with its value and unit', () => {
    const wrapper = mount(BarChart, {
      props: {
        bars: [
          { key: 'main', label: '主干道', value: 40, unit: '条' },
          { key: 'local', label: '支路', value: 118, unit: '条' },
        ],
      },
    })
    const rows = wrapper.findAll('.dc-bar-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('主干道')
    expect(rows[0].text()).toContain('40 条')
  })

  it('marks a missing value as 暂无 instead of 0', () => {
    const wrapper = mount(BarChart, {
      props: {
        bars: [
          { key: 'main', label: '主干道', value: 40, unit: '条' },
          { key: 'local', label: '支路', value: null, unit: '条' },
        ],
      },
    })
    const rows = wrapper.findAll('.dc-bar-row')
    expect(rows[1].text()).toContain('暂无')
    expect(rows[1].text()).not.toContain('0 条')
    expect(rows[1].find('.dc-bar-fill').classes()).toContain('is-empty')
  })

  it('shows an empty state when there are no bars', () => {
    const wrapper = mount(BarChart, { props: { bars: [] } })
    expect(wrapper.findAll('.dc-bar-row')).toHaveLength(0)
    expect(wrapper.text()).toContain('暂无数据')
  })
})

describe('EventStream', () => {
  it('shows an honest empty state when there are no events', () => {
    // 本项目没有告警系统 —— 事件流是空的，不许编造事件
    const wrapper = mount(EventStream, { props: { events: [] } })
    expect(wrapper.text()).toContain('暂无事件数据')
    expect(wrapper.findAll('.dc-event-item')).toHaveLength(0)
  })

  it('renders the events it is given', () => {
    const wrapper = mount(EventStream, {
      props: {
        events: [
          { id: 'e1', level: 'warn', title: '示例事件', detail: '详情', time: '2026-10-22T04:52:31Z' },
        ],
      },
    })
    expect(wrapper.find('.dc-event-item').text()).toContain('示例事件')
  })
})

describe('PanelCard', () => {
  it('renders the title, the badge and the slot content', () => {
    const wrapper = mount(PanelCard, {
      props: { title: '核心指标', badge: '区域概览' },
      slots: { default: '<p class="slot-body">面板内容</p>' },
    })
    expect(wrapper.find('.dc-panel-title').text()).toBe('核心指标')
    expect(wrapper.find('.dc-panel-badge').text()).toBe('区域概览')
    expect(wrapper.find('.slot-body').text()).toBe('面板内容')
  })
})

describe('TopBar', () => {
  const tabs = [
    { key: 'overview', label: '区域概览' },
    { key: 'air', label: '空气质量' },
  ]

  it('renders the title and every tab', () => {
    const wrapper = mount(TopBar, { props: { title: '智慧城市运行管理中心', tabs, activeKey: 'overview' } })
    expect(wrapper.find('.dc-topbar-title').text()).toBe('智慧城市运行管理中心')
    const buttons = wrapper.findAll('.dc-tab')
    expect(buttons).toHaveLength(2)
    expect(buttons[0].text()).toBe('区域概览')
    expect(buttons[0].classes()).toContain('is-active')
  })

  it('emits select with the clicked tab', async () => {
    const wrapper = mount(TopBar, { props: { title: '标题', tabs, activeKey: 'overview' } })
    await wrapper.findAll('.dc-tab')[1].trigger('click')
    const emitted = wrapper.emitted('select')
    expect(emitted).toBeTruthy()
    expect(emitted?.[0][0]).toEqual({ key: 'air', label: '空气质量' })
  })
})
