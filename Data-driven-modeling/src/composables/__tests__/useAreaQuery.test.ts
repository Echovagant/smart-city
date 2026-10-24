import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { defineComponent, h, reactive, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('cesium', async () => {
  const { createCesiumStub } = await import('./cesiumStub')
  const stub = createCesiumStub()
  return {
    ...stub,
    // 拾取要用：笛卡尔坐标 → 经纬度（弧度）。
    Cartographic: {
      fromCartesian: (cartesian: { lng: number; lat: number }) =>
        cartesian && Number.isFinite(cartesian.lng)
          ? { longitude: cartesian.lng, latitude: cartesian.lat }
          : null,
    },
    Math: {
      toDegrees: (radians: number) => (radians * 180) / Math.PI,
    },
  }
})

import {
  AREA_RADIUS_OPTIONS,
  DEFAULT_AREA_RADIUS_M,
  areaErrorDetail,
  areaErrorText,
  buildAreaBBox,
  formatAreaBBox,
  useAreaQuery,
} from '../useAreaQuery'
import { getCesiumStub } from './cesiumStub'
import { ApiError } from '@/api/client'
import type { SceneStage } from '../useSceneStage'
import type { AreaStats } from '../../../types/city'

const stub = () => getCesiumStub()
const originalFetch = globalThis.fetch

/** fetch 桩。 */
let fetchMock: Mock<typeof fetch>

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock = vi.fn<typeof fetch>()
  globalThis.fetch = fetchMock
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** 一份区域统计载荷（形状与后端 `/api/city/area` 一致）。 */
const areaPayload = (): AreaStats => ({
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
  facility_categories: [],
  building_density_per_km2: 730.353,
  source: {
    name: 'OpenStreetMap 本地快照',
    url: 'backend-python/geojson/',
    observed_at: '2026-06-21T11:37:06Z',
    fetched_at: '2026-10-23T10:04:48Z',
    realtime: false,
    estimated: false,
  },
  method: {},
})

/** 让 fetch 成功返回一份载荷。 */
const respondWith = (payload: unknown = areaPayload()): void => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }))
}

/** 让 fetch 返回一个错误状态。 */
const respondWithStatus = (status: number, detail = '出错了'): void => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ detail }), { status, statusText: 'Error' }),
  )
}

/** 挂一个测试组件来跑 composable（composable 里有 onUnmounted）。 */
const withSetup = <T extends object>(composable: () => T) => {
  let result: T | undefined
  const wrapper = mount(
    defineComponent({
      setup() {
        result = composable()
        return () => h('div')
      },
    }),
  )
  if (!result) throw new Error('composable 没有返回结果')
  return { ...result, wrapper }
}

/** 一个假的场景底座：只有 viewer 是真的（拾取只用到它）。 */
const makeStage = (viewer: unknown): SceneStage =>
  ({ viewer: ref(viewer) }) as unknown as SceneStage

/** 假的 viewer：命中点由 `picked` 决定。 */
interface FakeViewer {
  canvas: HTMLCanvasElement
  camera: {
    getPickRay: Mock<() => unknown>
    pickEllipsoid: Mock<() => unknown>
  }
  scene: {
    globe: { pick: Mock<() => unknown>; ellipsoid: object }
  }
}

const makeViewer = (picked: unknown): FakeViewer => ({
  canvas: document.createElement('canvas'),
  camera: {
    getPickRay: vi.fn(() => ({ origin: {}, direction: {} })),
    pickEllipsoid: vi.fn(() => undefined),
  },
  scene: {
    globe: {
      pick: vi.fn(() => picked),
      ellipsoid: {},
    },
  },
})
/** 取最近一次装上的点击监听器里的动作。 */
const lastPickAction = (): ((movement: { position: unknown }) => void) | undefined => {
  const results = stub().ScreenSpaceEventHandler.mock.results
  const handler = results[results.length - 1]?.value as
    | { setInputAction: Mock }
    | undefined
  return handler?.setInputAction.mock.calls[0]?.[0] as (
    movement: { position: unknown },
  ) => void
}

