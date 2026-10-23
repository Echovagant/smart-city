import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type {
  BuildingsResponse,
  CityEvent,
  CityOverview,
  CityViewState,
  RoadsResponse,
  TrafficStatus,
} from '../../../types/city'
import { DEFAULT_TAB_KEY, useDashboardState } from '@/composables/useDashboardState'
import { BUILDING_GLOW_DIMMED, DARK_PALETTE, FLOW_HIGHLIGHT } from '@/theme/dark'
import type { ThemeOverrides } from '@/theme/themes/types'

// 主题状态换成假实现：大屏骨架的 DOM 契约只关心「有没有主题入口」，
// 不该依赖主题模块的具体行为（持久化、CSS 变量写入那些各有各的用例）。
vi.mock('@/composables/useTheme', async () => {
  const { computed, ref } = await import('vue')
  const { resolveTheme } = await import('@/theme/themes')
  return {
    useTheme: () => {
      const themeId = ref('deep-space')
      const overrides = ref<ThemeOverrides>({})
      const theme = computed(() => resolveTheme(themeId.value, overrides.value))
      return {
        themeId,
        overrides,
        theme,
        setTheme: (id: string) => {
          themeId.value = id
        },
        setOverride: () => undefined,
        resetOverrides: () => undefined,
      }
    },
  }
})

// 记录 Cesium mock 的关键调用，供"行为断言"使用。
// vi.hoisted 让这个对象在 vi.mock 工厂（会被提升到 import 之前）里可用。
const cesiumMock = vi.hoisted(() => ({
  // Cesium.Ion 上的任何读写都会被记下来：一旦组件碰了 ion，就说明底图又走回 ion 了
  ionAccesses: [] as string[],
  ionImageryProviderCalls: 0,
}))

// Stub cesium BEFORE importing SmartCity. The module exports everything as
// functions or constructors; returning empty objects is enough to keep
// SmartCity's onMounted from throwing during a jsdom mount.
vi.mock('cesium', () => {
  // 颜色桩：每个色值都是独立对象，带一个可比较的 name
  // （测试要断言「两种道路的颜色不同」）。withAlpha 保留 name，
  // 这样「同一色、不同 alpha」也仍然可比较。
  const makeColor = (name: string, alpha = 1) => ({
    name,
    alpha,
    withAlpha: (next: number) => makeColor(name, next)
  })
  const colorWithAlpha = vi.fn((alpha: number) => makeColor('alpha', alpha))
  const namedColor = (name: string) => makeColor(name)
  const Color = Object.assign(vi.fn(), {
    RED: namedColor('red'),
    GREEN: namedColor('green'),
    YELLOW: namedColor('yellow'),
    WHITE: namedColor('white'),
    DARKGRAY: namedColor('darkgray'),
    GRAY: namedColor('gray'),
    TRANSPARENT: namedColor('transparent'),
    withAlpha: colorWithAlpha,
    // 按传入的 CSS 字符串返回不同的颜色对象：真实 Cesium 里每个色值都是独立实例，
    // mock 若一律返回同一个名字，就无法断言"两种道路的颜色不同"。
    fromCssColorString: vi.fn((css: string) => namedColor(css)),
  })
  return {
    Viewer: vi.fn().mockImplementation(() => ({
      destroy: vi.fn(),
      // ScreenSpaceEventHandler 要一个真实的 canvas 元素
      canvas: document.createElement('canvas'),
      camera: {
        flyTo: vi.fn(),
        setView: vi.fn(),
        // 自转恢复时要从相机当前位置反算轨道状态
        positionCartographic: { longitude: 0, latitude: 0, height: 0 },
      },
      scene: {
        globe: { enableLighting: false, baseColor: null, showGroundAtmosphere: true },
        skyAtmosphere: { show: true },
        skyBox: { show: true },
        backgroundColor: null,
        fog: {},
        postProcessStages: { fxaa: {} },
        maximumFrameRate: 0,
        // 自转挂在 preRender 上
        preRender: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        primitives: { add: vi.fn(), remove: vi.fn() },
      },
      entities: {
        add: vi.fn(() => ({ position: null, show: true, point: {}, polygon: {}, polyline: {} })),
        remove: vi.fn(),
        values: [],
      },
      dataSources: { add: vi.fn() },
      imageryLayers: {
        addImageryProvider: vi.fn(),
        removeAll: vi.fn(),
        length: 0,
        get: vi.fn(() => undefined),
        add: vi.fn(),
      },
    })),
    Cartesian3: Object.assign(
      vi.fn().mockImplementation((x: number, y: number, z: number) => ({ x, y, z })),
      // 真实 Cesium 的 fromDegrees 会把高度放进返回值的 z。
      // mock 必须保留高度，相机高度断言才有意义（每个调用返回新对象，
      // 车辆动画的"位置变了"断言也仍然成立）。
      // clone() 也是真实 API 的一部分：批量描边要靠它闭合轮廓。
      {
        fromDegrees: vi.fn((lng: number, lat: number, height: number) => ({
          x: lng,
          y: lat,
          z: height,
          clone: () => ({ x: lng, y: lat, z: height, clone: () => ({ x: lng, y: lat, z: height }) }),
        })),
      }
    ),
    Color,
    // ion 探针：任何读写都被记录，测试据此断言"全程没碰 ion"。
    Ion: new Proxy({}, {
      get(_target, prop) {
        cesiumMock.ionAccesses.push(`get:${String(prop)}`)
        return undefined
      },
      set(_target, prop) {
        cesiumMock.ionAccesses.push(`set:${String(prop)}`)
        return true
      },
    }),
    // 万一有人改回 ion 底图，这里会被调用并被计数。
    IonImageryProvider: vi.fn(() => {
      cesiumMock.ionImageryProviderCalls += 1
      return {}
    }),
    SceneMode: { SCENE3D: 0 },
    // Cesium 1.104+ 把 OpenStreetMapImageryProvider 改成异步工厂 fromUrl。
    OpenStreetMapImageryProvider: Object.assign(vi.fn(), {
      fromUrl: vi.fn().mockResolvedValue({}),
    }),
    // 材质：实体用 MaterialProperty，Primitive 的 appearance 用 Material。
    // 两者不是一回事，mock 里也保持分开。
    PolylineGlowMaterialProperty: vi.fn((options: Record<string, unknown>) => ({
      color: options?.color,
      glowPower: options?.glowPower,
    })),
    PolylineDashMaterialProperty: vi.fn((options: Record<string, unknown>) => ({ ...options })),
    // 材质是否「常量」决定了 Cesium 会不会每帧重建贴地几何，
    // 所以 glowPower 必须包成 ConstantProperty（见 theme/dark.ts 的说明）。
    ConstantProperty: vi.fn((value: unknown) => ({ value, isConstant: true })),
    Material: { fromType: vi.fn((type: string, uniforms: unknown) => ({ type, uniforms })) },
    CallbackProperty: vi.fn((callback: (...args: unknown[]) => unknown) => ({
      callback,
      isConstant: false,
      getValue: (...args: unknown[]) => callback(...args),
    })),
    JulianDate: { now: () => ({}) },
    // 批量描边与网格走 Primitive
    Primitive: vi.fn((options: Record<string, unknown>) => ({ ...options, show: true })),
    GeometryInstance: vi.fn((options: Record<string, unknown>) => ({ ...options })),
    PolylineGeometry: vi.fn((options: Record<string, unknown>) => ({ ...options })),
    PolylineMaterialAppearance: Object.assign(
      vi.fn((options: Record<string, unknown>) => ({ ...options })),
      { VERTEX_FORMAT: { position: true, st: true } }
    ),
    ArcType: { GEODESIC: 0, RHUMB: 1 },
    ScreenSpaceEventHandler: vi.fn(() => ({
      setInputAction: vi.fn(),
      destroy: vi.fn(),
    })),
    ScreenSpaceEventType: {
      LEFT_DOWN: 0,
      LEFT_UP: 1,
      LEFT_DRAG: 2,
      RIGHT_DOWN: 3,
      RIGHT_UP: 4,
      RIGHT_DRAG: 5,
      MIDDLE_DOWN: 6,
      MIDDLE_UP: 7,
      MIDDLE_DRAG: 8,
      WHEEL: 10,
      PINCH: 11,
    },
    GeoJsonDataSource: { load: vi.fn().mockResolvedValue({ entities: { values: [] } }) },
    EntityCluster: vi.fn(),
    Math: { toRadians: vi.fn((deg: number) => deg) },
    VerticalOrigin: { CENTER: 0 },
    HorizontalOrigin: { CENTER: 0 },
    HeightReference: { CLAMP_TO_GROUND: 0 },
  }
})

import * as Cesium from 'cesium'
import SmartCity from '../SmartCity.vue'

/* -------------------------------------------------------------------------
 * Cesium 桩的类型
 *
 * vi.mock 把整个 cesium 模块换成了上面的桩，但 TypeScript 看到的仍是
 * 真实 Cesium 的声明——桩里的 mock 函数（mock.calls / mock.results）
 * 在真实类型里不存在。这里把「桩的形状」单独声明出来，
 * 测试通过它来断言行为。
 * ---------------------------------------------------------------------- */

/** entities.add 收到的图元描述。 */
interface EntityDescriptor {
  name?: string
  position?: unknown
  box?: unknown
  cylinder?: unknown
  point?: unknown
  model?: unknown
}

/** entities.add 返回的实体。 */
interface MockEntity {
  position: unknown
  show: boolean
  point: Record<string, unknown>
  polygon: Record<string, unknown>
  polyline: MockPolyline
}

/** 道路图元的形状（组件会往里写 material / width）。 */
interface MockPolyline {
  material: { name?: string; color?: { name?: string } }
  width: number
}

