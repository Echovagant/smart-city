import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { ScenePrimitives } from '../useSceneStage'

/**
 * Cesium 的测试桩（**只在测试里用**）。
 *
 * 场景层拆成 composable 之后，每个 composable 都要能单独测，
 * 所以这里给出一份共享的最小 Cesium 桩：
 *
 * - `Viewer` / `ScreenSpaceEventHandler` / `GeoJsonDataSource` 是**假**的
 *   （真身要么要 WebGL，要么要发请求）；
 * - `Cartesian3` / `GeometryInstance` / `PolylineGeometry` / `Material` 保持
 *   **可用的形状**（桩里保留几何参数，测试才能断言高度、宽度、颜色）。
 */

/** 桩里的实体。 */
export interface StubEntity {
  position: unknown
  show: boolean
  point: Record<string, unknown>
  polygon: Record<string, unknown>
  polyline: Record<string, unknown>
  properties?: Record<string, { getValue: () => unknown }>
}

/** 桩里的 Viewer。 */
export interface StubViewer {
  destroy: Mock<() => void>
  /** ScreenSpaceEventHandler 要一个真实的 canvas 元素。 */
  canvas: HTMLCanvasElement
  camera: {
    flyTo: Mock<(options: unknown) => void>
    setView: Mock<(options: unknown) => void>
    /** 自转恢复时用它反算轨道（经纬度是**弧度**）。 */
    positionCartographic: { longitude: number; latitude: number; height: number }
  }
  scene: {
    globe: { enableLighting: boolean; baseColor: unknown; showGroundAtmosphere: boolean }
    skyAtmosphere: { show: boolean }
    skyBox: { show: boolean }
    backgroundColor: unknown
    fog: { density: number; near: number; far: number }
    postProcessStages: { fxaa: { enabled: boolean } }
    maximumFrameRate: number
    preRender: {
      addEventListener: Mock<(listener: () => void) => void>
      removeEventListener: Mock<(listener: () => void) => void>
    }
    primitives: {
      add: Mock<(primitive: unknown) => void>
      remove: Mock<(primitive: unknown) => void>
    }
  }
  entities: {
    add: Mock<(descriptor: unknown) => StubEntity>
    remove: Mock<(entity: unknown) => void>
    values: StubEntity[]
  }
  dataSources: { add: Mock<(source: unknown) => void> }
  imageryLayers: {
    length: number
    add: Mock<(layer: unknown) => void>
    removeAll: Mock<() => void>
    get: Mock<(index: number) => unknown>
  }
}

/** 桩模块的形状。 */
export interface CesiumStub {
  Viewer: Mock<() => StubViewer>
  Cartesian3: unknown
  Color: unknown
  Material: { fromType: Mock<(type: string, uniforms: unknown) => { type: string; uniforms: unknown }> }
  MaterialProperty: Mock<(material: unknown) => { material: unknown; getValue: () => unknown; isConstant: boolean }>
  PolylineGlowMaterialProperty: Mock<(options: Record<string, unknown>) => Record<string, unknown>>
  ColorMaterialProperty: Mock<(color: unknown) => { color: unknown; isConstant: boolean }>
  PolylineDashMaterialProperty: Mock<(options: Record<string, unknown>) => Record<string, unknown>>
  ConstantProperty: Mock<(value: unknown) => { value: unknown; isConstant: boolean }>
  Primitive: Mock<(options: Record<string, unknown>) => Record<string, unknown> & { show: boolean }>
  GeometryInstance: Mock<(options: Record<string, unknown>) => Record<string, unknown>>
  PolylineGeometry: Mock<(options: Record<string, unknown>) => Record<string, unknown>>
  PolylineMaterialAppearance: Mock<(options: Record<string, unknown>) => Record<string, unknown>> &
    { VERTEX_FORMAT: { position: boolean; st: boolean } }
  ArcType: { GEODESIC: number; RHUMB: number }
  ScreenSpaceEventHandler: Mock<
    () => { setInputAction: Mock<(action: () => void) => void>; destroy: Mock<() => void> }
  >
  ScreenSpaceEventType: Record<string, number>
  CallbackProperty: Mock<
    (callback: (...args: unknown[]) => unknown, isConstant?: boolean) => {
      callback: (...args: unknown[]) => unknown
      isConstant: boolean
      getValue: (...args: unknown[]) => unknown
    }
  >
  GeoJsonDataSource: { load: Mock<(data: unknown, options?: unknown) => Promise<unknown>> }
  SceneMode: { SCENE3D: number }
  /** 桩里创建出来的 Viewer（按创建顺序）。 */
  viewers: StubViewer[]
}

/** 当前这份桩（测试里用 `getCesiumStub()` 取）。 */
let active: CesiumStub | null = null

/**
 * 造一份空的场景材质登记表（测试里用）。
 *
 * 场景底座把「所有会被换色的材质」都挂在这一份上，
 * 所以测试里造一份空的就行 —— 需要哪一样再自己填。
 */
