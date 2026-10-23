import { describe, it, expect, beforeEach } from 'vitest'

import { resolveTabView, resolveTabViewByKey } from '../useDashboardData'
import { DASHBOARD_TABS, DEFAULT_TAB_KEY, useDashboardState } from '../useDashboardState'
import type { CityOverview, DashboardMetricCard, SourceInfo } from '../../../types/city'

/**
 * `resolveTabView` 的行为断言。
 *
 * 它是**纯函数**（输入输出都是普通数据，不碰 Vue 响应式），
 * 所以这里直接断言算出来的结构，不 mount 组件。
 */

/** 空气质量源。 */
const SOURCE_AIR: SourceInfo = {
  name: '中国环境监测总站',
  url: 'https://air.cnemc.cn:18007/CityData/GetAllCityRealTimeAQIModels',
  observed_at: '2026-10-22T04:00:00Z',
  fetched_at: '2026-10-22T04:30:00Z',
  realtime: true,
  estimated: false,
}

/** 天气源（上游时间戳不新鲜 → realtime 为 false）。 */
const SOURCE_WEATHER: SourceInfo = {
  name: '中国天气网',
  url: 'http://www.weather.com.cn/data/sk/101010100.html',
  observed_at: '2026-10-21T09:05:00Z',
  fetched_at: '2026-10-22T04:30:00Z',
  realtime: false,
  estimated: false,
}

/** 本地 OSM 快照（设施分类与路网静态指标）。 */
const SOURCE_OSM: SourceInfo = {
  name: '本地 OSM 路网数据',
  url: 'backend-python/geojson/roads.geojson',
  observed_at: '2026-06-21T11:37:06Z',
  fetched_at: '2026-10-22T04:30:00Z',
  realtime: false,
  estimated: false,
}

/** 设施分类源。 */
const SOURCE_FACILITIES: SourceInfo = {
  name: 'OpenStreetMap 本地快照',
  url: 'backend-python/geojson/buildings.geojson',
  observed_at: '2026-06-21T11:37:06Z',
  fetched_at: '2026-10-22T04:30:00Z',
  realtime: false,
  estimated: false,
}

/** 造一份城市指标载荷。 */
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
      extra: { quality: '良', primary_pollutant: '颗粒物(PM10)' },
      source: SOURCE_AIR,
    },
    { key: 'pm25', label: 'PM2.5', value: 32, unit: 'μg/m³', source: SOURCE_AIR },
    { key: 'pm10', label: 'PM10', value: 64, unit: 'μg/m³', source: SOURCE_AIR },
    { key: 'o3', label: 'O3', value: 44, unit: 'μg/m³', source: SOURCE_AIR },
    { key: 'no2', label: 'NO2', value: 30, unit: 'μg/m³', source: SOURCE_AIR },
    { key: 'so2', label: 'SO2', value: 4, unit: 'μg/m³', source: SOURCE_AIR },
    { key: 'co', label: 'CO', value: 0.5, unit: 'mg/m³', source: SOURCE_AIR },
    { key: 'weather_temp', label: '气温', value: 18, unit: '℃', source: SOURCE_WEATHER },
    { key: 'building_count', label: '建筑总数', value: 3854, unit: '栋', source: SOURCE_OSM },
    { key: 'road_count', label: '道路总数', value: 2260, unit: '条', source: SOURCE_OSM },
    { key: 'road_length_km', label: '路网总长', value: 202.173, unit: 'km', source: SOURCE_OSM },
    { key: 'coverage_area_km2', label: '数据覆盖面积', value: 16.53, unit: 'km²', source: SOURCE_OSM },
    { key: 'road_count_main', label: '道路数 · 主干道', value: 40, unit: '条', source: SOURCE_OSM },
    { key: 'road_count_secondary', label: '道路数 · 次干道', value: 68, unit: '条', source: SOURCE_OSM },
    { key: 'road_count_local', label: '道路数 · 支路', value: 408, unit: '条', source: SOURCE_OSM },
    { key: 'road_count_footway', label: '道路数 · 人行道/步行区', value: 1439, unit: '条', source: SOURCE_OSM },
    { key: 'road_count_other', label: '道路数 · 其他道路', value: 0, unit: '条', source: SOURCE_OSM },
    {
      key: 'road_load_index',
      label: '路网负载（模型估算）',
      value: 63.5,
      unit: '指数',
      extra: {},
      source: { ...SOURCE_OSM, estimated: true },
    },
    { key: 'facility_total', label: '设施分类总数', value: 203, unit: '处', source: SOURCE_FACILITIES },
  ],
  series: [
    {
      key: 'aqi_24h',
      label: '24 小时 AQI',
      unit: 'AQI',
      points: [
        { t: '2026-10-21T05:00:00Z', v: 30 },
        { t: '2026-10-21T06:00:00Z', v: 45 },
        { t: '2026-10-21T07:00:00Z', v: 51 },
      ],
      source: SOURCE_AIR,
    },
    {
      key: 'aqi_daily',
      label: '逐日 AQI',
      unit: 'AQI',
      points: [
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
      ],
      source: SOURCE_AIR,
    },
  ],
  facilities: [
    { key: 'medical', label: '医疗设施', count: 24, criteria: ['building=hospital'], source: SOURCE_FACILITIES },
    {
      key: 'public_safety',
      label: '公共安全设施',
      count: 18,
      criteria: ['amenity=police'],
      source: SOURCE_FACILITIES,
    },
    { key: 'education', label: '教育设施', count: 19, criteria: ['building=school'], source: SOURCE_FACILITIES },
    { key: 'heritage', label: '历史建筑', count: 87, criteria: ['historic=yes'], source: SOURCE_FACILITIES },
    {
      key: 'commerce',
      label: '商业与办公',
      count: 55,
      criteria: ['building=commercial'],
      source: SOURCE_FACILITIES,
    },
  ],
  degraded: [],
})