/** 桩里的 Viewer。 */
interface MockViewer {
  destroy: Mock<() => void>
  camera: {
    flyTo: Mock<(options: { destination: { z: number }; orientation: { pitch: number } }) => void>
    setView: Mock<
      (options: {
        destination: { x: number; y: number; z: number }
        orientation: { heading: number; pitch: number; roll: number }
      }) => void
    >
    /** 自转恢复时用它反算轨道状态（经度/纬度是**弧度**）。 */
    positionCartographic: { longitude: number; latitude: number; height: number }
  }
  scene: {
    globe: { enableLighting: boolean; baseColor: unknown }
    fog: { density: number; near: number; far: number }
    postProcessStages: { fxaa: { enabled: boolean } }
    maximumFrameRate: number
    /** 自转挂在 preRender 上；测试要能把它注册的监听器取出来触发。 */
    preRender: {
      addEventListener: Mock<(listener: () => void) => void>
      removeEventListener: Mock<(listener: () => void) => void>
    }
    /** 批量描边 / 网格 / 流动光效都是 Primitive；测试要能检查它们。 */
    primitives: {
      add: Mock<(primitive: MockPrimitive) => void>
      remove: Mock<(primitive: unknown) => void>
    }
  }
  entities: {
    add: Mock<(descriptor: EntityDescriptor) => MockEntity>
    remove: Mock<() => void>
    values: MockEntity[]
  }
  dataSources: { add: Mock<(source: unknown) => void> }
  imageryLayers: {
    add: Mock<(layer: unknown) => void>
    get: Mock<(index: number) => unknown>
    length: number
  }
}

/** 桩里的 Primitive（批量描边 / 网格 / 流动光效共用）。 */
interface MockPrimitive {
  show: boolean
  geometryInstances: Array<{
    geometry: {
      positions: Array<{ x: number; y: number; z: number }>
      width?: number
    }
  }>
  appearance: {
    material: {
      type: string
      uniforms: {
        color: { name?: string; alpha?: number }
        glowPower?: number
        dashLength?: number
      }
    }
  }
}

/** 桩里的 GeoJsonDataSource.load。 */
type LoadMock = Mock<
  (data: { type: string }, options?: unknown) => Promise<{ entities: { values: unknown[] } }>
>

/**
 * vi.mock 换掉的是整个 cesium 模块，这里把模块收窄到桩的类型，
 * 测试才能访问 mock 专有的成员（mockResolvedValue / mock.calls）。
 */
const cesiumStub = Cesium as unknown as {
  GeoJsonDataSource: { load: LoadMock }
}

/**
 * 组件实例在测试里用到的那些成员。
 *
 * `<script setup>` 的绑定在运行时都在 vm 上，但 vue-tsc 为这个 SFC 生成的
 * 组件类型里，setup 绑定的类型槽位是宽松类型——绑定没进实例类型，
 * @vue/test-utils 的 VueWrapper.vm 因此退化成 ComponentPublicInstance。
 * 这里把测试真正用到的成员显式声明出来（注明出处），收窄一次，
 * 后面就不用每处都断言了。
 */
interface SmartCityVm {
  /** Cesium Viewer（组件内部是 ref，vm 上是解包后的值）。 */
  viewer: Cesium.Viewer | null
  /** 视图状态 + 三组 Cesium 实体列表。 */
  state: CityViewState & {
    buildingEntities: Cesium.Entity[]
    roadEntities: Cesium.Entity[]
    trafficEntities: Cesium.Entity[]
  }
  /** 建筑 GeoJSON（组件内部是 shallowRef，vm 上是解包后的值）。 */
  buildings: BuildingsResponse | null
  /** 道路 GeoJSON。 */
  roads: RoadsResponse | null
  /** 实时交通读数。 */
  trafficStatus: TrafficStatus | null
  /** 城市运行指标。 */
  cityOverview: CityOverview | null
  /** 派生事件（已按 id 去重）。 */
  events: CityEvent[]
  /** 落点已解析的派生事件（全市级事件落在城心）。 */
  resolvedEvents: CityEvent[]
  /** 点击事件 → 相机飞过去。 */
  flyToEvent: (event: CityEvent) => void
  createTrafficSystem: () => void
  loadGeoJSONBuildings: () => Promise<void>
  loadGeoJSONRoads: () => Promise<void>
  toggleBuildings: () => void
  toggleRoads: () => void
  toggleTraffic: () => void
  toggleView: () => void
  refreshTrafficStatus: () => Promise<void>
}

/**
 * mount SmartCity 并把 vm 的类型收窄到组件实例类型。
 *
 * 收窄的原因见 SmartCityVm 的注释——这里只做一次，注明出处。
 * 所有用例都把组件挂到 document.body 上（行为与转换前一致）。
 */
const mountSmartCity = () =>
  mount(SmartCity, { attachTo: document.body }) as unknown as VueWrapper<SmartCityVm>

/** 组件内部的 viewer 就是上面那个桩（不是真的 Cesium Viewer）。 */
const mockViewerOf = (wrapper: VueWrapper<SmartCityVm>): MockViewer =>
  wrapper.vm.viewer as unknown as MockViewer

const originalFetch = globalThis.fetch

/**
 * 把 fetch 桩装到 globalThis 上。
 *
 * fetch 的真实类型比桩宽（`(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>`），
 * 桩只关心 url —— 这里做一次显式收窄，免得桩的简化把 fetch 的签名也一起放松了。
 */
const installFetch = (stub: unknown) => {
  globalThis.fetch = stub as typeof fetch
}

// 源码文本只用于一处断言：Viewer 构造选项（见 plan 013 Step 2）。
// 构造函数选项没法从 mock 里观察得到，只能限定在选项块内做文本断言。
//
// **断言的对象是场景底座，不是组件**：场景层拆成 composable 之后，
// `new Cesium.Viewer(...)` 跟着「Cesium 初始化」一起搬进了
// `src/composables/useSceneStage.ts`（拆分前它在 SmartCity.vue 里）。
// 断言的内容与强度一个字没变，只是被读的源文件换了。
//
// 路径解析不能用 `new URL('../SmartCity.vue', import.meta.url)`：jsdom 的全局 URL
// 不把 file: 当特殊协议，相对路径会被解析成 http://localhost:3000/...，
// fileURLToPath 随即抛 "The URL must be of scheme file"。
// 直接对 import.meta.url 本身做 fileURLToPath 可绕开。
const viewerSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../composables/useSceneStage.ts'),
  'utf-8',
)

// 从源码里精确抠出 new Cesium.Viewer(...) 的第二个参数（options 对象）。
// 比"整份文件里 grep"可靠得多：注释、其它函数里的同名字段都混不进来。
const extractViewerOptions = (source: string) => {
  const marker = 'new Cesium.Viewer('
  const callStart = source.indexOf(marker)
  if (callStart === -1) return null
  const argsStart = callStart + marker.length
  let parenDepth = 0
  for (let i = argsStart; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '(') {
      parenDepth += 1
    } else if (ch === ')') {
      if (parenDepth === 0) return null
      parenDepth -= 1
    } else if (ch === '{' && parenDepth === 0) {
      // options 对象起点：做花括号配对
      let braceDepth = 0
      for (let j = i; j < source.length; j += 1) {
        if (source[j] === '{') braceDepth += 1
        else if (source[j] === '}') {
          braceDepth -= 1
          if (braceDepth === 0) return source.slice(i + 1, j)
        }
      }
      return null
    }
  }
  return null
}

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

// 后端 API 的最小可用桩：城市数据两个端点返回空 FeatureCollection，
// 交通状态端点返回一个普通对象。
const stubApiFetch = () =>
  vi.fn<(url: string, options: RequestInit) => Promise<Response>>((url) => {
    if (String(url).includes('traffic-status')) {
      return Promise.resolve(jsonResponse({ status: 'normal' }))
    }
    return Promise.resolve(jsonResponse({ type: 'FeatureCollection', features: [] }))
  })

