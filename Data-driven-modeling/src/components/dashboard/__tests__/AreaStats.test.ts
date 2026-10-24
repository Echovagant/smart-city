import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('cesium', async () => {
  const { createCesiumStub } = await import('../../../composables/__tests__/cesiumStub')
  return createCesiumStub()
})

import AreaStats from '../AreaStats.vue'
import type { AreaStats as AreaStatsPayload } from '../../../../types/city'

/** 一份区域统计载荷（数字与后端 `/api/city/area` 的实测返回一致）。 */
const payload = (): AreaStatsPayload => ({
  bbox: [2.1574, 41.3945, 2.1724, 41.4045],
  area_km2: 1.4226,
  building_count: 1039,
  road_count: 661,
  road_length_km: 54.4386,
  road_length_by_tier_km: {
    main: 3.0294,
    secondary: 6.5506,
    local: 17.3231,
    footway: 27.3563,
    other: 0.1792,
  },
  facility_counts: { medical: 0, public_safety: 6, education: 2, heritage: 9, commerce: 4 },
  facility_categories: [
    { key: 'medical', label: '医疗设施', count: 0, source: payloadSource() },
    { key: 'public_safety', label: '公共安全设施', count: 6, source: payloadSource() },
    { key: 'education', label: '教育设施', count: 2, source: payloadSource() },
    { key: 'heritage', label: '历史建筑', count: 9, source: payloadSource() },
    { key: 'commerce', label: '商业与办公', count: 4, source: payloadSource() },
  ],
  building_density_per_km2: 730.353,
  source: payloadSource(),
  method: {},
})

/** 来源标注。 */
function payloadSource() {
  return {
    name: 'OpenStreetMap 本地快照',
    url: 'backend-python/geojson/',
    observed_at: '2026-06-21T11:37:06Z',
    fetched_at: '2026-10-23T10:04:48Z',
    realtime: false,
    estimated: false,
  }
}

const CENTER = { lng: 2.1652, lat: 41.39585 }