/** 按 key 找一张卡。 */
const cardOf = (
  view: { metrics: DashboardMetricCard[] },
  key: string,
): DashboardMetricCard | undefined => view.metrics.find(card => card.key === key)

describe('resolveTabView', () => {
  it('builds the overview tab from the real metric keys', () => {
    const view = resolveTabViewByKey('overview', overviewPayload())

    expect(view.metrics).toHaveLength(6)
    expect(view.metrics.map(card => card.key)).toEqual([
      'building_count',
      'road_count',
      'road_length_km',
      'coverage_area_km2',
      'road_tier_total',
      'facility_total',
    ])
    expect(cardOf(view, 'building_count')?.value).toBe(3854)
    // 环形图 = 道路等级分布
    expect(view.donut.slices.map(slice => slice.key)).toEqual([
      'road_count_main',
      'road_count_secondary',
      'road_count_local',
      'road_count_footway',
      'road_count_other',
    ])
    // 底栏条形 = 设施分类计数
    expect(view.bars.map(bar => bar.key)).toEqual([
      'medical',
      'public_safety',
      'education',
      'heritage',
      'commerce',
    ])
    // 折线 = 24 小时 AQI
    expect(view.line.points).toHaveLength(3)
  })

  it('never repeats the readout band metrics in the tab cards', () => {
    // 顶栏读数带（S1 的 .metric-strip）已经显示空气质量 / 气温 / 路网负载。
    // 同一个数字在大屏上出现两次就是信息噪音 —— 卡片里不许再出现这三个 key。
    const overview = overviewPayload()
    const bandOnly = new Set(['aqi', 'weather_temp', 'road_load_index'])
    for (const key of ['overview', 'air', 'public_safety', 'heritage', 'network']) {
      const view = resolveTabViewByKey(key, overview)
      for (const card of view.metrics) {
        expect(bandOnly.has(card.key)).toBe(false)
      }
    }
  })

  it('changes the cards when the tab changes', () => {
    const overview = overviewPayload()
    const air = resolveTabViewByKey('air', overview)
    expect(air.metrics.map(card => card.key)).toEqual([
      'primary_pollutant',
      'pm25',
      'pm10',
      'o3',
      'no2',
      'so2',
    ])
    // 首要污染物来自 aqi 指标的 extra
    expect(cardOf(air, 'primary_pollutant')?.value).toBe('颗粒物(PM10)')
    // 空气质量页的环形图 = 污染物浓度
    expect(air.donut.slices.map(slice => slice.key)).toEqual([
      'pm25',
      'pm10',
      'o3',
      'no2',
      'so2',
      'co',
    ])
    // CO 的单位是 mg/m³ → 环形图统一换算成 μg/m³
    const co = air.donut.slices.find(slice => slice.key === 'co')
    expect(co?.value).toBe(500)

    const network = resolveTabViewByKey('network', overview)
    expect(network.metrics.map(card => card.key)).toEqual([
      'road_length_km',
      'coverage_area_km2',
      'road_tier_total',
      'road_count_main',
      'road_count_local',
      'road_count',
    ])
    // 道路分级合计 = 五个分级之和（1955 条线要素，不是道路总数 2260）
    expect(cardOf(network, 'road_tier_total')?.value).toBe(1955)

    const heritage = resolveTabViewByKey('heritage', overview)
    expect(cardOf(heritage, 'heritage')?.value).toBe(87)
    expect(cardOf(heritage, 'facility_total')?.value).toBe(203)

    const safety = resolveTabViewByKey('public_safety', overview)
    expect(cardOf(safety, 'medical')?.value).toBe(24)
    expect(cardOf(safety, 'public_safety')?.value).toBe(18)
    expect(cardOf(safety, 'education')?.value).toBe(19)
  })

  it('marks a missing metric as unavailable instead of 0', () => {
    const overview = overviewPayload()
    const building = overview.metrics.find(metric => metric.key === 'building_count')
    if (building) building.value = null

    const view = resolveTabViewByKey('overview', overview)
    const card = cardOf(view, 'building_count')
    expect(card?.value).toBeNull()
    expect(card?.unavailable).toBe(true)
    // 没取到数据就不知道分级
    expect(card?.badge).toBeNull()
  })

  it('marks every card unavailable when there is no overview at all', () => {
    const view = resolveTabViewByKey('overview', null)
    expect(view.metrics).toHaveLength(6)
    for (const card of view.metrics) {
      expect(card.value).toBeNull()
      expect(card.unavailable).toBe(true)
    }
    expect(view.donut.slices).toHaveLength(0)
    expect(view.bars).toHaveLength(0)
  })

  it('keeps the facility donut balanced with the category counts', () => {
    const view = resolveTabViewByKey('public_safety', overviewPayload())
    const total = view.donut.slices.reduce((sum, slice) => sum + slice.value, 0)
    expect(total).toBe(203)
    expect(view.donut.centerValue).toBe(203)
  })

  it('falls back to the overview view for an unknown tab', () => {
    const view = resolveTabView({ key: 'nope', label: '未知' }, overviewPayload())
    expect(view.metrics.map(card => card.key)).toContain('building_count')
  })
})