// 文件级钩子：下面两个 describe 共用同一份复位逻辑
beforeEach(() => {
  vi.clearAllMocks()
  // 复位数据源桩：某个用例把它改成别的返回值时不会污染后面的用例
  cesiumStub.GeoJsonDataSource.load.mockResolvedValue({ entities: { values: [] } })
  cesiumMock.ionAccesses.length = 0
  cesiumMock.ionImageryProviderCalls = 0
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('SmartCity lifecycle', () => {
  it('cancels in-flight requestAnimationFrame on unmount', async () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame')
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame')

    const wrapper = mountSmartCity()

    // 手动调用 createTrafficSystem 让其内部的车辆动画通过 safeRequestAnimationFrame
    // 注册到组件的 animationFrames Set。这样卸载时 onUnmounted → cancelAllAnimations
    // 才能遍历到 handle 并调用 cancelAnimationFrame。
    wrapper.vm.createTrafficSystem()
    expect(rafSpy).toHaveBeenCalled()
    wrapper.unmount()

    // 卸载路径必须触发 cancelAnimationFrame
    expect(cancelSpy).toHaveBeenCalled()
  })

  it('restarts the traffic animation after traffic is toggled back on', () => {
    // 用可控的 requestAnimationFrame 队列手动推进帧，
    // 断言"停止交通 → 启动交通"之后动画链确实又被拉起来了。
    // （修复前 moveVehicle 在隐藏时直接 return、不再排下一帧，动画链永久断掉。）
    const frameQueue: FrameRequestCallback[] = []
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameQueue.push(callback)
      return frameQueue.length
    })

    const wrapper = mountSmartCity()
    wrapper.vm.createTrafficSystem()

    // cesium mock 的 entities.add 会忽略入参，但 mock.calls 记录了传入的 options，
    // 用 name 找到车辆实体对应的返回值（mock.results[i].value）。
    const addMock = mockViewerOf(wrapper).entities.add
    const vehicleIndex = addMock.mock.calls.findIndex(
      ([options]) => options.name && options.name.startsWith('Vehicle')
    )
    expect(vehicleIndex).toBeGreaterThan(-1)
    const vehicle = addMock.mock.results[vehicleIndex].value as MockEntity

    const stepFrame = () => {
      const callback = frameQueue.shift()
      if (callback) callback(0)
    }

    // 初始位置由 createTrafficSystem 里的第一次 moveVehicle 写入
    const initialPosition = vehicle.position
    expect(initialPosition).not.toBeNull()

    // 走一帧：车辆应当被重新定位
    // （mock 的 Cartesian3.fromDegrees 每次都返回新对象，对象标识不同即代表真的动了）
    stepFrame()
    expect(vehicle.position).not.toBe(initialPosition)

    // 关闭交通：把待执行的帧全部跑完后不应再排新帧（动画链断开）
    wrapper.vm.toggleTraffic()
    let guard = 0
    while (frameQueue.length > 0 && guard < 100) {
      stepFrame()
      guard += 1
    }
    expect(frameQueue.length).toBe(0)

    // 重新启动交通：动画链必须被重新拉起
    wrapper.vm.toggleTraffic()
    expect(frameQueue.length).toBeGreaterThan(0)
    expect(rafSpy.mock.calls.length).toBeGreaterThan(0)

    // 再走一帧：车辆位置再次变化，说明动画真的恢复了
    const positionBeforeRestart = vehicle.position
    stepFrame()
    expect(vehicle.position).not.toBe(positionBeforeRestart)

    wrapper.unmount()
  })

  it('does not throw when the component unmounts before data loading finishes', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const wrapper = mountSmartCity()
    // 立刻卸载：onMounted 的 async 路径还停在 await 上
    wrapper.unmount()

    // 卸载后 viewer.value 已被置空，此时再调 createTrafficSystem 不能抛
    // （否则会是 "Cannot read properties of null (reading 'entities')"）
    expect(() => wrapper.vm.createTrafficSystem()).not.toThrow()

    // 把 onMounted 异步路径的微任务跑完，确认没有未捕获的初始化错误
    await new Promise((resolve) => setTimeout(resolve, 0))
    const initErrorCalls = errorSpy.mock.calls.filter(([first]) => first === '初始化错误:')
    expect(initErrorCalls).toHaveLength(0)
  })

  it('renders roads by their OSM highway class', async () => {
    // 道路分级读的是 highway 标签：实测道路数据里 2260 条全部带 highway，
    // 而 type 一个都没有。修复前读的是 properties.type，
    // 结果所有道路都是同一种浅灰、同样宽度，"主干道"分支从来没被渲染过。
    const makeEntity = (props: Record<string, string>): { polyline: MockPolyline; properties: Record<string, { getValue: () => string }> } => ({
      polyline: { material: { name: '' }, width: 0 },
      properties: Object.fromEntries(
        Object.entries(props).map(([key, value]) => [key, { getValue: () => value }])
      )
    })

    const primary = makeEntity({ highway: 'primary' })
    const footway = makeEntity({ highway: 'footway' })
    const unlisted = makeEntity({ highway: 'motorway_link' }) // 表外的取值
    const primaryWithWideTag = makeEntity({ highway: 'primary', width: '30' })
    const footwayWithWidth = makeEntity({ highway: 'footway', width: '2' })

    const loadMock = cesiumStub.GeoJsonDataSource.load
    loadMock.mockResolvedValue({
      entities: { values: [primary, footway, unlisted, primaryWithWideTag, footwayWithWidth] }
    })

    const wrapper = mountSmartCity()
    // 直接给 composable 的 roads 塞一份空集合，绕开网络请求
    wrapper.vm.roads = { type: 'FeatureCollection', features: [] }
    await wrapper.vm.loadGeoJSONRoads()
    // 复原 mock，别污染其它用例
    loadMock.mockResolvedValue({ entities: { values: [] } })

    // 不同等级：颜色不同、宽度不同
    // （道路材质是辉光材质 PolylineGlowMaterialProperty，颜色挂在 color 上）
    expect(primary.polyline.material).not.toBe(footway.polyline.material)
    expect(primary.polyline.material.color?.name).not.toBe(footway.polyline.material.color?.name)
    expect(primary.polyline.width).toBeGreaterThan(footway.polyline.width)
    // 宽度必须是数字，不能是 OSM 的原始字符串
    expect(typeof primary.polyline.width).toBe('number')
    expect(typeof footway.polyline.width).toBe('number')

    // width 标签只在"正数且不超过该等级默认宽度"时采用：
    // '2' 米的人行道照用，'30' 米的异常值退回等级默认宽度
    expect(footwayWithWidth.polyline.width).toBe(2)
    expect(primaryWithWideTag.polyline.width).toBe(primary.polyline.width)

    // 表外的 highway 取值落到兜底等级（最低宽度，但用的是兜底自己的配色）
    expect(unlisted.polyline.width).toBe(footway.polyline.width)
    expect(unlisted.polyline.material.color?.name).not.toBe(footway.polyline.material.color?.name)

    wrapper.unmount()
  })

  it('shows the OpenStreetMap attribution required by the ODbL', async () => {
    const wrapper = mountSmartCity()
    await flushPromises()

    // OSM 数据遵循 ODbL：展示时必须署名 "© OpenStreetMap contributors"
    expect(wrapper.text()).toContain('OpenStreetMap contributors')
    expect(wrapper.text()).toContain('©')

    wrapper.unmount()
  })
})