describe('AreaStats', () => {
  it('还没选区域时给出空态与半径档位', () => {
    const wrapper = mount(AreaStats, { props: { stats: null, center: null, radiusM: 300 } })

    expect(wrapper.find('.dc-area-empty-text').text()).toBe('在场景里点一下地面，查看该范围的统计')
    expect(wrapper.text()).toContain('当前半径 300 m')
    // 三档半径都在
    const options = wrapper.findAll('.dc-area-radius-option')
    expect(options.map(option => option.text())).toEqual(['200 m', '300 m', '500 m'])
    expect(options[1]!.classes()).toContain('is-active')
  })

  it('场景底座没接上时，空态要直说不能拾取', () => {
    const wrapper = mount(AreaStats, {
      props: {
        stats: null,
        center: null,
        radiusM: 300,
        sceneReady: false,
        emptyText: '场景底座未就绪，无法拾取',
      },
    })

    const empty = wrapper.find('.dc-area-empty-text')
    expect(empty.text()).toBe('场景底座未就绪，无法拾取')
    // 不许显示成「在场景里点一下地面」那种会让人以为功能正常的假空态
    expect(empty.text()).not.toContain('点一下地面')
    expect(empty.classes()).toContain('is-not-ready')
    // 底座没接上时不说「当前半径…可切换」——那也是一句误导
    expect(wrapper.find('.dc-area-empty-sub').exists()).toBe(false)
  })

  it('选中了区域就把后端给的数字如实显示出来', () => {
    const wrapper = mount(AreaStats, {
      props: { stats: payload(), center: CENTER, radiusM: 300 },
    })

    const stats = wrapper.findAll('.dc-area-stat')
    expect(stats).toHaveLength(4)
    expect(stats[0]!.text()).toContain('范围面积')
    expect(stats[0]!.text()).toContain('1.4226')
    expect(stats[1]!.text()).toContain('建筑数')
    expect(stats[1]!.text()).toContain('1039')
    expect(stats[2]!.text()).toContain('路网总长')
    expect(stats[2]!.text()).toContain('54.44')
    expect(stats[3]!.text()).toContain('建筑密度')
    expect(stats[3]!.text()).toContain('730.35')

    // 道路分级分解
    const text = wrapper.text()
    expect(text).toContain('主干道 3.03')
    expect(text).toContain('次干道 6.55')
    expect(text).toContain('人行道/步行区 27.36')

    // 设施分类（分类名用后端给的）
    expect(text).toContain('医疗设施 0')
    expect(text).toContain('公共安全设施 6')
    expect(text).toContain('历史建筑 9')

    // 选中范围与来源
    expect(wrapper.find('.dc-area-selection').text()).toBe('2.165200, 41.395850 · 半径 300 m')
    expect(wrapper.find('.dc-area-source').text()).toContain('OpenStreetMap 本地快照')
    // 本地快照不是实时数据，要照实标
    expect(wrapper.find('.dc-area-source').text()).toContain('（非实时）')
  })

  it('取数失败时显示取不到，不显示 0', () => {
    const wrapper = mount(AreaStats, {
      props: {
        stats: null,
        center: CENTER,
        radiusM: 300,
        error: '数据源暂不可用',
        errorDetail: 'HTTP 503 for /api/city/area',
      },
    })

    expect(wrapper.find('.dc-area-error').text()).toBe('数据源暂不可用')
    expect(wrapper.find('.dc-area-error').attributes('title')).toContain('503')
    expect(wrapper.findAll('.dc-area-stat')).toHaveLength(0)
  })

  it('正在取数时显示加载态', () => {
    const wrapper = mount(AreaStats, {
      props: { stats: null, center: CENTER, radiusM: 300, loading: true },
    })
    expect(wrapper.find('.dc-area-loading').text()).toBe('正在统计该范围…')
  })

  it('某个数字取不到时显示「数据源暂不可用」，不显示 0', () => {
    const broken = payload()
    broken.building_density_per_km2 = Number.NaN
    const wrapper = mount(AreaStats, {
      props: { stats: broken, center: CENTER, radiusM: 300 },
    })
    const density = wrapper.findAll('.dc-area-stat')[3]!
    expect(density.find('.dc-area-stat-value').text()).toBe('数据源暂不可用')
    expect(density.find('.dc-area-stat-value').classes()).toContain('is-unavailable')
  })

  it('换半径与清除选区都抛给上层', async () => {
    const wrapper = mount(AreaStats, {
      props: { stats: payload(), center: CENTER, radiusM: 300 },
    })

    await wrapper.findAll('.dc-area-radius-option')[2]!.trigger('click')
    expect(wrapper.emitted('update:radius')).toEqual([[500]])

    await wrapper.find('.dc-area-clear').trigger('click')
    expect(wrapper.emitted('clear')).toHaveLength(1)
  })

  it('没有设施分类标签时退回兜底名', () => {
    const bare = payload()
    bare.facility_categories = []
    const wrapper = mount(AreaStats, {
      props: { stats: bare, center: CENTER, radiusM: 300 },
    })
    expect(wrapper.text()).toContain('医疗设施 0')
    expect(wrapper.text()).toContain('商业与办公 4')
  })

  it('数据不完整时不编数字，也不崩', () => {
    const broken = payload()
    // 数量缺失 / 不是数字
    broken.area_km2 = null as never
    broken.building_count = undefined as never
    // 分级里有后端没给过的键，且有一个取不到的值
    broken.road_length_by_tier_km = { main: 'abc', tram: 1.2 } as never
    // 分类名是空的、键也不认识，计数取不到
    broken.facility_categories = [
      { key: 'tram_stop', label: '', count: 'x' as never, source: payloadSource() },
    ]
    broken.facility_counts = undefined as never
    // 来源缺字段：观测时间未知、不是模型估算
    broken.source = {
      name: 'OpenStreetMap 本地快照',
      url: 'backend-python/geojson/',
      observed_at: undefined as never,
      fetched_at: '2026-10-23T10:04:48Z',
      realtime: true,
      estimated: false,
    }

    const wrapper = mount(AreaStats, {
      props: { stats: broken, center: CENTER, radiusM: 300 },
    })
    const stats = wrapper.findAll('.dc-area-stat')
    expect(stats[0]!.find('.dc-area-stat-value').text()).toBe('数据源暂不可用')
    expect(stats[1]!.find('.dc-area-stat-value').text()).toBe('数据源暂不可用')
    // 未知分级：显示原始键；取不到的值：显示「—」
    expect(wrapper.text()).toContain('tram 1.20')
    expect(wrapper.text()).toContain('主干道 —')
    // 未知分类：退回原始键
    expect(wrapper.text()).toContain('tram_stop —')
    // 观测时间未知
    expect(wrapper.find('.dc-area-source').text()).toContain('观测时间未知')
  })

  it('来源整个缺失时照实说取不到', () => {
    const broken = payload()
    broken.source = undefined as never
    const wrapper = mount(AreaStats, {
      props: { stats: broken, center: CENTER, radiusM: 300 },
    })
    expect(wrapper.find('.dc-area-source').text()).toBe('数据源暂不可用')
    expect(wrapper.find('.dc-area-source').attributes('title')).toBe('数据源暂不可用')
  })

  it('模型估算的来源要在悬停提示里说清楚', () => {
    const estimated = payload()
    estimated.source.estimated = true
    const wrapper = mount(AreaStats, {
      props: { stats: estimated, center: CENTER, radiusM: 300 },
    })
    expect(wrapper.find('.dc-area-source').attributes('title')).toContain('注意：这是模型估算，不是实测')
  })

  it('没有选区时显示空态（哪怕手里有统计）', () => {
    const wrapper = mount(AreaStats, {
      props: { stats: payload(), center: null, radiusM: 300 },
    })
    // 没有选区就没有「选的是哪一片」，界面回到空态
    expect(wrapper.find('.dc-area-empty').exists()).toBe(true)
    expect(wrapper.findAll('.dc-area-stat')).toHaveLength(0)
  })

  it('提示文案与错误细节缺失时都不报错', () => {
    const wrapper = mount(AreaStats, {
      props: {
        stats: null,
        center: null,
        radiusM: 300,
        hint: '刚才点到了天空，请点地面上的位置',
        error: null,
        errorDetail: null,
      },
    })
    expect(wrapper.find('.dc-area-hint').text()).toBe('刚才点到了天空，请点地面上的位置')

    const failed = mount(AreaStats, {
      props: { stats: null, center: CENTER, radiusM: 300, error: '数据源暂不可用', errorDetail: null },
    })
    expect(failed.find('.dc-area-error').attributes('title')).toBeUndefined()
  })

  it('分级分解整个缺失时不报错', () => {
    const bare = payload()
    bare.road_length_by_tier_km = undefined as never
    const wrapper = mount(AreaStats, {
      props: { stats: bare, center: CENTER, radiusM: 300 },
    })
    expect(wrapper.text()).not.toContain('道路分级')
    expect(wrapper.findAll('.dc-area-stat')).toHaveLength(4)
  })
})
