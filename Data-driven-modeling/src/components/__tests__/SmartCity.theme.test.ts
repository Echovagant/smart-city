import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import type { ThemeDefinition, ThemeOverrides } from '@/theme/themes/types'

/**
 * 主题 → 3D 场景的接线断言。
 *
 * 两个依赖都换成假实现：
 * - 主题状态 —— 这里只要能改主题 / 覆盖；
 * - 场景底座 —— 换成一份带 `applyTheme` 探针的假底座，
 *   免得为了断言「换色被调用」而把整个 Cesium 场景跑起来。
 */
vi.mock('cesium', async () => {
  const { createCesiumStub } = await import('../../composables/__tests__/cesiumStub')
  return createCesiumStub()
})

interface ThemeControllerMock {
  themeId: { value: string }
  overrides: { value: ThemeOverrides }
  theme: { value: ThemeDefinition }
}
const themeMock = vi.hoisted(() => ({
  setTheme: vi.fn(),
  setOverride: vi.fn(),
  resetOverrides: vi.fn(),
  controller: null as ThemeControllerMock | null,
}))

vi.mock('@/composables/useTheme', async () => {
  const { computed, ref } = await import('vue')
  const { resolveTheme } = await import('@/theme/themes')
  // **模块级单例**：真实的 useTheme 就是单例 —— 生产里有三个调用点
  // （SmartCity / useSceneLinkageEffect / useEventMarkers），共用同一份状态。
  // mock 若每次调用新建一份，测试改到的那份就不是组件在 watch 的那份 →
  // watcher 收不到通知，断言「换主题后重新换色」会假失败。
  const themeId = ref('deep-space')
  const overrides = ref<ThemeOverrides>({})
  const theme = computed(() => resolveTheme(themeId.value, overrides.value))
  const controller = {
    themeId,
    overrides,
    theme,
    setTheme: (id: string) => {
      themeMock.setTheme(id)
      themeId.value = id
    },
    setOverride: (key: keyof ThemeOverrides, value: string | number | undefined) => {
      themeMock.setOverride(key, value)
      overrides.value = { ...overrides.value, [key]: value }
    },
    resetOverrides: () => {
      themeMock.resetOverrides()
      overrides.value = {}
    },
  }
  themeMock.controller = controller as unknown as ThemeControllerMock
  return { useTheme: () => controller }
})

/** 假场景底座：`applyTheme` 是这次要盯的那根线。 */
const stageMock = vi.hoisted(() => ({
  applyTheme: vi.fn(),
}))

vi.mock('@/composables/useSceneStage', async importOriginal => {
  const actual = await importOriginal<typeof import('@/composables/useSceneStage')>()
  const { reactive, ref } = await import('vue')
  const fakeStage = {
    viewer: ref(null),
    mounted: ref(true),
    state: reactive({
      viewMode: 'overhead',
      buildingVisible: true,
      roadVisible: true,
      trafficVisible: true,
      buildingEntities: [] as unknown[],
      roadEntities: [] as unknown[],
      trafficEntities: [] as unknown[],
    }),
    primitives: {},
    initCesium: vi.fn(async () => undefined),
    optimizePerformance: vi.fn(),
    loadGeoJSONBuildings: vi.fn(async () => undefined),
    loadGeoJSONRoads: vi.fn(async () => undefined),
    createBaseGrid: vi.fn(),
    toggleBuildings: vi.fn(),
    toggleRoads: vi.fn(),
    destroyViewer: vi.fn(),
    applyTheme: stageMock.applyTheme,
  }
  return { ...actual, useSceneStage: () => fakeStage }
})

import SmartCity from '../SmartCity.vue'

/* ---------------------------------------------------------------------------
 * 后端接口的最小桩
 * ------------------------------------------------------------------------- */

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const OVERVIEW = {
  city: { id: 'barcelona', name: '巴塞罗那', latitude: 41.39585, longitude: 2.1652, timezone: 'Europe/Madrid' },
  generated_at: '2026-10-22T04:00:00Z',
  metrics: [],
  series: [],
  facilities: [],
  degraded: [],
}

const installFetch = () => {
  globalThis.fetch = vi.fn((url: string) => {
    const target = String(url)
    if (target.includes('traffic-status')) return Promise.resolve(jsonResponse({ status: 'normal' }))
    if (target.includes('city/overview')) return Promise.resolve(jsonResponse(OVERVIEW))
    return Promise.resolve(jsonResponse({ type: 'FeatureCollection', features: [] }))
  }) as unknown as typeof fetch
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  vi.clearAllMocks()
  // 复位**单例的状态**，而不是把 controller 置空 ——
  // mock 里只有这一份，置空就等于把测试与组件之间的联系切断了。
  const controller = themeMock.controller
  if (controller) {
    controller.themeId.value = 'deep-space'
    controller.overrides.value = {}
  }
  installFetch()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('SmartCity theme wiring', () => {
  it('applies the theme to the scene on the first mount', () => {
    const wrapper = mount(SmartCity, { attachTo: document.body })

    expect(stageMock.applyTheme).toHaveBeenCalled()
    const applied = stageMock.applyTheme.mock.calls[0][0] as ThemeDefinition
    expect(applied.id).toBe('deep-space')

    wrapper.unmount()
  })

  it('re-applies the theme to the scene when the theme changes', async () => {
    const wrapper = mount(SmartCity, { attachTo: document.body })
    stageMock.applyTheme.mockClear()

    themeMock.controller!.themeId.value = 'graphite'
    await nextTick()

    expect(stageMock.applyTheme).toHaveBeenCalledTimes(1)
    const applied = stageMock.applyTheme.mock.calls[0][0] as ThemeDefinition
    expect(applied.id).toBe('graphite')

    wrapper.unmount()
  })

  it('re-applies the theme when the user changes an override', async () => {
    const wrapper = mount(SmartCity, { attachTo: document.body })
    stageMock.applyTheme.mockClear()

    themeMock.controller!.overrides.value = { roadMain: '#3b82f6' }
    await nextTick()

    expect(stageMock.applyTheme).toHaveBeenCalledTimes(1)
    const applied = stageMock.applyTheme.mock.calls[0][0] as ThemeDefinition
    expect(applied.roadColors.main).toBe('#3b82f6')

    wrapper.unmount()
  })

  it('opens and closes the theme panel from the control panel', async () => {
    const wrapper = mount(SmartCity, { attachTo: document.body })

    // 控制面板里多了一个「主题」入口（4 个开关按钮 + 1 个天气按钮 + 1 个主题入口）
    const buttons = wrapper.findAll('.control-panel button')
    expect(buttons).toHaveLength(6)
    expect(buttons[4].text()).toContain('主题')

    expect(wrapper.find('.dc-theme-picker').exists()).toBe(false)
    await buttons[4].trigger('click')
    expect(wrapper.find('.dc-theme-picker').exists()).toBe(true)

    // 主题面板自己的按钮**不进**控制面板的按钮集合（DOM 契约要稳）
    expect(wrapper.findAll('.control-panel button')).toHaveLength(6)

    await wrapper.find('.control-panel-theme').trigger('click')
    expect(wrapper.find('.dc-theme-picker').exists()).toBe(false)

    wrapper.unmount()
  })
})
