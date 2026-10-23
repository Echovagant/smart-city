import { mount } from '@vue/test-utils'
import { describe, it, expect } from 'vitest'

import TrendPanel from '../TrendPanel.vue'
import type { DashboardLine, SourceInfo } from '../../../../types/city'

/**
 * 趋势面板（24 小时 / 日两个视图）的**行为断言**。
 *
 * 断言的是渲染出来的东西，不读源码文本。
 * 重点：
 * - 24 小时视图**没被弄坏**（还是逐小时 AQI）；
 * - 日视图画的是后端给的逐日序列（v = AQI，values = 污染物日均值）；
 * - 时间显示是本地时区，且**不用 `toLocaleTimeString`**（所以格式自己拼）。
 */

/** 逐小时源。 */
const SOURCE_HOURLY: SourceInfo = {
  name: '中国环境监测总站（逐小时历史）',
  url: 'https://air.cnemc.cn:18007/HourChangesPublish/GetCityRealTimeAqiHistoryByCondition',
  observed_at: '2026-10-22T04:00:00Z',
  fetched_at: '2026-10-22T04:30:00Z',
  realtime: false,
  estimated: false,
}

/** 逐日源。 */
const SOURCE_DAILY: SourceInfo = {
  name: '中国环境监测总站（逐日历史）',
  url: 'https://air.cnemc.cn:18007/HourChangesPublish/GetCityDayAqiHistoryByCondition',
  observed_at: '2026-10-22T16:00:00Z',
  fetched_at: '2026-10-22T16:30:00Z',
  realtime: false,
  estimated: false,
}

/** 逐日趋势里可切换的指标（与 `useDashboardData` 给的一致）。 */
const DAILY_METRICS = [
  { key: 'aqi', label: 'AQI', unit: 'AQI' },
  { key: 'pm25', label: 'PM2.5', unit: 'μg/m³' },
  { key: 'pm10', label: 'PM10', unit: 'μg/m³' },
  { key: 'o3', label: 'O3', unit: 'μg/m³' },
  { key: 'no2', label: 'NO2', unit: 'μg/m³' },
  { key: 'so2', label: 'SO2', unit: 'μg/m³' },
  { key: 'co', label: 'CO', unit: 'mg/m³' },
]

/** 一份完整的趋势数据。 */
const lineFixture = (): DashboardLine => ({
  points: [
    { t: '2026-10-22T01:00:00Z', v: 30 },
    { t: '2026-10-22T02:00:00Z', v: 45 },
    { t: '2026-10-22T03:00:00Z', v: 60 },
  ],
  daily: [
    {
      t: '2026-10-20T16:00:00Z',
      v: 27,
      values: { pm25: 12, pm10: 30, o3: 80, no2: 25, so2: 3, co: 0.4 },
    },
    {
      t: '2026-10-21T16:00:00Z',
      v: 29,
      values: { pm25: 18, pm10: 38, o3: 70, no2: 28, so2: 3, co: 0.4 },
    },
    {
      t: '2026-10-22T16:00:00Z',
      v: 50,
      values: { pm25: 26, pm10: 50, o3: 62, no2: 31, so2: 3, co: 0.5 },
    },
  ],
  dailyMetrics: DAILY_METRICS,
  unit: 'AQI',
  source: SOURCE_HOURLY,
  emptyText: '暂无 24 小时 AQI 数据',
  dailySource: SOURCE_DAILY,
  dailyEmptyText: '暂无逐日 AQI 数据',
})