// ---------------------------------------------------------------------------
// 行为断言：mount 组件后断言可观察效果，而不是读源码文本。
// ---------------------------------------------------------------------------
describe('SmartCity behaviour', () => {
  it('creates traffic entities from Cesium primitives', () => {
    const wrapper = mountSmartCity()
    wrapper.vm.createTrafficSystem()

    const descriptors = mockViewerOf(wrapper).entities.add.mock.calls.map(([options]) => options)
    expect(descriptors.length).toBeGreaterThan(0)
    // 车辆用 box，交通灯与路灯用 cylinder —— 全部是 Cesium 图元，
    // 不依赖任何 .glb 模型文件。
    expect(descriptors.some((d) => d.box)).toBe(true)
    expect(descriptors.some((d) => d.cylinder)).toBe(true)

    const vehicles = descriptors.filter((d) => d.name && d.name.startsWith('Vehicle'))
    expect(vehicles.length).toBeGreaterThan(0)
    expect(vehicles.every((v) => v.box && !v.cylinder)).toBe(true)

    // 图元里不能混进模型 uri（public/models 下没有模型文件）
    expect(descriptors.every((d) => d.model === undefined)).toBe(true)

    wrapper.unmount()
  })

  it('gives every kind of traffic entity the graphic it needs', () => {
    const wrapper = mountSmartCity()
    wrapper.vm.createTrafficSystem()

    const descriptors = mockViewerOf(wrapper).entities.add.mock.calls.map(([options]) => options)
    const trafficLights = descriptors.filter((d) => d.name === 'Traffic Light')
    const streetLights = descriptors.filter((d) => d.name && d.name.startsWith('Street Light'))
    const vehicles = descriptors.filter((d) => d.name && d.name.startsWith('Vehicle'))

    expect(trafficLights.length).toBeGreaterThan(0)
    expect(streetLights.length).toBeGreaterThan(0)
    expect(vehicles.length).toBeGreaterThan(0)

    // 灯杆是圆柱 + 发光点
    expect(trafficLights.every((l) => l.cylinder && l.point)).toBe(true)
    expect(streetLights.every((l) => l.cylinder && l.point)).toBe(true)
    // 车辆是长方体
    expect(vehicles.every((v) => v.box && !v.point)).toBe(true)

    wrapper.unmount()
  })

  it('hides the traffic entities when traffic is switched off', () => {
    const wrapper = mountSmartCity()
    wrapper.vm.createTrafficSystem()

    const addMock = mockViewerOf(wrapper).entities.add
    const firstTrafficEntity = addMock.mock.results[0].value as MockEntity

    wrapper.vm.toggleTraffic()
    expect(wrapper.vm.state.trafficVisible).toBe(false)
    expect(firstTrafficEntity.show).toBe(false)

    wrapper.vm.toggleTraffic()
    expect(wrapper.vm.state.trafficVisible).toBe(true)
    expect(firstTrafficEntity.show).toBe(true)

    wrapper.unmount()
  })

  it('applies the performance options to the viewer scene', async () => {
    const wrapper = mountSmartCity()
    // optimizePerformance 在 onMounted 的 await 之后才跑，先把微任务跑完
    await flushPromises()
    const scene = mockViewerOf(wrapper).scene

    // optimizePerformance 在 onMounted 里跑：关光照（底色恒定）、加雾、开 FXAA、限帧
    expect(scene.globe.enableLighting).toBe(false)
    expect(scene.fog.density).toBeGreaterThan(0)
    expect(scene.fog.near).toBeGreaterThan(0)
    expect(scene.fog.far).toBeGreaterThan(scene.fog.near)
    expect(scene.postProcessStages.fxaa.enabled).toBe(true)
    expect(scene.maximumFrameRate).toBe(60)
    // 地面底色必须被设成大屏底色（不设的话 Cesium 给的是灰蓝色球体）
    expect(scene.globe.baseColor).toBeTruthy()

    wrapper.unmount()
  })

  it('shows an error banner when the city data cannot be loaded', async () => {
    installFetch(vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')))

    const wrapper = mountSmartCity()

    await vi.waitFor(() => {
      expect(wrapper.find('.status-error').exists()).toBe(true)
    })
    expect(wrapper.find('.status-error').text()).toContain('数据加载失败')

    wrapper.unmount()
  })

  it('configures no imagery provider and never touches Cesium.Ion', () => {
    // 构造函数选项从 mock 里观察不到，只能把断言限定在 Viewer 的 options 块内
    const options = extractViewerOptions(viewerSource)
    expect(options).not.toBeNull()
    // baseLayerPicker 不禁用 → 默认构造 BaseLayerPickerViewModel → Bing Maps Aerial
    // → IonImageryProvider.fromAssetId(2) → api.cesium.com 401
    expect(options).toMatch(/\bbaseLayerPicker:\s*false\b/)
    // geocoder 不禁用 → 默认 new IonGeocoderService → 同样 401
    expect(options).toMatch(/\bgeocoder:\s*false\b/)
    // baseLayer 不显式设 false → CesiumWidget 走 fromWorldImagery() → 又触发 ion
    expect(options).toMatch(/\bbaseLayer:\s*false\b/)

    const wrapper = mountSmartCity()

    // 运行时证据：整个挂载过程没有碰过 Cesium.Ion
    expect(cesiumMock.ionAccesses).toEqual([])
    expect(cesiumMock.ionImageryProviderCalls).toBe(0)

    // 底座自绘：一次影像图层都不加（不接任何影像瓦片服务）。
    // 地面是纯色底 + 自绘网格，建筑与道路都画在 OSM 的原始 WGS-84 坐标上。
    expect(mockViewerOf(wrapper).imageryLayers.add).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('disables the Cesium default widgets that clash with the dark board', () => {
    // 深色大屏上，Cesium 默认的浅色圆角按钮（home / 地球 / ?）与 NavigationHelp
    // 说明板是破功的：纯黑背景上尤其扎眼。全部关掉。
    const options = extractViewerOptions(viewerSource)
    expect(options).not.toBeNull()
    expect(options).toMatch(/\bhomeButton:\s*false\b/)
    expect(options).toMatch(/\bsceneModePicker:\s*false\b/)
    expect(options).toMatch(/\bnavigationHelpButton:\s*false\b/)
    expect(options).toMatch(/\bnavigationInstructionsInitiallyVisible:\s*false\b/)
  })

  it('loads the building and road GeoJSON into the viewer on mount', async () => {
    installFetch(stubApiFetch())

    const wrapper = mountSmartCity()

    // onMounted 是异步的：等它把两次 GeoJsonDataSource.load 都跑完
    await vi.waitFor(() => {
      expect(cesiumStub.GeoJsonDataSource.load).toHaveBeenCalledTimes(2)
    })
    await flushPromises()

    // 两个数据源都被挂进 viewer
    expect(mockViewerOf(wrapper).dataSources.add).toHaveBeenCalledTimes(2)

    wrapper.unmount()
  })

  it('fetches city data through the API layer, not by URL', async () => {
    const fetchMock = stubApiFetch()
    installFetch(fetchMock)

    const wrapper = mountSmartCity()

    await vi.waitFor(() => {
      expect(cesiumStub.GeoJsonDataSource.load).toHaveBeenCalledTimes(2)
    })

    // 所有请求都打到后端 API 前缀下
    const urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls.length).toBeGreaterThanOrEqual(3)
    urls.forEach((url) => {
      expect(url.startsWith('/api/')).toBe(true)
    })
    expect(urls).toContain('/api/buildings')
    expect(urls).toContain('/api/roads')

    // 每次请求都带 AbortSignal —— 说明走的是 apiGet() 封装，而不是裸 fetch
    fetchMock.mock.calls.forEach(([, options]) => {
      expect(options.signal).toBeDefined()
    })

    // Cesium 拿到的是 API 返回的对象，不是 URL 字符串
    cesiumStub.GeoJsonDataSource.load.mock.calls.forEach(([payload]) => {
      expect(typeof payload).not.toBe('string')
      expect(payload.type).toBe('FeatureCollection')
    })

    wrapper.unmount()
  })

  it('toggles the visibility of the building and road entities it created', async () => {
    const building: MockEntity = {
      position: null,
      show: true,
      point: {},
      polygon: {},
      polyline: { material: { name: '' }, width: 0 },
    }
    const road: MockEntity = {
      position: null,
      show: true,
      point: {},
      polygon: {},
      polyline: { material: { name: '' }, width: 0 },
    }
    cesiumStub.GeoJsonDataSource.load.mockResolvedValue({
      entities: { values: [building, road] }
    })

    const wrapper = mountSmartCity()
    wrapper.vm.buildings = { type: 'FeatureCollection', features: [] }
    wrapper.vm.roads = { type: 'FeatureCollection', features: [] }
    await wrapper.vm.loadGeoJSONBuildings()
    await wrapper.vm.loadGeoJSONRoads()

    expect(wrapper.vm.state.buildingEntities).toContain(building)
    expect(wrapper.vm.state.roadEntities).toContain(road)

    wrapper.vm.toggleBuildings()
    expect(wrapper.vm.state.buildingVisible).toBe(false)
    expect(building.show).toBe(false)

    wrapper.vm.toggleRoads()
    expect(wrapper.vm.state.roadVisible).toBe(false)
    expect(road.show).toBe(false)

    // 再切回来，实体必须跟着恢复
    wrapper.vm.toggleBuildings()
    expect(building.show).toBe(true)
    wrapper.vm.toggleRoads()
    expect(road.show).toBe(true)

    wrapper.unmount()
  })

  it('flies between street level and overhead when the view is toggled', () => {
    const wrapper = mountSmartCity()
    const flyTo = mockViewerOf(wrapper).camera.flyTo
    // 清掉 initCesium 里的初始定位，只看 toggleView 引发的飞行
    flyTo.mockClear()

    wrapper.vm.toggleView()
    expect(wrapper.vm.state.viewMode).toBe('street')
    expect(flyTo).toHaveBeenCalledTimes(1)
    const street = flyTo.mock.calls[0][0]
    // 高度取自 cityConfig.streetLevel.height（SmartCity.vue 里是 1.7 米）
    expect(street.destination.z).toBe(1.7)
    expect(street.orientation.pitch).toBe(0)

    wrapper.vm.toggleView()
    expect(wrapper.vm.state.viewMode).toBe('overhead')
    expect(flyTo).toHaveBeenCalledTimes(2)
    const overhead = flyTo.mock.calls[1][0]
    // 高度取自 cityConfig.zoomLevel（SmartCity.vue 里是 1500 米）
    expect(overhead.destination.z).toBe(1500)

    wrapper.unmount()
  })

  it('drives the toggles from the control-panel buttons', async () => {
    const wrapper = mountSmartCity()
    const buttons = wrapper.findAll('.control-panel button')
    // 4 个开关按钮 + 1 个主题入口（主题面板自己的按钮不在这个集合里）
    expect(buttons).toHaveLength(5)

    // 建筑
    expect(buttons[0].text()).toBe('隐藏建筑')
    await buttons[0].trigger('click')
    expect(wrapper.vm.state.buildingVisible).toBe(false)
    expect(buttons[0].text()).toBe('显示建筑')

    // 道路
    await buttons[1].trigger('click')
    expect(wrapper.vm.state.roadVisible).toBe(false)
    expect(buttons[1].text()).toBe('显示道路')

    // 交通
    await buttons[2].trigger('click')
    expect(wrapper.vm.state.trafficVisible).toBe(false)
    expect(buttons[2].text()).toBe('启动交通')

    // 视角
    await buttons[3].trigger('click')
    expect(wrapper.vm.state.viewMode).toBe('street')
    expect(buttons[3].text()).toBe('切换鸟瞰')

    // 主题入口：展开 / 收起主题面板（默认收起）
    expect(buttons[4].text()).toContain('主题')
    expect(wrapper.find('.dc-theme-picker').exists()).toBe(false)
    await buttons[4].trigger('click')
    expect(wrapper.find('.dc-theme-picker').exists()).toBe(true)
    // 面板展开后控制面板的按钮集合不变
    expect(wrapper.findAll('.control-panel button')).toHaveLength(5)

    wrapper.unmount()
  })
})

// ---------------------------------------------------------------------------
// 实时交通读数：后端按时间推导 /api/traffic-status，前端把它显示在控制面板上。
// 全部是行为断言（mount 组件 → 看渲染结果），不读源码文本。
// ---------------------------------------------------------------------------
describe('SmartCity traffic status', () => {
  const trafficPayload: TrafficStatus = {
    status: 'slow',
    congestion_level: 0.42,
    congestion: '轻微拥堵',
    flow: 0.63,
    update_time: '2026-10-21T04:52:31.123Z',
  }

  // 只替换交通端点的返回值，其它两个端点照常返回空集合。
  // payload 可以直接给对象，也可以给一个取值的函数——后者用于「后端换了个新读数」。
  const stubTrafficFetch = (payload: TrafficStatus | (() => TrafficStatus)) =>
    vi.fn<(url: string, options: RequestInit) => Promise<Response>>((url) => {
      if (String(url).includes('traffic-status')) {
        const body = typeof payload === 'function' ? payload() : payload
        return Promise.resolve(jsonResponse(body))
      }
      return Promise.resolve(jsonResponse({ type: 'FeatureCollection', features: [] }))
    })

  it('shows the traffic reading on the control panel', async () => {
    const fetchMock = stubTrafficFetch(trafficPayload)
    installFetch(fetchMock)

    const wrapper = mountSmartCity()

    await vi.waitFor(() => {
      expect(wrapper.find('.traffic-status').exists()).toBe(true)
    })

    const text = wrapper.find('.traffic-status').text()
    expect(text).toContain('实时交通')
    expect(text).toContain('63%') // flow 0.63 → 63%
    expect(text).toContain('轻微拥堵')
    expect(text).toMatch(/更新于 \d{2}:\d{2}:\d{2}/)
    // 界面上不能出现 undefined / NaN
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('NaN')

    // 读数来自 API 层，不是组件里写死的
    const urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls).toContain('/api/traffic-status')

    wrapper.unmount()
  })

  it('updates the reading when the traffic status is fetched again', async () => {
    let payload: TrafficStatus = { ...trafficPayload, status: 'normal', congestion: '畅通', flow: 0.2 }
    installFetch(stubTrafficFetch(() => payload))

    const wrapper = mountSmartCity()
    await vi.waitFor(() => {
      expect(wrapper.find('.traffic-status').exists()).toBe(true)
    })
    expect(wrapper.find('.traffic-status').text()).toContain('畅通')

    // 后端给了新读数：面板上的数字必须跟着变
    payload = {
      status: 'congested',
      congestion_level: 0.9,
      congestion: '严重拥堵',
      flow: 0.95,
      update_time: '2026-10-21T04:57:36.123Z',
    }
    await wrapper.vm.refreshTrafficStatus()
    await nextTick()

    const text = wrapper.find('.traffic-status').text()
    expect(text).toContain('严重拥堵')
    expect(text).toContain('95%')
    expect(text).not.toContain('畅通')

    wrapper.unmount()
  })

  it('renders no traffic row when the traffic status is unavailable', async () => {
    installFetch(stubApiFetch())

    const wrapper = mountSmartCity()
    await flushPromises()

    // 读数清空后不能留下空壳，也不能显示 undefined / NaN
    wrapper.vm.trafficStatus = null
    await nextTick()

    expect(wrapper.find('.traffic-status').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('undefined')
    expect(wrapper.text()).not.toContain('NaN')

    wrapper.unmount()
  })

  it('omits missing traffic fields instead of showing undefined or NaN', async () => {
    // 旧响应（或只有 status 的桩）里缺的字段整段略过
    installFetch(stubTrafficFetch({ status: 'normal' }))

    const wrapper = mountSmartCity()
    await vi.waitFor(() => {
      expect(wrapper.find('.traffic-status').exists()).toBe(true)
    })

    const text = wrapper.find('.traffic-status').text()
    expect(text).toContain('实时交通')
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('%')

    wrapper.unmount()
  })

  it('polls the traffic status every five seconds and stops on unmount', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval')
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    installFetch(stubApiFetch())

    const wrapper = mountSmartCity()
    await flushPromises()

    // 轮询间隔 5 秒（计划书里的「5 秒级更新」）
    expect(setSpy.mock.calls.some(([, delay]) => delay === 5000)).toBe(true)

    wrapper.unmount()
    // 组件卸载后必须停掉轮询，否则会一直往后端打请求
    expect(clearSpy).toHaveBeenCalled()

    setSpy.mockRestore()
    clearSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 深色底座：相机自转、数字底座网格、流动光效层、广场材质
//
// 这些行为全部用**行为断言**（触发真实回调 → 看可观察效果），
// 不读源码文本。
// ---------------------------------------------------------------------------
describe('深色底座', () => {
  /** 取组件挂在 scene.preRender 上的自转监听器。 */
  const preRenderListenerOf = (wrapper: VueWrapper<SmartCityVm>): (() => void) => {
    const scene = mockViewerOf(wrapper).scene
    const calls = scene.preRender.addEventListener.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    return calls[0][0]
  }

  /** 取交互监听器注册的所有回调（触发任意一个都算「用户操作了」）。 */
  const interactionActionsOf = (): Array<() => void> => {
    const handler = (
      Cesium as unknown as {
        ScreenSpaceEventHandler: Mock<
          () => { setInputAction: Mock<(action: () => void) => void> }
        >
      }
    ).ScreenSpaceEventHandler.mock.results[0].value
    return handler.setInputAction.mock.calls.map((call: unknown[]) => call[0] as () => void)
  }

  /** 城心坐标（弧度），与组件里的 cityConfig.center 一致。 */
  const CENTER_LNG = 116.3976
  const CENTER_LAT = 39.9055

  /** 一条主干的原始 GeoJSON 要素（1~2 级 → 会叠流动光效）。 */
  const primaryRoadFeature = {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [
        [116.39, 39.9],
        [116.42, 39.9]
      ]
    },
    properties: { highway: 'primary' }
  }

  /** 一栋楼的原始 GeoJSON 要素（多边形，用来定网格范围）。 */
  const buildingFeature = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [116.39, 39.9],
          [116.395, 39.9],
          [116.395, 39.905],
          [116.39, 39.905],
          [116.39, 39.9]
        ]
      ]
    },
    properties: { building: 'yes' }
  }

  /** 返回带真实要素的 API 桩（让组件能算出网格范围与流动光效层）。 */
  const stubFetchWithCity = () =>
    vi.fn<(url: string, options: RequestInit) => Promise<Response>>((url) => {
      const target = String(url)
      const body = target.includes('traffic-status')
        ? { status: 'normal' }
        : target.includes('buildings')
          ? { type: 'FeatureCollection', features: [buildingFeature] }
          : { type: 'FeatureCollection', features: [primaryRoadFeature] }
      return Promise.resolve(jsonResponse(body))
    })

  it('空闲时自转把鸟瞰视角落到相机上', async () => {
    const wrapper = mountSmartCity()
    await flushPromises()

    // 时间推到「相机飞行结束」之后，否则自转会让位给飞行
    // （基准取真实时间 + 10 s，保证一定晚于飞行保护期）
    const base = performance.now()
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(base + 10_000)
    const setView = mockViewerOf(wrapper).camera.setView
    setView.mockClear()

    preRenderListenerOf(wrapper)()

    expect(setView).toHaveBeenCalled()
    const view = setView.mock.calls[0][0]
    // 俯视：pitch 为负、roll 为 0
    expect(view.orientation.pitch).toBeLessThan(0)
    expect(view.orientation.roll).toBe(0)
    // 相机在城心正上方（高度 1500 m 那一档）
    expect(view.destination.z).toBeGreaterThan(0)

    nowSpy.mockRestore()
    wrapper.unmount()
  })

  it('鼠标一操作就停自转，超过 4 秒才恢复', async () => {
    const wrapper = mountSmartCity()
    await flushPromises()

    const base = performance.now()
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(base + 10_000)
    const setView = mockViewerOf(wrapper).camera.setView
    setView.mockClear()
    const listener = preRenderListenerOf(wrapper)

    // 触发一次交互（按下/拖拽/滚轮都算）
    const actions = interactionActionsOf()
    expect(actions.length).toBeGreaterThan(0)
    actions.forEach((action) => action())

    listener()
    expect(setView).not.toHaveBeenCalled()

    // 还不到 4 秒：仍然不动
    nowSpy.mockReturnValue(base + 13_000)
    listener()
    expect(setView).not.toHaveBeenCalled()

    // 超过 4 秒：恢复自转
    nowSpy.mockReturnValue(base + 14_001)
    listener()
    expect(setView).toHaveBeenCalled()

    nowSpy.mockRestore()
    wrapper.unmount()
  })

  it('恢复自转时从相机当前位置反算轨道，不硬拽回轨道起点', async () => {
    const wrapper = mountSmartCity()
    await flushPromises()

    // 把相机放到城心以东 0.01° 处（用户拖过去了）
    const viewer = mockViewerOf(wrapper)
    viewer.camera.positionCartographic = {
      longitude: ((CENTER_LNG + 0.01) * Math.PI) / 180,
      latitude: (CENTER_LAT * Math.PI) / 180,
      height: 1500
    }

    const base = performance.now()
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(base + 10_000)
    const setView = viewer.camera.setView
    setView.mockClear()
    const listener = preRenderListenerOf(wrapper)

    interactionActionsOf().forEach((action) => action())
    nowSpy.mockReturnValue(base + 15_000)
    listener()

    expect(setView).toHaveBeenCalled()
    const destination = setView.mock.calls[0][0].destination
    // 恢复后的相机仍然在城心以东（= 接着用户停下的地方转），而不是被拽回正北
    expect(destination.x).toBeGreaterThan(CENTER_LNG)

    nowSpy.mockRestore()
    wrapper.unmount()
  })

  it('平视（1.7m）不自转', async () => {
    const wrapper = mountSmartCity()
    await flushPromises()

    wrapper.vm.toggleView()
    expect(wrapper.vm.state.viewMode).toBe('street')

    const base = performance.now()
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(base + 10_000)
    const setView = mockViewerOf(wrapper).camera.setView
    setView.mockClear()

    preRenderListenerOf(wrapper)()
    expect(setView).not.toHaveBeenCalled()

    nowSpy.mockRestore()
    wrapper.unmount()
  })

  it('在数据范围上铺出 200 米间距的发光网格', async () => {
    installFetch(stubFetchWithCity())

    const wrapper = mountSmartCity()
    await vi.waitFor(() => {
      expect(mockViewerOf(wrapper).scene.primitives.add).toHaveBeenCalled()
    })

    const added = mockViewerOf(wrapper).scene.primitives.add.mock.calls.map(([p]) => p)
    // 网格是那条 alpha 0.15 的 PolylineGlow（建筑描边是主强调蓝、alpha 1）
    const grid = added.find(
      (p) => p.appearance?.material?.uniforms?.color?.name === '#3b82f6'
    )
    expect(grid).toBeDefined()

    const instances = grid!.geometryInstances
    expect(instances.length).toBeGreaterThan(5)

    // 竖线（两端 x 相同）之间的间距 ≈ 200 米
    const verticals = instances.filter(
      (instance) => instance.geometry.positions[0].x === instance.geometry.positions[1].x
    )
    expect(verticals.length).toBeGreaterThan(1)
    const xs = verticals.map((instance) => instance.geometry.positions[0].x).sort((a, b) => a - b)
    const spacingMeters =
      (xs[1] - xs[0]) * 111320 * Math.cos((CENTER_LAT * Math.PI) / 180)
    expect(Math.abs(spacingMeters - 200)).toBeLessThan(5)

    // 网格要盖住数据范围（116.39 ~ 116.42）
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(116.389)
    expect(Math.max(...xs)).toBeLessThanOrEqual(116.421)

    wrapper.unmount()
  })

  it('1~2 级道路额外叠一层流动虚线', async () => {
    installFetch(stubFetchWithCity())

    const wrapper = mountSmartCity()
    await vi.waitFor(() => {
      expect(mockViewerOf(wrapper).scene.primitives.add).toHaveBeenCalled()
    })

    const added = mockViewerOf(wrapper).scene.primitives.add.mock.calls.map(([p]) => p)
    const flow = added.find((p) => p.appearance?.material?.type === 'PolylineDash')
    expect(flow).toBeDefined()
    expect(flow!.appearance.material.uniforms.dashLength).toBe(24)
    expect(flow!.appearance.material.uniforms.color?.name).toBe('#22d3ee')
    // 流动层与道路同宽（主干道 14），盖得住路面
    expect(flow!.geometryInstances[0].geometry.width).toBe(14)

    wrapper.unmount()
  })

  it('道路数据里的广场/地面多边形拿到深色材质（不是随机色）', async () => {
    // **回归测试**：`GeoJsonDataSource` 给没设过 material 的要素发的是
    // `Color.fromRandomColor()`（随机颜色）—— 广场就会在深色底上留下随机色斑点。
    // 注意这个要素**没有 polyline**：道路数据里的广场/地面是 Polygon。
    const plaza = {
      position: null,
      show: true,
      point: {},
      polygon: {},
      properties: { highway: { getValue: () => undefined } }
    } as unknown as MockEntity & { polygon: { material?: { name?: string } } }
    cesiumStub.GeoJsonDataSource.load.mockResolvedValue({ entities: { values: [plaza] } })

    const wrapper = mountSmartCity()
    wrapper.vm.roads = { type: 'FeatureCollection', features: [] }
    await wrapper.vm.loadGeoJSONRoads()

    expect(plaza.polygon.material?.name).toBe('#0d1a2e')

    wrapper.unmount()
  })
})

