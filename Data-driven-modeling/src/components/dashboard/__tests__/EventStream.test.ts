import { mount } from '@vue/test-utils'
import { describe, it, expect } from 'vitest'

import EventStream from '../EventStream.vue'
import type { CityEvent } from '../../../../types/city'

/**
 * 事件流面板的**行为断言**。
 *
 * 两条硬要求：
 * - 事件为空 → 显示**说明性空态**，不渲染任何编造的条目；
 * - 点一条事件 → 向上抛 `select`（上层负责把相机飞过去）。
 */

const SOURCE = {
  name: '中国环境监测总站',
  url: 'https://air.cnemc.cn:18007/CityData/GetAllCityRealTimeAQIModels',
  observed_at: '2026-10-22T03:00:00Z',
  fetched_at: '2026-10-22T04:30:00Z',
  realtime: true,
  estimated: false,
}

const event = (overrides: Partial<CityEvent> = {}): CityEvent => ({
  id: 'air_quality:level_change:2026-10-22T03:00:00Z',
  type: 'air_quality',
  level: 'info',
  title: '空气质量由优转为良',
  detail: '按 AQI 分级标准换算',
  time: '2026-10-22T03:00:00Z',
  location: { lng: 116.4, lat: 39.915, label: '城心（数据范围中心）' },
  metric_key: 'aqi_24h',
  source: SOURCE,
  estimated: false,
  ...overrides,
})

describe('EventStream', () => {
  it('shows the explanation and no invented entry when there is no event', () => {
    const wrapper = mount(EventStream, {
      props: {
        events: [],
        emptyText: '当前无触发事件 —— 路网负载 63.5 低于阈值 80',
      },
    })
    expect(wrapper.find('.dc-event-empty').text()).toBe(
      '当前无触发事件 —— 路网负载 63.5 低于阈值 80',
    )
    expect(wrapper.findAll('.dc-event-item')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('空气质量由优转为良')
  })

  it('renders the title, the place and the severity badge of an event', () => {
    const wrapper = mount(EventStream, { props: { events: [event()] } })
    const item = wrapper.find('.dc-event-item')
    expect(item.text()).toContain('空气质量由优转为良')
    expect(item.text()).toContain('城心（数据范围中心）')
    expect(item.text()).toContain('提示')
    // 严重度：提示=强调蓝 / 预警=预警橙 / 告警=告警红
    expect(wrapper.find('.dc-event-row').classes()).toContain('tone-info')
  })

  it('marks the estimated events', () => {
    const wrapper = mount(EventStream, {
      props: { events: [event({ level: 'alert', estimated: true })] },
    })
    expect(wrapper.find('.dc-event-item').text()).toContain('（模型估算）')
    expect(wrapper.find('.dc-event-badge').text()).toBe('告警')
  })

  it('emits select when an event is clicked', async () => {
    const wrapper = mount(EventStream, { props: { events: [event()] } })
    await wrapper.find('.dc-event-item').trigger('click')
    const emitted = wrapper.emitted('select')
    expect(emitted).toHaveLength(1)
    expect((emitted![0]![0] as CityEvent).id).toBe(
      'air_quality:level_change:2026-10-22T03:00:00Z',
    )
  })

  it('emits nothing when the stream is empty', async () => {
    const wrapper = mount(EventStream, { props: { events: [] } })
    expect(wrapper.emitted('select')).toBeUndefined()
  })
})
