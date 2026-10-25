import { describe, it, expect } from 'vitest'
import { parseWeatherEffect } from '../useWeather'
import type { CityOverview, Metric } from '../../../types/city'

const metric = (key: string, value: number, extra?: Record<string, unknown>): Metric =>
  ({
    key,
    label: key,
    value,
    unit: '',
    extra,
    source: { name: 'test', url: '' },
  }) as unknown as Metric

const overview = (metrics: Metric[]): CityOverview =>
  ({
    city: { id: 'barcelona', name: '巴塞罗那' },
    metrics,
    series: [],
    sources: [],
  }) as unknown as CityOverview

describe('parseWeatherEffect —— 天气 → 场景强度', () => {
  it('没有数据就什么都不做（不拿 0 冒充「无雨」）', () => {
    const effect = parseWeatherEffect(null)
    expect(effect.rain).toBe(0)
    expect(effect.snow).toBe(0)
    expect(effect.fog).toBe(0)
  })

  it('有降水且气温高于 1℃ → 下雨', () => {
    const effect = parseWeatherEffect(
      overview([
        metric('weather_temp', 18, { precipitation: 4 }),
        metric('weather_humidity', 70),
      ]),
    )
    expect(effect.rain).toBeCloseTo(0.4, 5)
    expect(effect.snow).toBe(0)
    expect(effect.wet).toBeGreaterThan(0)
  })

  it('有降水且气温 ≤ 1℃ → 下雪', () => {
    const effect = parseWeatherEffect(
      overview([
        metric('weather_temp', -1, { precipitation: 2 }),
        metric('weather_humidity', 80),
      ]),
    )
    expect(effect.snow).toBeGreaterThan(0)
    expect(effect.rain).toBe(0)
  })

  it('湿度很高 → 有雾', () => {
    const effect = parseWeatherEffect(
      overview([metric('weather_temp', 12), metric('weather_humidity', 95)]),
    )
    expect(effect.fog).toBeGreaterThan(0.5)
  })

  it('湿度低、无降水 → 晴天', () => {
    const effect = parseWeatherEffect(
      overview([metric('weather_temp', 22), metric('weather_humidity', 40)]),
    )
    expect(effect.rain).toBe(0)
    expect(effect.snow).toBe(0)
    expect(effect.fog).toBe(0)
  })
})