// ---------------------------------------------------------------------------
// 城市运行指标带：AQI / 天气 / 路网负载，带来源标注与时间戳
//
// 三条硬要求（都是行为断言，不读源码文本）：
// - 每个指标都显示来源与观测时间；
// - 模型估算的指标标「（模型估算）」；
// - 取不到的源显示「数据源暂不可用」，**不显示 0 或旧值**。
// ---------------------------------------------------------------------------
describe('SmartCity city metrics strip', () => {
  /** 指标带上的三个来源标注。 */
  const SOURCE_AIR = {
    name: '中国环境监测总站',
    url: 'https://air.cnemc.cn:18007/CityData/GetAllCityRealTimeAQIModels',
    observed_at: '2026-10-22T04:00:00Z',
    fetched_at: '2026-10-22T04:30:00Z',
    realtime: true,
    estimated: false,
  }
  const SOURCE_WEATHER = {
    name: '中国天气网',
    url: 'http://www.weather.com.cn/data/sk/101010100.html',
    observed_at: '2026-10-21T09:05:00Z',
    fetched_at: '2026-10-22T04:30:00Z',
    realtime: false,
    estimated: false,
  }
  const SOURCE_ROADS = {
    name: '本地 OSM 路网数据',
    url: 'backend-python/geojson/roads.geojson',
    observed_at: '2026-06-21T11:40:10Z',
    fetched_at: '2026-10-22T04:30:00Z',
    realtime: false,
    estimated: false,
  }

  /** 造一份城市指标载荷。`degrade` 里的 key 对应的指标值置 null。 */
  const overviewPayload = (degrade: string[] = []) => {
    const nulled = (key: string) => (degrade.includes(key) ? null : undefined)
    const aqiValue = degrade.includes('aqi') ? null : 51
    const tempValue = degrade.includes('weather_temp') ? null : 18
    const loadValue = degrade.includes('road_load_index') ? null : 63.5
    return {
      city: { code: 110000, name: '北京市', latitude: 40.05, longitude: 116.4 },
      generated_at: '2026-10-22T04:00:00Z',
      metrics: [
        {
          key: 'aqi',
          label: '空气质量',
          value: aqiValue,
          unit: 'AQI',
          level: 2,
          level_label: '良',
          extra: {},
          source: { ...SOURCE_AIR },
        },
        {
          key: 'weather_temp',
          label: '气温',
          value: tempValue,
          unit: '℃',
          extra: {},
          source: { ...SOURCE_WEATHER },
        },
        {
          key: 'road_load_index',
          label: '路网负载（模型估算）',
          value: loadValue,
          unit: '指数',
          extra: {},
          source: { ...SOURCE_ROADS, estimated: true },
        },
        {
          key: 'road_length_km',
          label: '路网总长',
          value: nulled('road_length_km') === null ? null : 202.173,
          unit: 'km',
          extra: {},
          source: { ...SOURCE_ROADS },
        },
      ],
      series: [],
      degraded: degrade.map(key => (key === 'aqi' ? '中国环境监测总站' : key)),
    }
  }

  /** API 桩：城市指标端点返回给定载荷，其余端点走通用桩。 */
  const stubOverviewFetch = (payload: unknown) =>
    vi.fn<(url: string, options: RequestInit) => Promise<Response>>((url) => {
      const target = String(url)
      if (target.includes('city/overview')) return Promise.resolve(jsonResponse(payload))
      if (target.includes('traffic-status')) return Promise.resolve(jsonResponse({ status: 'normal' }))
      return Promise.resolve(jsonResponse({ type: 'FeatureCollection', features: [] }))
    })

  it('shows AQI, weather and road load with their sources and timestamps', async () => {
    installFetch(stubOverviewFetch(overviewPayload()))

    const wrapper = mountSmartCity()
    await vi.waitFor(() => {
      expect(wrapper.find('.metric-strip').exists()).toBe(true)
    })

    const text = wrapper.find('.metric-strip').text()
    // 三个指标的值
    expect(text).toContain('51')
    expect(text).toContain('18℃')
    expect(text).toContain('63.5')
    // 空气质量的等级徽标
    expect(text).toContain('良')
    // 来源标注：来源名 + 观测时间
    expect(text).toContain('中国环境监测总站')
    expect(text).toContain('中国天气网')
    expect(text).toContain('本地 OSM 路网数据')
    // 模型估算项必须标出来
    expect(text).toContain('（模型估算）')
    // 路网负载的副标题：路网总长
    expect(text).toContain('路网总长')
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('NaN')

    wrapper.unmount()
  })

  it('shows 数据源暂不可用 instead of a fake value when a source is degraded', async () => {
    installFetch(stubOverviewFetch(overviewPayload(['aqi'])))

    const wrapper = mountSmartCity()
    await vi.waitFor(() => {
      expect(wrapper.find('.metric-strip').exists()).toBe(true)
    })

    const slots = wrapper.findAll('.metric-slot')
    const aqiSlot = slots[0]
    expect(aqiSlot.text()).toContain('数据源暂不可用')
    // **不许**显示 0 冒充取不到的指标（只看数值那一块，来源行里有时间戳）
    const aqiValue = aqiSlot.find('.metric-value').text()
    expect(aqiValue).toBe('数据源暂不可用')
    expect(aqiValue).not.toContain('0')
    // 没取到数据就不知道分级，不显示上一档的「良」
    expect(aqiSlot.find('.metric-badge').exists()).toBe(false)
    // 其它源照常显示
    expect(slots[1].text()).toContain('18℃')

    wrapper.unmount()
  })

  it('marks a stale source as not realtime', async () => {
    installFetch(stubOverviewFetch(overviewPayload()))

    const wrapper = mountSmartCity()
    await vi.waitFor(() => {
      expect(wrapper.find('.metric-strip').exists()).toBe(true)
    })

    // 天气源的上游时间戳不新鲜 —— 界面必须如实说，不能装作实时
    const slots = wrapper.findAll('.metric-slot')
    expect(slots[1].text()).toContain('非实时')
    expect(slots[0].text()).not.toContain('非实时')

    wrapper.unmount()
  })

  it('renders no metric strip before the overview arrives', async () => {
    installFetch(stubOverviewFetch(overviewPayload()))

    const wrapper = mountSmartCity()
    // 数据还没到时不显示任何数字（更不能显示 0）
    expect(wrapper.find('.metric-strip').exists()).toBe(false)

    await vi.waitFor(() => {
      expect(wrapper.find('.metric-strip').exists()).toBe(true)
    })

    wrapper.unmount()
  })
})

