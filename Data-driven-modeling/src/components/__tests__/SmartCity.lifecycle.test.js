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
})
