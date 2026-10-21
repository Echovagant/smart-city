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
  CityViewState,
  RoadsResponse,
  TrafficStatus,
} from '../../../types/city'

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
      { fromDegrees: vi.fn((lng: number, lat: number, height: number) => ({ x: lng, y: lat, z: height })) },
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
    setView: Mock<(options: unknown) => void>
  }
  scene: {
    globe: { enableLighting: boolean; baseColor: unknown }
    fog: { density: number; near: number; far: number }
    postProcessStages: { fxaa: { enabled: boolean } }
    maximumFrameRate: number
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

// 组件源码只用于一处断言：Viewer 构造选项（见 plan 013 Step 2）。
// 构造函数选项没法从 mock 里观察得到，只能限定在选项块内做文本断言。
//
// 路径解析不能用 `new URL('../SmartCity.vue', import.meta.url)`：jsdom 的全局 URL
// 不把 file: 当特殊协议，相对路径会被解析成 http://localhost:3000/...，
// fileURLToPath 随即抛 "The URL must be of scheme file"。
// 直接对 import.meta.url 本身做 fileURLToPath 可绕开。
const componentSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../SmartCity.vue'),
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
    const options = extractViewerOptions(componentSource)
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

    // 底座自绘：一次影像图层都不加（既没有高德瓦片，也没有 ion 底图）。
    // 地面是纯色底 + 自绘网格，建筑与道路都画在 OSM 的原始 WGS-84 坐标上。
    expect(mockViewerOf(wrapper).imageryLayers.add).not.toHaveBeenCalled()

    wrapper.unmount()
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
    expect(buttons).toHaveLength(4)

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