// ---------------------------------------------------------------------------
// DOM 契约回归：大屏骨架改的是**模板外层结构**，
// 下面这些类名与行为一个字都不许变。
//
// - `.control-panel` 里仍有 4 个按钮（隐藏建筑 / 隐藏道路 / 停止交通 / 切换视角）
// - `.traffic-status`（实时交通读数）
// - `.metric-strip`（S1 的指标带）
// - OSM 署名「数据 © OpenStreetMap contributors」（ODbL 硬性要求）
// ---------------------------------------------------------------------------
describe('大屏骨架的 DOM 契约', () => {
  const overviewStub = {
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
        extra: {},
        source: {
          name: '中国环境监测总站',
          url: 'https://air.cnemc.cn:18007/x',
          observed_at: '2026-10-22T04:00:00Z',
          fetched_at: '2026-10-22T04:30:00Z',
          realtime: true,
          estimated: false,
        },
      },
    ],
    series: [],
    facilities: [],
    degraded: [],
  }

  const stubWithOverview = () =>
    vi.fn<(url: string, options: RequestInit) => Promise<Response>>((url) => {
      const target = String(url)
      if (target.includes('city/overview')) {
        return Promise.resolve(jsonResponse(overviewStub))
      }
      if (target.includes('traffic-status')) {
        return Promise.resolve(
          jsonResponse({ status: 'normal', flow: 0.63, congestion: '畅通', update_time: '2026-10-21T04:52:31.123Z' }),
        )
      }
      return Promise.resolve(jsonResponse({ type: 'FeatureCollection', features: [] }))
    })

  it('keeps the control panel, its buttons, the traffic row and the attribution', async () => {
    installFetch(stubWithOverview())

    const wrapper = mountSmartCity()
    await vi.waitFor(() => {
      expect(wrapper.find('.metric-strip').exists()).toBe(true)
    })

    // 1) 控制面板 + 4 个开关按钮 + 1 个主题入口（位置搬进了通栏底栏，类名与行为不变）
    const panel = wrapper.find('.control-panel')
    expect(panel.exists()).toBe(true)
    const buttons = panel.findAll('button')
    expect(buttons).toHaveLength(5)
    expect(buttons.map(button => button.text())).toEqual([
      '隐藏建筑',
      '隐藏道路',
      '停止交通',
      '切换平视',
      // 主题入口：按钮上直接写着当前主题名
      expect.stringContaining('主题'),
    ])

    // 2) 实时交通读数
    expect(wrapper.find('.traffic-status').exists()).toBe(true)

    // 3) S1 的指标带
    expect(wrapper.find('.metric-strip').exists()).toBe(true)

    // 4) OSM 署名（ODbL：展示这份数据必须署名）
    expect(wrapper.text()).toContain('数据 © OpenStreetMap contributors')

    wrapper.unmount()
  })

  it('puts the readout band in the top bar and the control panel in the bottom bar', async () => {
    installFetch(stubWithOverview())

    const wrapper = mountSmartCity()
    await vi.waitFor(() => {
      expect(wrapper.find('.metric-strip').exists()).toBe(true)
    })

    // 读数带（指标带 + 实时交通）在顶栏右侧
    const top = wrapper.find('.dashboard-area-top')
    expect(top.find('.metric-strip').exists()).toBe(true)
    expect(top.find('.traffic-status').exists()).toBe(true)

    // 控制面板（4 个开关按钮 + 1 个主题入口 + OSM 署名）在通栏底栏右侧
    const bottom = wrapper.find('.dashboard-area-bottom')
    expect(bottom.find('.control-panel').exists()).toBe(true)
    expect(bottom.findAll('.control-panel button')).toHaveLength(5)
    expect(bottom.text()).toContain('OpenStreetMap contributors')

    // 左列只剩「核心指标」+「24 小时趋势」两块（风格板线框的「左列两卡」）
    const left = wrapper.find('.dashboard-area-left')
    expect(left.findAll('.dc-panel')).toHaveLength(2)
    // 同一个数字不在大屏上出现两次：读数带的三个指标不出现在左列卡片里
    const leftText = left.text()
    expect(leftText).not.toContain('空气质量')
    expect(leftText).not.toContain('气温')

    wrapper.unmount()
  })

  it('mounts the 16:9 dashboard skeleton around the Cesium container', async () => {
    installFetch(stubWithOverview())

    const wrapper = mountSmartCity()
    await flushPromises()

    // overlay 是浮在场景之上的：Cesium 容器保持全屏，面板浮在上面
    expect(wrapper.find('.cesium-container').exists()).toBe(true)
    expect(wrapper.find('.dashboard-overlay').exists()).toBe(true)
    expect(wrapper.find('.dashboard-grid').exists()).toBe(true)
    // 顶栏 + 5 个页签
    expect(wrapper.find('.dc-topbar').exists()).toBe(true)
    expect(wrapper.findAll('.dc-tab')).toHaveLength(5)

    wrapper.unmount()
  })
})