export const makeScenePrimitives = (): ScenePrimitives => ({
  buildingGlow: null,
  buildingGlowMaterial: null,
  flow: null,
  flowMaterial: null,
  focusGlow: null,
  gridMaterial: null,
  buildingMaterial: null,
  surfaceMaterial: null,
  roadMaterials: new Map(),
})

/** 取当前这份 Cesium 桩。 */
export const getCesiumStub = (): CesiumStub => {
  if (!active) throw new Error('Cesium 桩还没创建：vi.mock 的工厂还没跑过')
  return active
}

/** 造一份 Cesium 桩（`vi.mock` 的工厂调它）。 */
export const createCesiumStub = (): CesiumStub => {
  const makeColor = (name: string, alpha = 1) => ({
    name,
    alpha,
    withAlpha: (next: number) => makeColor(name, next),
  })

  const viewers: StubViewer[] = []

  const makeViewer = (): StubViewer => ({
    destroy: vi.fn(),
    canvas: document.createElement('canvas'),
    camera: {
      flyTo: vi.fn(),
      setView: vi.fn(),
      positionCartographic: { longitude: 0, latitude: 0, height: 0 },
    },
    scene: {
      globe: { enableLighting: false, baseColor: null, showGroundAtmosphere: true },
      skyAtmosphere: { show: true },
      skyBox: { show: true },
      backgroundColor: null,
      fog: { density: 0, near: 0, far: 0 },
      postProcessStages: { fxaa: { enabled: false } },
      maximumFrameRate: 0,
      preRender: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      primitives: { add: vi.fn(), remove: vi.fn() },
    },
    entities: {
      add: vi.fn(() => ({ position: null, show: true, point: {}, polygon: {}, polyline: {} })),
      remove: vi.fn(),
      values: [],
    },
    dataSources: { add: vi.fn() },
    imageryLayers: { add: vi.fn(), removeAll: vi.fn(), length: 0, get: vi.fn() },
  })

  const stub: CesiumStub = {
    Viewer: vi.fn(() => {
      const viewer = makeViewer()
      viewers.push(viewer)
      return viewer
    }),
    Cartesian3: Object.assign(
      vi.fn().mockImplementation((x: number, y: number, z: number) => ({ x, y, z })),
      {
        fromDegrees: vi.fn((lng: number, lat: number, height: number) => ({
          x: lng,
          y: lat,
          z: height,
          clone: () => ({ x: lng, y: lat, z: height, clone: () => ({ x: lng, y: lat, z: height }) }),
        })),
      },
    ),
    Color: Object.assign(vi.fn(), {
      RED: makeColor('red'),
      GREEN: makeColor('green'),
      YELLOW: makeColor('yellow'),
      WHITE: makeColor('white'),
      DARKGRAY: makeColor('darkgray'),
      GRAY: makeColor('gray'),
      TRANSPARENT: makeColor('transparent'),
      withAlpha: vi.fn((alpha: number) => makeColor('alpha', alpha)),
      fromCssColorString: vi.fn((css: string) => makeColor(css)),
    }),
    Material: {
      fromType: vi.fn((type: string, uniforms: unknown) => ({ type, uniforms })),
    },
    // 材质属性：Cesium 只认真正的 Property 实例（别的会抛「Unable to infer material type」）
    MaterialProperty: vi.fn((material: unknown) => ({
      material,
      getValue: () => material,
      isConstant: true,
    })),
    PolylineGlowMaterialProperty: vi.fn((options: Record<string, unknown>) => ({
      color: options?.color,
      glowPower: options?.glowPower,
    })),
    ColorMaterialProperty: vi.fn((color: unknown) => ({
      color,
      // 真 Cesium 里：color 是 ConstantProperty 时材质才是常量；
      // 传进来的若带 isConstant（CallbackProperty），就按它算。
      isConstant: (color as { isConstant?: boolean } | undefined)?.isConstant === true,
    })),
    PolylineDashMaterialProperty: vi.fn((options: Record<string, unknown>) => ({ ...options })),
    ConstantProperty: vi.fn((value: unknown) => ({ value, isConstant: true })),
    Primitive: vi.fn((options: Record<string, unknown>) => ({ ...options, show: true })),
    GeometryInstance: vi.fn((options: Record<string, unknown>) => ({ ...options })),
    PolylineGeometry: vi.fn((options: Record<string, unknown>) => ({ ...options })),
    PolylineMaterialAppearance: Object.assign(
      vi.fn((options: Record<string, unknown>) => ({ ...options })),
      { VERTEX_FORMAT: { position: true, st: true } },
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
    CallbackProperty: vi.fn((callback: (...args: unknown[]) => unknown, isConstant = false) => ({
      callback,
      isConstant,
      getValue: (...args: unknown[]) => callback(...args),
    })),
    GeoJsonDataSource: {
      load: vi.fn(async () => ({ entities: { values: [] as StubEntity[] } })),
    },
    SceneMode: { SCENE3D: 0 },
    viewers,
  }

  active = stub
  return stub
}
