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
    fromCssColorString: vi.fn(() => namedColor('css')),
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
})