// ---------------------------------------------------------------------------
// 派生事件流 + 场景联动
//
// 全部是**行为断言**：mount 组件 → 触发真实交互 → 看可观察效果。
// ---------------------------------------------------------------------------

/** 事件流的来源标注。 */
const S3_SOURCE = {
  name: '中国环境监测总站',
  url: 'https://air.cnemc.cn:18007/x',
  observed_at: '2026-10-22T04:00:00Z',
  fetched_at: '2026-10-22T04:30:00Z',
  realtime: true,
  estimated: false,
}

/** 全市级事件（空气质量）：后端给的坐标是**数据范围中心**，前端按 kind 改用城心。 */
const S3_CITY_EVENT: CityEvent = {
  id: 'air_quality:level_change:2026-10-22T03:00:00Z',
  type: 'air_quality',
  level: 'info',
  title: '空气质量由优转为良',
  detail: '按 AQI 分级标准换算',
  time: '2026-10-22T03:00:00Z',
  location_kind: 'city',
  location: { lng: 116.4020155, lat: 39.9153679, label: '数据范围中心' },
  metric_key: 'aqi_24h',
  source: S3_SOURCE,
  estimated: false,
}

/** 几何锚定事件（路网负载）：位置是真实几何上的点，不许被换成城心。 */
const S3_GEOMETRY_EVENT: CityEvent = {
  id: 'road_load:over_threshold:92.4',
  type: 'road_load',
  level: 'alert',
  title: '路网负载指数 92.4 超过参考阈值 80',
  detail: '静态几何折算的供给紧张度（模型估算）',
  time: '2026-10-22T09:00:00Z',
  location_kind: 'geometry',
  location: { lng: 116.41, lat: 39.92, label: '主路段（OSM way/41662973）' },
  metric_key: 'road_load_index',
  source: S3_SOURCE,
  estimated: true,
}

/** 一栋带 OSM id 的建筑（焦点集合按 id 匹配）。 */
const s3BuildingFeature = (id: string) => ({
  type: 'Feature',
  id,
  properties: { building: 'yes' },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [116.4, 39.91],
        [116.401, 39.91],
        [116.401, 39.911],
        [116.4, 39.911],
        [116.4, 39.91],
      ],
    ],
  },
})

/** 一条主干道（1~2 级道路会叠一层流动光效）。 */
const s3RoadFeature = {
  type: 'Feature',
  id: 'way/1',
  properties: { highway: 'primary' },
  geometry: {
    type: 'LineString',
    coordinates: [
      [116.39, 39.9],
      [116.42, 39.9],
    ],
  },
}

const s3Overview = (events: CityEvent[]): CityOverview => ({
  city: { code: 110000, name: '北京市', latitude: 40.05, longitude: 116.4 },
  generated_at: '2026-10-22T04:00:00Z',
  metrics: [
    {
      key: 'aqi',
      label: '空气质量',
      value: 58,
      unit: 'AQI',
      level: 2,
      level_label: '良',
      source: S3_SOURCE,
    },
    {
      key: 'road_load_index',
      label: '路网负载（模型估算）',
      value: 63.5,
      unit: '指数',
      source: S3_SOURCE,
    },
    {
      key: 'weather_temp',
      label: '气温',
      value: 18,
      unit: '℃',
      source: S3_SOURCE,
    },
  ],
  series: [],
  facilities: [
    {
      key: 'heritage',
      label: '历史建筑',
      count: 1,
      criteria: [],
      members: ['relation/1'],
      source: S3_SOURCE,
    },
  ],
  events,
  degraded: [],
})

/** 后端四个端点的桩：建筑带 id（焦点集合要按 id 匹配）。 */
const stubS3Api = (events: CityEvent[]) =>
  vi.fn<(url: string, options: RequestInit) => Promise<Response>>((url) => {
    const target = String(url)
    if (target.includes('city/overview')) {
      return Promise.resolve(jsonResponse(s3Overview(events)))
    }
    if (target.includes('traffic-status')) {
      return Promise.resolve(jsonResponse({ status: 'normal' }))
    }
    if (target.includes('buildings')) {
      return Promise.resolve(
        jsonResponse({
          type: 'FeatureCollection',
          features: [s3BuildingFeature('relation/1')],
        }),
      )
    }
    if (target.includes('roads')) {
      return Promise.resolve(
        jsonResponse({ type: 'FeatureCollection', features: [s3RoadFeature] }),
      )
    }
    return Promise.resolve(jsonResponse({ type: 'FeatureCollection', features: [] }))
  })

