import { describe, it, expect } from 'vitest'

import {
  aqiGradeOf,
  dedupeEvents,
  explainEmptyEvents,
  formatEventTime,
} from '../useEventStream'
import type { CityEvent, CityOverview, SourceInfo } from '../../../types/city'

/**
 * 事件流辅助函数的**行为断言**（纯函数，不碰网络也不碰 Cesium）。
 */

const SOURCE: SourceInfo = {
  name: '中国环境监测总站',
  url: 'https://air.cnemc.cn:18007/CityData/GetAllCityRealTimeAQIModels',
  observed_at: '2026-10-22T04:00:00Z',
  fetched_at: '2026-10-22T04:30:00Z',
  realtime: true,
  estimated: false,
}

const event = (overrides: Partial<CityEvent> = {}): CityEvent => ({
  id: 'e1',
  type: 'air_quality',
  level: 'info',
  title: '空气质量由优转为良',
  time: '2026-10-22T03:00:00Z',
  metric_key: 'aqi_24h',
  source: SOURCE,
  estimated: false,
  ...overrides,
})

const overview = (overrides: Partial<CityOverview> = {}): CityOverview => ({
  city: { code: 110000, name: '北京市', latitude: 40.05, longitude: 116.4 },
  generated_at: '2026-10-22T04:00:00Z',
  metrics: [],
  series: [],
  facilities: [],
  events: [],
  degraded: [],
  ...overrides,
})

describe('aqiGradeOf', () => {
  it('follows the national AQI bands', () => {
    expect(aqiGradeOf(30)).toEqual({ grade: 1, label: '优' })
    expect(aqiGradeOf(50)).toEqual({ grade: 1, label: '优' })
    expect(aqiGradeOf(58)).toEqual({ grade: 2, label: '良' })
    expect(aqiGradeOf(100)).toEqual({ grade: 2, label: '良' })
    expect(aqiGradeOf(120)).toEqual({ grade: 3, label: '轻度污染' })
    expect(aqiGradeOf(260)).toEqual({ grade: 5, label: '重度污染' })
    expect(aqiGradeOf(400)).toEqual({ grade: 6, label: '严重污染' })
  })

  it('has no grade for values it cannot read', () => {
    expect(aqiGradeOf(null)).toBeNull()
    expect(aqiGradeOf(undefined)).toBeNull()
    expect(aqiGradeOf('abc')).toBeNull()
    expect(aqiGradeOf(-1)).toBeNull()
    expect(aqiGradeOf(Number.NaN)).toBeNull()
  })
})

describe('dedupeEvents', () => {
  it('keeps one entry per id', () => {
    const result = dedupeEvents([
      event({ id: 'a', title: '第一条' }),
      event({ id: 'a', title: '重复的' }),
      event({ id: 'b', title: '第二条' }),
    ])
    expect(result).toHaveLength(2)
    expect(result.map(item => item.id)).toEqual(['a', 'b'])
    // 保留的是**第一次**出现的那条
    expect(result[0]!.title).toBe('第一条')
  })

  it('puts the newest event first', () => {
    const result = dedupeEvents([
      event({ id: 'old', time: '2026-10-21T03:00:00Z' }),
      event({ id: 'new', time: '2026-10-22T03:00:00Z' }),
    ])
    expect(result.map(item => item.id)).toEqual(['new', 'old'])
  })

  it('drops entries without a usable id', () => {
    const result = dedupeEvents([
      event({ id: '' }),
      event({ id: 'ok' }),
      null as unknown as CityEvent,
    ])
    expect(result.map(item => item.id)).toEqual(['ok'])
  })

  it('tolerates a missing list', () => {
    expect(dedupeEvents(null)).toEqual([])
    expect(dedupeEvents(undefined)).toEqual([])
  })
})

describe('formatEventTime', () => {
  it('renders the local time of an ISO timestamp', () => {
    // 自己按 getHours()/getMinutes() 拼，不用 toLocaleTimeString
    const formatted = formatEventTime('2026-10-22T03:00:00Z')
    expect(formatted).toMatch(/^\d{2}:\d{2}$/)
  })

  it('returns null for values it cannot read', () => {
    expect(formatEventTime(undefined)).toBeNull()
    expect(formatEventTime('')).toBeNull()
    expect(formatEventTime('not a date')).toBeNull()
  })
})

describe('explainEmptyEvents', () => {
  it('says why there is no event instead of inventing one', () => {
    const text = explainEmptyEvents(
      overview({
        metrics: [
          {
            key: 'aqi',
            label: '空气质量',
            value: 58,
            level: 2,
            level_label: '良',
            source: SOURCE,
          },
          {
            key: 'road_load_index',
            label: '路网负载（模型估算）',
            value: 63.5,
            unit: '指数',
            source: SOURCE,
          },
          {
            key: 'weather_temp',
            label: '气温',
            value: 18,
            unit: '℃',
            source: SOURCE,
          },
        ],
        series: [
          {
            key: 'aqi_24h',
            label: '24 小时 AQI',
            unit: 'AQI',
            points: [
              { t: '2026-10-22T00:00:00Z', v: 30 },
              { t: '2026-10-22T01:00:00Z', v: 40 },
              { t: '2026-10-22T02:00:00Z', v: 45 },
            ],
            source: SOURCE,
          },
        ],
      }),
    )
    expect(text).toContain('当前无触发事件')
    // 每条规则都说了「为什么没触发」
    expect(text).toContain('AQI 等级未变化')
    expect(text).toContain('低于告警线 3')
    expect(text).toContain('路网负载 63.5 低于阈值 80')
    expect(text).toContain('气温 18℃')
  })

  it('reports a degraded source instead of pretending it read a value', () => {
    const text = explainEmptyEvents(
      overview({
        metrics: [
          {
            key: 'aqi',
            label: '空气质量',
            value: null,
            source: SOURCE,
          },
        ],
      }),
    )
    expect(text).toContain('空气质量源暂不可用')
    expect(text).not.toContain('0')
  })

  it('mentions the AQI change when the series actually changed', () => {
    const text = explainEmptyEvents(
      overview({
        series: [
          {
            key: 'aqi_24h',
            label: '24 小时 AQI',
            points: [
              { t: '2026-10-22T00:00:00Z', v: 30 },
              { t: '2026-10-22T01:00:00Z', v: 120 },
            ],
            source: SOURCE,
          },
        ],
      }),
    )
    expect(text).not.toContain('AQI 等级未变化')
  })

  it('waits for the overview before saying anything', () => {
    expect(explainEmptyEvents(null)).toContain('正在获取')
  })
})