/** 命中点（度 → 弧度，Cesium 的经纬度是弧度）。 */
const PICKED_LNG_DEG = 2.165
const PICKED_LAT_DEG = 41.395
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180
const pickedCartesian = () => ({
  lng: toRadians(PICKED_LNG_DEG),
  lat: toRadians(PICKED_LAT_DEG),
})

/* ---------------------------------------------------------------------------
 * 纯函数：范围换算
 * ------------------------------------------------------------------------- */

describe('buildAreaBBox / formatAreaBBox', () => {
  it('以中心点为对称中心，纬向跨度按 111 320 m/度换算', () => {
    const bbox = buildAreaBBox({ lng: 2.1674, lat: 41.3895 }, 300)!
    expect(bbox).not.toBeNull()
    const halfLat = 300 / 111320
    expect(bbox.north - 41.3895).toBeCloseTo(halfLat, 9)
    expect(bbox.south).toBeCloseTo(41.3895 - halfLat, 9)
    // 中心点落在范围正中
    expect((bbox.north + bbox.south) / 2).toBeCloseTo(41.3895, 9)
    expect((bbox.east + bbox.west) / 2).toBeCloseTo(2.1674, 9)
  })

  it('经向跨度按 cos(纬度) 修正：高纬度处经度一度比纬度一度短', () => {
    const bbox = buildAreaBBox({ lng: 2.1674, lat: 41.3895 }, 300)!
    const halfLng = 300 / (111320 * Math.cos((41.3895 * Math.PI) / 180))
    expect(bbox.east - 2.1674).toBeCloseTo(halfLng, 9)
    // 经度跨度比纬度跨度大（同样的米数，经度方向要多走一点）
    expect(bbox.east - bbox.west).toBeGreaterThan(bbox.north - bbox.south)
  })

  it('中心点或半径不合法时返回 null', () => {
    expect(buildAreaBBox({ lng: Number.NaN, lat: 41.3895 }, 300)).toBeNull()
    expect(buildAreaBBox({ lng: 2.1674, lat: Number.POSITIVE_INFINITY }, 300)).toBeNull()
    expect(buildAreaBBox({ lng: 2.1674, lat: 41.3895 }, 0)).toBeNull()
    expect(buildAreaBBox({ lng: 2.1674, lat: 41.3895 }, -100)).toBeNull()
  })

  it('查询串是四个数、保留 6 位小数', () => {
    const text = formatAreaBBox({ west: 2.1674, south: 41.3895, east: 2.1774, north: 41.3995 })
    expect(text).toBe('2.167400,41.389500,2.177400,41.399500')
    expect(text.split(',')).toHaveLength(4)
  })
})

/* ---------------------------------------------------------------------------
 * useAreaQuery：取数
 * ------------------------------------------------------------------------- */

