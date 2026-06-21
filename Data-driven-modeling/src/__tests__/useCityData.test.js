import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h } from 'vue'
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
})