import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub cesium BEFORE importing SmartCity. The module exports everything as
// functions or constructors; returning empty objects is enough to keep
// SmartCity's onMounted from throwing during a jsdom mount.
vi.mock('cesium', () => {
  const colorWithAlpha = vi.fn(() => ({}))
  const namedColor = (name) => ({ name, withAlpha: colorWithAlpha })
  const Color = Object.assign(vi.fn(), {
    RED: namedColor('red'),
    GREEN: namedColor('green'),
    YELLOW: namedColor('yellow'),
    WHITE: namedColor('white'),
    DARKGRAY: namedColor('darkgray'),
    GRAY: namedColor('gray'),
    withAlpha: colorWithAlpha,
    // 按传入的 CSS 字符串返回不同的颜色对象：真实 Cesium 里每个色值都是独立实例，
    // mock 若一律返回同一个名字，就无法断言"两种道路的颜色不同"。
    fromCssColorString: vi.fn((css) => namedColor(css)),
  })
  return {
    Viewer: vi.fn().mockImplementation(() => ({
      destroy: vi.fn(),
      camera: {
        flyTo: vi.fn(),
      },
      scene: {
        globe: { enableLighting: false },
        fog: {},
        postProcessStages: { fxaa: {} },
        maximumFrameRate: 0,
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
      vi.fn().mockImplementation((x, y, z) => ({ x, y, z })),
      { fromDegrees: vi.fn(() => ({ x: 0, y: 0, z: 0 })) },
    ),
    Color,
    Ion: { defaultAccessToken: '' },
    SceneMode: { SCENE3D: 0 },
    // Cesium 1.104+ 把 OpenStreetMapImageryProvider 改成异步工厂 fromUrl。
    OpenStreetMapImageryProvider: Object.assign(vi.fn(), {
      fromUrl: vi.fn().mockResolvedValue({}),
    }),
    // UrlTemplateImageryProvider 仍为同步构造器，initCesium 中显式 new。
    UrlTemplateImageryProvider: vi.fn(),
    // initCesium 把 UrlTemplateImageryProvider 包成 ImageryLayer 后传给 Viewer。
    ImageryLayer: vi.fn().mockImplementation((provider) => ({ provider })),
    Credit: vi.fn(),
    GeoJsonDataSource: { load: vi.fn().mockResolvedValue({ entities: { values: [] } }) },
    EntityCluster: vi.fn(),
    Math: { toRadians: vi.fn((deg) => deg) },
    VerticalOrigin: { CENTER: 0 },
    HorizontalOrigin: { CENTER: 0 },
    HeightReference: { CLAMP_TO_GROUND: 0 },
  }
})

import * as Cesium from 'cesium'
import SmartCity from '../SmartCity.vue'

describe('SmartCity lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('cancels in-flight requestAnimationFrame on unmount', async () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame')
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame')

    const wrapper = mount(SmartCity, {
      attachTo: document.body,
    })

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
    const frameQueue = []
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameQueue.push(callback)
      return frameQueue.length
    })

    const wrapper = mount(SmartCity, {
      attachTo: document.body,
    })
    wrapper.vm.createTrafficSystem()

    // cesium mock 的 entities.add 会忽略入参，但 mock.calls 记录了传入的 options，
    // 用 name 找到车辆实体对应的返回值（mock.results[i].value）。
    const addMock = wrapper.vm.viewer.entities.add
    const vehicleIndex = addMock.mock.calls.findIndex(
      ([options]) => options.name && options.name.startsWith('Vehicle')
    )
    expect(vehicleIndex).toBeGreaterThan(-1)
    const vehicle = addMock.mock.results[vehicleIndex].value

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

    const wrapper = mount(SmartCity, {
      attachTo: document.body,
    })
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
    const makeEntity = (props) => ({
      polyline: {},
      properties: Object.fromEntries(
        Object.entries(props).map(([key, value]) => [key, { getValue: () => value }])
      )
    })

    const primary = makeEntity({ highway: 'primary' })
    const footway = makeEntity({ highway: 'footway' })
    const unknown = makeEntity({ highway: 'motorway_link' }) // 表外的取值
    const primaryWithWideTag = makeEntity({ highway: 'primary', width: '30' })
    const footwayWithWidth = makeEntity({ highway: 'footway', width: '2' })

    const loadMock = Cesium.GeoJsonDataSource.load
    loadMock.mockResolvedValue({
      entities: { values: [primary, footway, unknown, primaryWithWideTag, footwayWithWidth] }
    })

    const wrapper = mount(SmartCity, {
      attachTo: document.body,
    })
    // 直接给 composable 的 roads 塞一份空集合，绕开网络请求
    wrapper.vm.roads = { type: 'FeatureCollection', features: [] }
    await wrapper.vm.loadGeoJSONRoads()
    // 复原 mock，别污染其它用例
    loadMock.mockResolvedValue({ entities: { values: [] } })

    // 不同等级：颜色不同、宽度不同
    expect(primary.polyline.material).not.toBe(footway.polyline.material)
    expect(primary.polyline.material.name).not.toBe(footway.polyline.material.name)
    expect(primary.polyline.width).toBeGreaterThan(footway.polyline.width)
    // 宽度必须是数字，不能是 OSM 的原始字符串
    expect(typeof primary.polyline.width).toBe('number')
    expect(typeof footway.polyline.width).toBe('number')

    // width 标签只在"正数且不超过该等级默认宽度"时采用：
    // '2' 米的人行道照用，'30' 米的异常值退回等级默认宽度
    expect(footwayWithWidth.polyline.width).toBe(2)
    expect(primaryWithWideTag.polyline.width).toBe(primary.polyline.width)

    // 表外的 highway 取值落到兜底等级（最低宽度，但用的是兜底自己的配色）
    expect(unknown.polyline.width).toBe(footway.polyline.width)
    expect(unknown.polyline.material.name).not.toBe(footway.polyline.material.name)

    wrapper.unmount()
  })
})