describe('resolveTabView 的趋势序列', () => {
  it('exposes the daily series next to the 24 hour one', () => {
    const view = resolveTabViewByKey('overview', overviewPayload())

    // 24 小时视图不变
    expect(view.line.points).toHaveLength(3)
    expect(view.line.points[0]?.v).toBe(30)
    expect(view.line.emptyText).toBe('暂无 24 小时 AQI 数据')

    // 逐日视图：形状与 points 对称，v 是当天 AQI，values 是污染物日均值
    expect(view.line.daily).toHaveLength(2)
    expect(view.line.daily[0]?.v).toBe(27)
    expect(view.line.daily[0]?.values?.pm25).toBe(12)
    expect(view.line.daily[0]?.values?.co).toBe(0.4)
    expect(view.line.dailyEmptyText).toBe('暂无逐日 AQI 数据')
    expect(view.line.dailySource?.name).toBe(SOURCE_AIR.name)
  })

  it('lists the daily metrics the trend panel can switch between', () => {
    const view = resolveTabViewByKey('overview', overviewPayload())

    expect(view.line.dailyMetrics.map(metric => metric.key)).toEqual([
      'aqi',
      'pm25',
      'pm10',
      'o3',
      'no2',
      'so2',
      'co',
    ])
    // CO 是 mg/m³，其余是 μg/m³（cnemc 的口径）
    expect(view.line.dailyMetrics.find(metric => metric.key === 'co')?.unit).toBe('mg/m³')
    expect(view.line.dailyMetrics.find(metric => metric.key === 'pm25')?.unit).toBe('μg/m³')
  })

  it('leaves the daily series empty when the source is degraded', () => {
    const overview = overviewPayload()
    overview.series = overview.series.filter(series => series.key !== 'aqi_daily')

    const view = resolveTabViewByKey('overview', overview)

    // 空数组，不许编数字，也不许拿 24 小时的数据顶替
    expect(view.line.daily).toEqual([])
    expect(view.line.dailySource).toBeNull()
    // 24 小时视图照常
    expect(view.line.points).toHaveLength(3)
  })
})

describe('useDashboardState', () => {
  beforeEach(() => {
    useDashboardState().setTab(DEFAULT_TAB_KEY)
  })

  it('exposes the five tabs', () => {
    expect(DASHBOARD_TABS.map(tab => tab.key)).toEqual([
      'overview',
      'air',
      'public_safety',
      'heritage',
      'network',
    ])
  })

  it('switches the active tab', () => {
    const { activeTabKey, activeTab, setTab } = useDashboardState()
    setTab('air')
    expect(activeTabKey.value).toBe('air')
    expect(activeTab.value.label).toBe('空气质量')
  })

  it('ignores an unknown tab key', () => {
    const { activeTabKey, setTab } = useDashboardState()
    setTab('air')
    setTab('不存在的页签')
    expect(activeTabKey.value).toBe('air')
  })
})
