import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { defineComponent, h, isReactive } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { useCityData } from '@/composables/useCityData'
import { ApiError } from '@/api/client'

const originalFetch = globalThis.fetch

/** 城市指标端点的一份最小载荷。 */
const overviewPayload = {
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
      extra: {},
      source: {
        name: 'Open-Meteo 空气质量（CAMS 模型再分析）',
        url: 'https://air-quality-api.open-meteo.com/v1/air-quality',
        observed_at: '2026-10-22T04:00:00Z',
        fetched_at: '2026-10-22T04:30:00Z',
        realtime: true,
        estimated: false,
      },
    },
  ],
  series: [],
  degraded: [],
}

/** 本文件里的 fetch 桩。 */
let fetchMock: Mock<typeof fetch>

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>()
  globalThis.fetch = fetchMock
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// 挂载一个测试组件来跑 composable（composable 里有 onUnmounted，
// 必须在组件上下文里注册才生效）。
// 返回值里带上 wrapper：取消分支需要在请求还在飞的时候把组件卸载掉。
const withSetup = <T extends object>(composable: () => T) => {
  let result: T | undefined
  const wrapper = mount(defineComponent({
    setup() {
      result = composable()
      return () => h('div')
    },
  }))
  if (!result) throw new Error('composable 没有返回结果')
  return { ...result, wrapper }
}

describe('useCityData', () => {
  it('loadAll populates refs and clears error on success', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'normal' }), { status: 200 }))

    const { buildings, roads, trafficStatus, error, loadAll } = withSetup(useCityData)
    await loadAll()

    expect(buildings.value).toEqual({ type: 'FeatureCollection', features: [] })
    expect(roads.value).toEqual({ type: 'FeatureCollection', features: [] })
    expect(trafficStatus.value).toEqual({ status: 'normal' })
    expect(error.value).toBeNull()
  })

  it('loadAll sets error on failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const { buildings, error, loadAll } = withSetup(useCityData)
    await loadAll()
    expect(buildings.value).toBeNull()
    expect(error.value).toBeInstanceOf(ApiError)
  })

  it('loadAll stores the GeoJSON payload without deep reactivity', async () => {
    // 几 MB 的载荷如果被 Vue 深度响应式包装，遍历代价会高出一个数量级。
    // 载荷是整体替换的，用 shallowRef 即可：模板只需要知道「数据到了」。
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'normal' }), { status: 200 }))

    const { buildings, roads, loadAll } = withSetup(useCityData)
    await loadAll()

    expect(buildings.value).not.toBeNull()
    // isReactive 只接受对象；载荷为 null 时用空对象占位——null 本身也不是响应式对象。
    expect(isReactive(buildings.value ?? {})).toBe(false)
    expect(isReactive(roads.value ?? {})).toBe(false)
  })

  it('loadAll requests the full collections without a bbox by default', async () => {
    // 默认 bbox 与 OSM 提取范围完全一致，过滤是空转；
    // 不带 bbox 直接取完整集合，请求更便宜。
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'normal' }), { status: 200 }))

    const { loadAll } = withSetup(useCityData)
    await loadAll()

    const urls = fetchMock.mock.calls.map(call => call[0])
    expect(urls).toContain('/api/buildings')
    expect(urls).toContain('/api/roads')
  })

  it('loadAll still supports an explicit bbox', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'normal' }), { status: 200 }))

    const { loadAll } = withSetup(useCityData)
    await loadAll({ bbox: '2.1474,41.3945,2.1874,41.4145' })

    const urls = fetchMock.mock.calls.map(call => call[0])
    expect(urls).toContain('/api/buildings?bbox=2.1474%2C41.3945%2C2.1874%2C41.4145')
  })

  it('does not touch the refs when the component unmounts while the request is in flight', async () => {
    // 请求一直悬着，等组件卸载之后才回来。
    const resolvers: Array<(response: Response) => void> = []
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => {
      resolvers.push(resolve)
    }))

    const { buildings, roads, trafficStatus, error, loadAll, wrapper } = withSetup(useCityData)
    const pending = loadAll()
    await flushPromises()

    // 三个请求都已经发出去了，但都还没回来
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(resolvers).toHaveLength(3)

    // 组件卸载 → composable 的 onUnmounted 把 cancelled 置为 true
    wrapper.unmount()

    // 请求这时才回来
    resolvers.forEach((resolve) => {
      resolve(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }))
    })
    await pending

    // 卸载之后不应再写入任何 ref（cancelled 分支短路）
    expect(buildings.value).toBeNull()
    expect(roads.value).toBeNull()
    expect(trafficStatus.value).toBeNull()
    expect(error.value).toBeNull()
  })

  it('loadCityOverview stores the overview payload', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(overviewPayload), { status: 200 }))

    const { cityOverview, cityOverviewError, loadCityOverview } = withSetup(useCityData)
    await loadCityOverview()

    expect(cityOverview.value?.metrics).toHaveLength(1)
    expect(cityOverview.value?.metrics[0].source.name).toBe('Open-Meteo 空气质量（CAMS 模型再分析）')
    expect(cityOverviewError.value).toBeNull()
    const urls = fetchMock.mock.calls.map(call => call[0])
    expect(urls).toContain('/api/city/overview?city=barcelona')
  })

  it('loadCityOverview records its own error without failing the whole scene', async () => {
    // 城市指标走外部上游，挂了只影响指标带 —— 3D 城市本身还是好的，
    // 所以不能把它塞进全局 error 横幅。
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    const { cityOverview, cityOverviewError, error, loadCityOverview } = withSetup(useCityData)
    await loadCityOverview()

    expect(cityOverview.value).toBeNull()
    expect(cityOverviewError.value).toBeInstanceOf(ApiError)
    expect(error.value).toBeNull()
  })

  it('refreshCityOverview keeps the previous reading when the request fails', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(overviewPayload), { status: 200 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))

    const { cityOverview, refreshCityOverview } = withSetup(useCityData)
    await refreshCityOverview()
    expect(cityOverview.value).not.toBeNull()

    // 轮询失败时保留上一次的读数（拿旧值冒充新值是不行的，但也别清空）
    await refreshCityOverview()
    expect(cityOverview.value).not.toBeNull()
  })
})