describe('useAreaQuery', () => {
  it('默认半径是 300 m，半径档位是 200 / 300 / 500', () => {
    expect(AREA_RADIUS_OPTIONS).toEqual([200, 300, 500])
    const { radiusM } = withSetup(() => useAreaQuery())
    expect(radiusM.value).toBe(DEFAULT_AREA_RADIUS_M)
    expect(radiusM.value).toBe(300)
  })

  it('pickAt 会按中心点 + 半径请求区域统计，并把结果放进 stats', async () => {
    respondWith()
    const { center, stats, loading, error, pickAt } = withSetup(() => useAreaQuery())

    expect(loading.value).toBe(false)
    const pending = pickAt(2.1652, 41.39585)
    expect(loading.value).toBe(true)
    await pending
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url.startsWith('/api/city/area?bbox=')).toBe(true)
    const bbox = decodeURIComponent(url.split('bbox=')[1]!).split(',').map(Number)
    expect(bbox).toHaveLength(4)
    expect(bbox[0]).toBeLessThan(2.1652)
    expect(bbox[1]).toBeLessThan(41.39585)
    expect(bbox[2]).toBeGreaterThan(2.1652)
    expect(bbox[3]).toBeGreaterThan(41.39585)

    expect(center.value).toEqual({ lng: 2.1652, lat: 41.39585 })
    expect(stats.value?.building_count).toBe(1039)
    expect(stats.value?.road_length_km).toBe(54.4386)
    expect(loading.value).toBe(false)
    expect(error.value).toBeNull()
  })

  it('取数失败时显示「数据源暂不可用」，不显示 0', async () => {
    respondWithStatus(503, '城市数据暂时不可用，请稍后重试')
    const { stats, error, errorDetail, pickAt } = withSetup(() => useAreaQuery())
    await pickAt(2.1674, 41.3895)
    await flushPromises()

    expect(stats.value).toBeNull()
    expect(error.value).toBe('数据源暂不可用')
    expect(errorDetail.value).toContain('503')
  })

  it('网络错误与非法范围各有各的说法', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'))
    const { error, pickAt } = withSetup(() => useAreaQuery())
    await pickAt(2.1674, 41.3895)
    await flushPromises()
    expect(error.value).toBe('数据源暂不可用')

    respondWithStatus(400, 'bbox 参数不合法')
    const second = withSetup(() => useAreaQuery())
    await second.pickAt(2.1674, 41.3895)
    await flushPromises()
    expect(second.error.value).toBe('范围参数无效')
  })

  it('换半径会按新半径重查同一片范围', async () => {
    respondWith()
    const { radiusM, setRadius, pickAt } = withSetup(() => useAreaQuery())
    await pickAt(2.1674, 41.3895)
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const first = decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]))

    await setRadius(500)
    await flushPromises()
    expect(radiusM.value).toBe(500)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const second = decodeURIComponent(String(fetchMock.mock.calls[1]?.[0]))
    // 同一个中心点，半径更大 → 范围更大
    expect(second).not.toBe(first)
  })

  it('还没选区域时换半径不发请求', async () => {
    const { radiusM, setRadius } = withSetup(() => useAreaQuery())
    await setRadius(200)
    await flushPromises()
    expect(radiusM.value).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('不在允许档位里的半径会被忽略', async () => {
    const { radiusM, setRadius } = withSetup(() => useAreaQuery())
    await setRadius(123)
    await flushPromises()
    expect(radiusM.value).toBe(300)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('clear 会清掉选区与结果', async () => {
    respondWith()
    const { center, stats, clear, pickAt } = withSetup(() => useAreaQuery())
    await pickAt(2.1674, 41.3895)
    await flushPromises()
    expect(stats.value).not.toBeNull()

    clear()
    expect(center.value).toBeNull()
    expect(stats.value).toBeNull()
  })

  it('后发起的请求作废前一个的结果', async () => {
    let resolveFirst: ((value: Response) => void) | undefined
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>(resolve => {
            resolveFirst = resolve
          }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(areaPayload()), { status: 200 }))

    const { stats, pickAt } = withSetup(() => useAreaQuery())
    const first = pickAt(2.1674, 41.3895)
    const second = pickAt(2.2674, 41.4395)
    await second
    await flushPromises()
    // 第一个请求这时才回来 —— 结果必须被丢掉
    resolveFirst?.(new Response(JSON.stringify({ ...areaPayload(), building_count: 1 }), { status: 200 }))
    await first
    await flushPromises()

    expect(stats.value?.building_count).toBe(1039)
  })
})

/* ---------------------------------------------------------------------------
 * useAreaQuery：拾取
 * ------------------------------------------------------------------------- */

describe('areaErrorText / areaErrorDetail', () => {
  it('按状态码给人话', () => {
    expect(areaErrorText(new ApiError('x', { status: 400 }))).toBe('范围参数无效')
    expect(areaErrorText(new ApiError('x', { status: 503 }))).toBe('数据源暂不可用')
    expect(areaErrorText(new ApiError('x', { status: 0 }))).toBe('数据源暂不可用')
    expect(areaErrorText(new ApiError('x', { status: 500 }))).toBe('区域统计取不到')
    // 不是接口错误时也不编一个具体原因
    expect(areaErrorText(new Error('boom'))).toBe('区域统计取不到')
  })

  it('原始信息带上状态码；没有状态码就只给消息', () => {
    expect(areaErrorDetail(new ApiError('HTTP 503', { status: 503 }))).toBe('HTTP 503（状态码 503）')
    expect(areaErrorDetail(new ApiError('超时', { status: 0 }))).toBe('超时')
    expect(areaErrorDetail(new Error('boom'))).toBe('Error: boom')
  })
})

describe('useAreaQuery 的拾取', () => {
  it('没有场景底座就不装拾取监听（界面会直说「场景底座未就绪」）', () => {
    withSetup(() => useAreaQuery())
    expect(stub().ScreenSpaceEventHandler).not.toHaveBeenCalled()
  })

  it('点一下地面会按命中点的经纬度去查那片范围', async () => {
    respondWith()
    const viewer = makeViewer(pickedCartesian())
    const { stats } = withSetup(() => useAreaQuery({ stage: makeStage(viewer) }))

    // 场景底座一挂上，点击监听就装好了
    expect(stub().ScreenSpaceEventHandler).toHaveBeenCalledTimes(1)
    const action = lastPickAction()
    expect(action).toBeTypeOf('function')
    action?.({ position: { x: 10, y: 20 } })
    await flushPromises()

    const url = decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]))
    const bbox = url.split('bbox=')[1]!.split(',').map(Number)
    // 命中点（弧度）换成度，落在范围中心
    expect((bbox[0] + bbox[2]) / 2).toBeCloseTo(PICKED_LNG_DEG, 3)
    expect((bbox[1] + bbox[3]) / 2).toBeCloseTo(PICKED_LAT_DEG, 3)
    expect(stats.value?.building_count).toBe(1039)
  })

  it('点到天空（没命中地面）时清掉选区并给出提示', async () => {
    respondWith()
    const viewer = makeViewer(undefined)
    const { center, stats, hint, pickAt } = withSetup(() =>
      useAreaQuery({ stage: makeStage(viewer) }),
    )

    await pickAt(2.1674, 41.3895)
    await flushPromises()
    expect(stats.value).not.toBeNull()

    lastPickAction()?.({ position: { x: 10, y: 20 } })
    await flushPromises()

    expect(center.value).toBeNull()
    expect(stats.value).toBeNull()
    expect(hint.value).toBe('刚才点到了天空，请点地面上的位置')
  })

  it('Esc 收起当前选区', async () => {
    respondWith()
    const { center, stats, pickAt } = withSetup(() => useAreaQuery())
    await pickAt(2.1674, 41.3895)
    await flushPromises()
    expect(stats.value).not.toBeNull()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(center.value).toBeNull()
    expect(stats.value).toBeNull()
  })

  it('底座经过深响应式代理传进来时，viewer 引用仍找得到（ref 被解包也不怕）', () => {
    const viewer = makeViewer(pickedCartesian())
    // 深响应式对象上 Vue 会**解包 ref**：stage.viewer 拿回来是 null 而不是那个 Ref。
    // 组件 props 在测试工具里就是深响应式的，所以这条路径必须走通。
    const stage = reactive(makeStage(viewer)) as unknown as SceneStage
    withSetup(() => useAreaQuery({ stage }))
    expect(stub().ScreenSpaceEventHandler).toHaveBeenCalledTimes(1)
  })

  it('场景底座换掉时，旧的点击监听会被摘掉', async () => {
    const viewer = makeViewer(pickedCartesian())
    const { attachStage } = withSetup(() => useAreaQuery({ stage: makeStage(viewer) }))
    expect(stub().ScreenSpaceEventHandler).toHaveBeenCalledTimes(1)

    attachStage(null)
    expect(stub().ScreenSpaceEventHandler).toHaveBeenCalledTimes(1)
    const handler = stub().ScreenSpaceEventHandler.mock.results[0]?.value as {
      destroy: Mock
    }
    expect(handler.destroy).toHaveBeenCalled()
  })

  it('组件卸载后不再监听，也不再写状态', async () => {
    respondWith()
    const viewer = makeViewer(pickedCartesian())
    const { wrapper, pickAt } = withSetup(() => useAreaQuery({ stage: makeStage(viewer) }))
    await pickAt(2.1674, 41.3895)
    await flushPromises()
    wrapper.unmount()
    const handler = stub().ScreenSpaceEventHandler.mock.results[0]?.value as {
      destroy: Mock
    }
    expect(handler.destroy).toHaveBeenCalled()
  })

  it('卸载之后回来的响应与报错都不再写状态', async () => {
    let resolvePending: ((value: Response) => void) | undefined
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>(resolve => {
          resolvePending = resolve
        }),
    )
    const { wrapper, stats, error, pickAt } = withSetup(() => useAreaQuery())
    const pending = pickAt(2.1674, 41.3895)
    wrapper.unmount()
    resolvePending?.(new Response(JSON.stringify(areaPayload()), { status: 200 }))
    await pending
    await flushPromises()
    expect(stats.value).toBeNull()
    expect(error.value).toBeNull()

    // 报错的那一路同样不再写状态
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('network down')))
    const second = withSetup(() => useAreaQuery())
    const failing = second.pickAt(2.2674, 41.4395)
    second.wrapper.unmount()
    await failing
    await flushPromises()
    expect(second.error.value).toBeNull()
  })

  it('半径被改成非法值时不发请求，直接说范围参数无效', async () => {
    const { radiusM, error, errorDetail, pickAt } = withSetup(() => useAreaQuery())
    radiusM.value = 0
    await pickAt(2.1674, 41.3895)
    await flushPromises()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(error.value).toBe('范围参数无效')
    expect(errorDetail.value).toBe('中心点或半径不合法')
  })

  it('底座被摘掉之后，点选动作不再有任何反应', async () => {
    const viewer = makeViewer(pickedCartesian())
    const { attachStage } = withSetup(() => useAreaQuery({ stage: makeStage(viewer) }))
    const action = lastPickAction()
    attachStage(null)
    action?.({ position: { x: 10, y: 20 } })
    await flushPromises()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('地面没渲染出来时退回到椭球面求交', async () => {
    respondWith()
    const viewer = makeViewer(undefined)
    // 射线取不到（相机没给出射线），但椭球面能取到
    viewer.camera.getPickRay = vi.fn(() => undefined)
    viewer.camera.pickEllipsoid = vi.fn(() => pickedCartesian())
    const { stats } = withSetup(() => useAreaQuery({ stage: makeStage(viewer) }))

    lastPickAction()?.({ position: { x: 10, y: 20 } })
    await flushPromises()
    expect(stats.value?.building_count).toBe(1039)
  })

  it('命中点换不成经纬度时清掉选区并给出提示', async () => {
    respondWith()
    // 换不出经纬度的命中点
    const viewer = makeViewer({ lng: Number.NaN, lat: 0 })
    const { center, stats, hint, pickAt } = withSetup(() =>
      useAreaQuery({ stage: makeStage(viewer) }),
    )
    await pickAt(2.1674, 41.3895)
    await flushPromises()
    expect(stats.value).not.toBeNull()

    lastPickAction()?.({ position: { x: 10, y: 20 } })
    await flushPromises()
    expect(center.value).toBeNull()
    expect(stats.value).toBeNull()
    expect(hint.value).toBe('刚才点到了天空，请点地面上的位置')
  })

  it('不是 Esc 的按键不收选区', async () => {
    respondWith()
    const { center, stats, pickAt } = withSetup(() => useAreaQuery())
    await pickAt(2.1674, 41.3895)
    await flushPromises()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    await flushPromises()
    expect(center.value).not.toBeNull()
    expect(stats.value).not.toBeNull()
  })
})