describe('TrendPanel', () => {
  it('shows the 24 hour view by default and keeps it working', () => {
    const wrapper = mount(TrendPanel, { props: { line: lineFixture() } })

    expect(wrapper.find('.dc-panel-title').text()).toBe('24 小时趋势')
    expect(wrapper.find('.dc-panel-badge').text()).toBe(SOURCE_HOURLY.name)
    // 折线画的是逐小时 AQI：首末点的数值标注
    const text = wrapper.text()
    expect(text).toContain('30 AQI')
    expect(text).toContain('60 AQI')
    // 日视图的指标切换此时不出现
    expect(wrapper.findAll('.dc-trend-metric')).toHaveLength(0)
  })

  it('switches to the daily view and draws the daily AQI', async () => {
    const wrapper = mount(TrendPanel, { props: { line: lineFixture() } })
    const daily = wrapper.findAll('.dc-trend-view').find(button => button.text() === '日')
    await daily!.trigger('click')

    expect(wrapper.find('.dc-panel-title').text()).toBe('逐日趋势')
    expect(wrapper.find('.dc-panel-badge').text()).toBe(SOURCE_DAILY.name)
    // 逐日 AQI：27 → 50
    const text = wrapper.text()
    expect(text).toContain('27 AQI')
    expect(text).toContain('50 AQI')
    // 指标切换出现
    expect(wrapper.findAll('.dc-trend-metric')).toHaveLength(DAILY_METRICS.length)
  })

  it('switches the daily view to another pollutant', async () => {
    const wrapper = mount(TrendPanel, { props: { line: lineFixture() } })
    const daily = wrapper.findAll('.dc-trend-view').find(button => button.text() === '日')
    await daily!.trigger('click')
    const chip = wrapper.findAll('.dc-trend-metric').find(item => item.text() === 'PM2.5')
    await chip!.trigger('click')

    // 画的是 PM2.5 的日均值（12 → 26），单位跟着换
    const text = wrapper.text()
    expect(text).toContain('12 μg/m³')
    expect(text).toContain('26 μg/m³')
    expect(text).not.toContain('27 AQI')
    // 选中的指标有选中态
    expect(chip!.classes()).toContain('is-active')
  })

  it('breaks the daily line at a missing value instead of drawing it down to 0', async () => {
    const line = lineFixture()
    // 五天里中间两天没测到 PM10（null）——不许补 0
    line.daily = [
      { t: '2026-10-18T16:00:00Z', v: 40, values: { pm10: 20 } },
      { t: '2026-10-19T16:00:00Z', v: 41, values: { pm10: 21 } },
      { t: '2026-10-20T16:00:00Z', v: 42, values: { pm10: null } },
      { t: '2026-10-21T16:00:00Z', v: 43, values: { pm10: 23 } },
      { t: '2026-10-22T16:00:00Z', v: 44, values: { pm10: 24 } },
    ]
    const wrapper = mount(TrendPanel, { props: { line } })
    const daily = wrapper.findAll('.dc-trend-view').find(button => button.text() === '日')
    await daily!.trigger('click')
    const chip = wrapper.findAll('.dc-trend-metric').find(item => item.text() === 'PM10')
    await chip!.trigger('click')

    // 中间断了一个点 → 两段折线（而不是一条拉到 0 的线）
    expect(wrapper.findAll('polyline')).toHaveLength(2)
  })

  it('shows the time range in local time without toLocaleTimeString', async () => {
    const wrapper = mount(TrendPanel, { props: { line: lineFixture() } })

    // 24 小时视图：到分钟，格式自己拼（补零），并说明是本地时间
    expect(wrapper.find('.dc-trend-range').text()).toMatch(
      /^\d{2}-\d{2} \d{2}:\d{2} → \d{2}-\d{2} \d{2}:\d{2}（本地时间）$/,
    )

    const daily = wrapper.findAll('.dc-trend-view').find(button => button.text() === '日')
    await daily!.trigger('click')
    // 逐日视图：只到日
    expect(wrapper.find('.dc-trend-range').text()).toMatch(
      /^\d{2}-\d{2} → \d{2}-\d{2}（本地时间）$/,
    )
  })

  it('shows an honest empty state when the daily series is missing', async () => {
    const line = lineFixture()
    line.daily = []
    const wrapper = mount(TrendPanel, { props: { line } })
    const daily = wrapper.findAll('.dc-trend-view').find(button => button.text() === '日')
    await daily!.trigger('click')

    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.text()).toContain('暂无逐日 AQI 数据')
    // 没有时间范围可显示
    expect(wrapper.find('.dc-trend-range').exists()).toBe(false)
  })

  it('keeps the 24 hour empty state honest', () => {
    const line = lineFixture()
    line.points = []
    const wrapper = mount(TrendPanel, { props: { line } })

    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.text()).toContain('暂无 24 小时 AQI 数据')
  })
})
