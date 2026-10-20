import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, isReactive } from 'vue'
import { mount } from '@vue/test-utils'
import { useCityData } from '@/composables/useCityData'
import { ApiError } from '@/api/client'

const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

const withSetup = (composable) => {
  let result
  mount(defineComponent({
    setup() {
      result = composable()
      return () => h('div')
    },
  }))
  return result
}

describe('useCityData', () => {
  it('loadAll populates refs and clears error on success', async () => {
    globalThis.fetch
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
    globalThis.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
    const { buildings, error, loadAll } = withSetup(useCityData)
    await loadAll()
    expect(buildings.value).toBeNull()
    expect(error.value).toBeInstanceOf(ApiError)
  })

  it('loadAll stores the GeoJSON payload without deep reactivity', async () => {
    // 几 MB 的载荷如果被 Vue 深度响应式包装，遍历代价会高出一个数量级。
    // 载荷是整体替换的，用 shallowRef 即可：模板只需要知道「数据到了」。
    globalThis.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'normal' }), { status: 200 }))

    const { buildings, roads, loadAll } = withSetup(useCityData)
    await loadAll()

    expect(buildings.value).not.toBeNull()
    expect(isReactive(buildings.value)).toBe(false)
    expect(isReactive(roads.value)).toBe(false)
  })

  it('loadAll requests the full collections without a bbox by default', async () => {
    // 默认 bbox 与 OSM 提取范围完全一致，过滤是空转；
    // 不带 bbox 直接取完整集合，请求更便宜。
    globalThis.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'normal' }), { status: 200 }))

    const { loadAll } = withSetup(useCityData)
    await loadAll()

    const urls = globalThis.fetch.mock.calls.map(call => call[0])
    expect(urls).toContain('/api/buildings')
    expect(urls).toContain('/api/roads')
  })

  it('loadAll still supports an explicit bbox', async () => {
    globalThis.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'normal' }), { status: 200 }))

    const { loadAll } = withSetup(useCityData)
    await loadAll({ bbox: '116.380,39.905,116.420,39.925' })

    const urls = globalThis.fetch.mock.calls.map(call => call[0])
    expect(urls).toContain('/api/buildings?bbox=116.380%2C39.905%2C116.420%2C39.925')
  })
})