describe('派生事件流与场景联动', () => {
  const eventPayload = S3_CITY_EVENT
  const geometryEventPayload = S3_GEOMETRY_EVENT
  const stubApi = stubS3Api

  /** 从 primitives.add 的调用里挑出某个颜色的 Primitive。 */
  const primitiveWithColor = (
    wrapper: VueWrapper<SmartCityVm>,
    hex: string,
  ): MockPrimitive | undefined => {
    const calls = mockViewerOf(wrapper).scene.primitives.add.mock.calls
    return calls
      .map(([primitive]) => primitive)
      .find(primitive => primitive.appearance.material.uniforms.color.name === hex)
  }

  /**
   * 找出「焦点描边」那条 Primitive。
   *
   * 它是辉光材质 + 数据流色；流动光效层也是数据流色，但用的是虚线材质
   * （没有 glowPower），所以靠 glowPower 区分。
   */
  const focusPrimitiveOf = (
    wrapper: VueWrapper<SmartCityVm>,
  ): MockPrimitive | undefined =>
    mockViewerOf(wrapper)
      .scene.primitives.add.mock.calls.map(([primitive]) => primitive)
      .find(
        primitive =>
          primitive.appearance.material.uniforms.color.name === DARK_PALETTE.flow &&
          primitive.appearance.material.uniforms.glowPower !== undefined,
      )

  beforeEach(() => {
    // 页签状态是模块级单例：每个用例先复位。
    useDashboardState().setTab(DEFAULT_TAB_KEY)
  })

  it('shows an explanatory empty state and no invented entry when there is no event', async () => {
    installFetch(stubApi([]))

    const wrapper = mountSmartCity()
    await vi.waitFor(() => {
      expect(wrapper.find('.dc-event-empty').exists()).toBe(true)
    })

    // 空态要说明「检查了哪些条件、为什么没触发」
    await vi.waitFor(() => {
      expect(wrapper.find('.dc-event-empty').text()).toContain('当前无触发事件')
    })
    const empty = wrapper.find('.dc-event-empty').text()
    expect(empty).toContain('路网负载 63.5 低于阈值 80')
    // 一条编造的条目都不许有
    expect(wrapper.findAll('.dc-event-item')).toHaveLength(0)

    wrapper.unmount()
  })

  it('renders the derived events and flies the camera to the clicked one', async () => {
    installFetch(stubApi([eventPayload]))

    const wrapper = mountSmartCity()
    await vi.waitFor(() => {
      expect(wrapper.findAll('.dc-event-item').length).toBe(1)
    })

    const item = wrapper.find('.dc-event-item')
    expect(item.text()).toContain('空气质量由优转为良')
    // 全市级事件的位置标签是「城心（全市指标）」
    expect(item.text()).toContain('城心（全市指标）')

    const flyTo = mockViewerOf(wrapper).camera.flyTo
    flyTo.mockClear()
    await item.trigger('click')

    // 相机确实飞过去了：目标高度 800 m、俯角 45°、朝北
    expect(flyTo).toHaveBeenCalledTimes(1)
    const call = flyTo.mock.calls[0][0] as unknown as {
      destination: { x: number; y: number; z: number }
      orientation: { heading: number; pitch: number }
      duration: number
    }
    expect(call.destination.z).toBe(800)
    // 落点是**城心**（= 相机的绕行中心），不是后端给的数据范围中心
    expect(call.destination.x).toBe(116.3976)
    expect(call.orientation.pitch).toBeCloseTo(-Math.PI / 4)
    expect(call.orientation.heading).toBe(0)
    expect(call.duration).toBe(1.2)

    wrapper.unmount()
  })

  it('flies to the real geometry of an anchored event', async () => {
    installFetch(stubApi([geometryEventPayload]))

    const wrapper = mountSmartCity()
    await vi.waitFor(() => {
      expect(wrapper.findAll('.dc-event-item').length).toBe(1)
    })

    const item = wrapper.find('.dc-event-item')
    // 几何锚定事件的位置标签是真实道路
    expect(item.text()).toContain('主路段（OSM way/41662973）')

    const flyTo = mockViewerOf(wrapper).camera.flyTo
    flyTo.mockClear()
    await item.trigger('click')

    expect(flyTo).toHaveBeenCalledTimes(1)
    const call = flyTo.mock.calls[0][0] as unknown as {
      destination: { x: number; y: number; z: number }
    }
    // 落点是真实几何上的点，**不是**城心
    expect(call.destination.x).toBe(116.41)
    expect(call.destination.x).not.toBe(116.3976)

    wrapper.unmount()
  })

  it('highlights the focused buildings on a tab and restores everything when switching back', async () => {
    installFetch(stubApi([]))

    const wrapper = mountSmartCity()
    await vi.waitFor(() => {
      expect(primitiveWithColor(wrapper, DARK_PALETTE.accent)).toBeDefined()
    })

    // 常态：描边是强调蓝，没有焦点描边
    expect(primitiveWithColor(wrapper, DARK_PALETTE.accent)).toBeDefined()
    expect(focusPrimitiveOf(wrapper)).toBeUndefined()

    // 切到「城市文旅」：其余建筑压暗 + 焦点建筑高亮
    useDashboardState().setTab('heritage')
    await nextTick()

    expect(primitiveWithColor(wrapper, BUILDING_GLOW_DIMMED)).toBeDefined()
    const focus = focusPrimitiveOf(wrapper)
    expect(focus).toBeDefined()
    // 焦点集合来自后端 members（relation/1）→ 一栋楼一条轮廓
    expect(focus!.geometryInstances).toHaveLength(1)

    // 切回「区域概览」：完全恢复（不留残留的高亮）
    useDashboardState().setTab(DEFAULT_TAB_KEY)
    await nextTick()

    expect(primitiveWithColor(wrapper, DARK_PALETTE.accent)).toBeDefined()
    expect(primitiveWithColor(wrapper, BUILDING_GLOW_DIMMED)).toBeUndefined()
    // 焦点描边必须从场景里拆掉
    const removed = mockViewerOf(wrapper).scene.primitives.remove.mock.calls
    expect(removed.map(([primitive]) => primitive)).toContain(focus)

    wrapper.unmount()
  })

  it('brightens the flow layer on the network tab without dimming the buildings', async () => {
    installFetch(stubApi([]))

    const wrapper = mountSmartCity()
    await vi.waitFor(() => {
      expect(primitiveWithColor(wrapper, DARK_PALETTE.accent)).toBeDefined()
    })

    useDashboardState().setTab('network')
    await nextTick()

    // 建筑没有被压暗
    expect(primitiveWithColor(wrapper, BUILDING_GLOW_DIMMED)).toBeUndefined()
    // 流动光效层被提亮
    const flow = mockViewerOf(wrapper).scene.primitives.add.mock.calls
      .map(([primitive]) => primitive)
      .find(primitive => primitive.appearance.material.type === 'PolylineDash')
    expect(flow!.appearance.material.uniforms.color.name).toBe(FLOW_HIGHLIGHT)

    wrapper.unmount()
  })

  it('leaves no leftover entities after unmount', async () => {
    installFetch(stubApi([eventPayload]))

    const wrapper = mountSmartCity()
    await vi.waitFor(() => {
      expect(wrapper.findAll('.dc-event-item').length).toBe(1)
    })

    const entitiesRemove = mockViewerOf(wrapper).entities.remove
    const primitivesRemove = mockViewerOf(wrapper).scene.primitives.remove
    entitiesRemove.mockClear()
    primitivesRemove.mockClear()

    wrapper.unmount()

    // 事件标记（光柱 / 圆柱 / 脉冲环）必须全部清掉：重新挂载不许叠加
    expect(entitiesRemove.mock.calls.length).toBeGreaterThan(0)
    expect(primitivesRemove.mock.calls.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 事件标记在**默认鸟瞰视角**下的屏幕位置
//
// 这条是「告警脉冲环 + 垂直光柱」的生死线：标记落在屏幕外的话，
// 用户第一眼根本看不到这个功能。
//
// 做法：**不写死相机参数** —— 从 Cesium mock 的 `setView` 调用里读出组件真正的
// 相机位姿（高度 / 俯角 / 方位角），再按 Cesium 的真实视场角做投影，
// 绕城心扫一整圈，断言标记**每一帧都在画布内**。
//
// 之前的事件位置（后端的「数据范围中心」= OSM 围盒中心）比城心偏北约 1.1 km：
// 相机转到某些方位角时它落到屏幕下方之外（实测 y=1272 > 画布高 900）。
// 最后一条断言专门盯住这个回归。
// ---------------------------------------------------------------------------
describe('事件标记的屏幕位置', () => {
  const CANVAS = { width: 1600, height: 900 }
  /** Cesium 的默认视场角（60°，作用在宽的一边）。 */
  const FOV_RAD = Math.PI / 3
  const METERS_PER_DEGREE_LAT = 111320

  interface Vec3 {
    x: number
    y: number
    z: number
  }

  const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
  const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
  const cross = (a: Vec3, b: Vec3): Vec3 => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  })
  const normalize = (v: Vec3): Vec3 => {
    const length = Math.hypot(v.x, v.y, v.z)
    return { x: v.x / length, y: v.y / length, z: v.z / length }
  }

  /**
   * 把世界点投到屏幕坐标（像素）。
   *
   * 局部 ENU 框架：x=东、y=北、z=上，原点在**城心**。
   *
   * `forward` 是**相机自己的视线方向**（鸟瞰模式下相机永远盯着城心），
   * 不能拿「相机→点」的方向当视线 —— 那样每个点都会落在屏幕中心，
   * 投影就失去意义了。
   */
  const project = (
    point: Vec3,
    camera: Vec3,
    forward: Vec3,
  ): { x: number; y: number } | null => {
    const right = normalize(cross(forward, { x: 0, y: 0, z: 1 }))
    const up = cross(right, forward)
    const view = sub(point, camera)
    const depth = dot(view, forward)
    if (depth <= 0) return null
    const halfWidth = Math.tan(FOV_RAD / 2)
    const halfHeight = (halfWidth * CANVAS.height) / CANVAS.width
    const ndcX = dot(view, right) / depth / halfWidth
    const ndcY = dot(view, up) / depth / halfHeight
    return {
      x: ((ndcX + 1) / 2) * CANVAS.width,
      y: ((1 - ndcY) / 2) * CANVAS.height,
    }
  }

  /** 从组件真正的相机位姿推出绕行中心与轨道参数。 */
  const readOrbitFrom = (wrapper: VueWrapper<SmartCityVm>) => {
    // initCesium 的初始定位走 flyTo（不是 setView）—— 两个都看一眼，谁有算谁。
    const flyToCalls = mockViewerOf(wrapper).camera.flyTo.mock.calls
    const setViewCalls = mockViewerOf(wrapper).camera.setView.mock.calls
    const calls = flyToCalls.length > 0 ? flyToCalls : setViewCalls
    expect(calls.length).toBeGreaterThan(0)
    const initial = calls[0][0] as unknown as {
      destination: { x: number; y: number; z: number }
      orientation: { heading: number; pitch: number; roll: number }
    }
    const altitude = initial.destination.z
    const pitch = initial.orientation.pitch
    // 水平距离 = 高度 / tan(俯角)（与组件的 OVERHEAD_DISTANCE_M 同一口径）
    const distance = altitude / Math.tan(Math.abs(pitch))
    // 方位角：heading = 方位角 + 180°
    const azimuth = initial.orientation.heading - Math.PI
    const centerLatRad = (initial.destination.y * Math.PI) / 180
    const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos(centerLatRad)
    // 相机在城心的哪个方向 → 反推城心
    const center = {
      lng: initial.destination.x - (distance * Math.sin(azimuth)) / metersPerDegreeLng,
      lat: initial.destination.y - (distance * Math.cos(azimuth)) / METERS_PER_DEGREE_LAT,
    }
    return { altitude, distance, azimuth, center, metersPerDegreeLng }
  }

  /** 世界经纬度 → 局部 ENU 坐标（相对城心）。 */
  const toLocal = (
    lng: number,
    lat: number,
    center: { lng: number; lat: number },
    metersPerDegreeLng: number,
  ): Vec3 => ({
    x: (lng - center.lng) * metersPerDegreeLng,
    y: (lat - center.lat) * METERS_PER_DEGREE_LAT,
    z: 0,
  })

  /** 方位角 → 相机位置（局部 ENU）。 */
  const cameraAt = (azimuth: number, distance: number, altitude: number): Vec3 => ({
    x: distance * Math.sin(azimuth),
    y: distance * Math.cos(azimuth),
    z: altitude,
  })

  /**
   * 方位角 → 相机视线方向（鸟瞰模式下相机永远盯着城心）。
   */
  const forwardAt = (azimuth: number): Vec3 => {
    const camera = cameraAt(azimuth, 1, 0)
    return normalize({ x: -camera.x, y: -camera.y, z: -1 })
  }

  it('keeps a city-level event marker inside the canvas for the whole orbit', async () => {
    installFetch(stubS3Api([S3_CITY_EVENT]))

    const wrapper = mountSmartCity()
    await vi.waitFor(() => {
      expect(wrapper.findAll('.dc-event-item').length).toBe(1)
    })

    // 标记的落点：组件解析好的（全市级 → 城心）
    const marker = wrapper.vm.resolvedEvents[0]!.location!
    expect(marker).toBeDefined()
    const orbit = readOrbitFrom(wrapper)
    const local = toLocal(marker.lng, marker.lat, orbit.center, orbit.metersPerDegreeLng)

    // 绕城心扫一整圈：每一帧标记都必须在画布内
    for (let degrees = 0; degrees < 360; degrees += 15) {
      const azimuth = (degrees * Math.PI) / 180
      const camera = cameraAt(azimuth, orbit.distance, orbit.altitude)
      const screen = project(local, camera, forwardAt(azimuth))
      expect(screen).not.toBeNull()
      expect(screen!.x).toBeGreaterThanOrEqual(0)
      expect(screen!.x).toBeLessThanOrEqual(CANVAS.width)
      expect(screen!.y).toBeGreaterThanOrEqual(0)
      expect(screen!.y).toBeLessThanOrEqual(CANVAS.height)
    }

    wrapper.unmount()
  })

  it('would have been off-screen with the old data-extent-centre location', () => {
    // 回归对照：后端的「数据范围中心」（OSM 围盒中心）比城心偏北约 1.1 km。
    // 用它当标记落点，相机转到某些方位角时它会掉到屏幕下方之外 ——
    // 这正是修掉的缺陷，所以这条断言钉住「不能退回那个位置」。
    const CITY_CENTER = { lng: 116.3976, lat: 39.9055 }
    const DATA_EXTENT_CENTER = { lng: 116.4020155, lat: 39.9153679 }
    const altitude = 1500
    const distance = 1500
    const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos((CITY_CENTER.lat * Math.PI) / 180)

    const local = toLocal(
      DATA_EXTENT_CENTER.lng,
      DATA_EXTENT_CENTER.lat,
      CITY_CENTER,
      metersPerDegreeLng,
    )

    let offScreen = 0
    for (let degrees = 0; degrees < 360; degrees += 15) {
      const azimuth = (degrees * Math.PI) / 180
      const screen = project(local, cameraAt(azimuth, distance, altitude), forwardAt(azimuth))
      if (!screen || screen.x < 0 || screen.x > CANVAS.width || screen.y < 0 || screen.y > CANVAS.height) {
        offScreen += 1
      }
    }
    expect(offScreen).toBeGreaterThan(0)
  })
})