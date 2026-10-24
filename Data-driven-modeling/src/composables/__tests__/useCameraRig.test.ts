import { describe, it, expect, vi, beforeEach } from 'vitest'
import { reactive, ref } from 'vue'
import type { Ref } from 'vue'

vi.mock('cesium', async () => {
  const { createCesiumStub } = await import('./cesiumStub')
  return createCesiumStub()
})

import * as Cesium from 'cesium'
import {
  CAMERA_FLIGHT_GUARD_MS,
  ORBIT_RESUME_DELAY_MS,
  OVERHEAD_DISTANCE_M,
  OVERHEAD_TILT_RAD,
  useCameraRig,
} from '../useCameraRig'
import { FLOW_DASH_LENGTH, cityConfig } from '../useSceneStage'
import type { ScenePrimitives, SmartCityState } from '../useSceneStage'
import { getCesiumStub, makeScenePrimitives } from './cesiumStub'
import type { StubViewer } from './cesiumStub'

const stub = () => getCesiumStub()

beforeEach(() => {
  vi.clearAllMocks()
})

/** 造一个相机机位（带一个假的 viewer）。 */
const makeRig = () => {
  const viewer = ref<unknown>(null)
  const state = reactive<SmartCityState>({
    buildingVisible: true,
    roadVisible: true,
    trafficVisible: true,
    viewMode: 'overhead',
    buildingEntities: [],
    roadEntities: [],
    trafficEntities: [],
  })
  const primitives: ScenePrimitives = {
    ...makeScenePrimitives(),
    flowMaterial: { uniforms: { dashLength: FLOW_DASH_LENGTH } } as never,
  }
  const rig = useCameraRig({
    viewer: viewer as Ref<never>,
    state,
    primitives,
  })
  const stubViewer = stub().Viewer() as unknown as StubViewer
  viewer.value = stubViewer
  return { rig, viewer, state, primitives, stubViewer }
}

/** 取挂在 preRender 上的自转回调。 */
const preRenderListenerOf = (stubViewer: StubViewer): (() => void) => {
  const calls = stubViewer.scene.preRender.addEventListener.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[0][0]
}

/** 取交互监听器注册的回调。 */
const interactionActionsOf = (): Array<() => void> => {
  const handler = (
    Cesium as unknown as {
      ScreenSpaceEventHandler: {
        mock: { results: Array<{ value: { setInputAction: { mock: { calls: unknown[][] } } } }> }
      }
    }
  ).ScreenSpaceEventHandler
  const created = handler.mock.results[handler.mock.results.length - 1]
  return created.value.setInputAction.mock.calls.map(call => call[0] as () => void)
}

describe('useCameraRig', () => {
  it('attach 装上交互监听并把自转挂到 preRender 上', () => {
    const { rig, stubViewer } = makeRig()
    rig.attach(stubViewer as unknown as never)
    expect(stubViewer.scene.preRender.addEventListener).toHaveBeenCalledTimes(1)
    // 六种输入都会记一笔「用户操作了」
    expect(interactionActionsOf().length).toBe(6)
  })

  it('鸟瞰模式下每帧把视角落回轨道', () => {
    const { rig, stubViewer } = makeRig()
    rig.attach(stubViewer as unknown as never)
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 10_000)
    stubViewer.camera.setView.mockClear()
    preRenderListenerOf(stubViewer)()
    expect(stubViewer.camera.setView).toHaveBeenCalled()
    const view = stubViewer.camera.setView.mock.calls[0][0] as {
      destination: { z: number }
      orientation: { pitch: number; roll: number }
    }
    expect(view.orientation.pitch).toBeLessThan(0)
    expect(view.orientation.pitch).toBeCloseTo(-OVERHEAD_TILT_RAD)
    expect(view.orientation.roll).toBe(0)
    expect(view.destination.z).toBeGreaterThan(0)
    nowSpy.mockRestore()
  })

  it('平视模式不自转', () => {
    const { rig, state, stubViewer } = makeRig()
    rig.attach(stubViewer as unknown as never)
    state.viewMode = 'street'
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 10_000)
    stubViewer.camera.setView.mockClear()
    preRenderListenerOf(stubViewer)()
    expect(stubViewer.camera.setView).not.toHaveBeenCalled()
    nowSpy.mockRestore()
  })

  it('用户一操作就停自转，超过 4 秒才恢复', () => {
    const { rig, stubViewer } = makeRig()
    rig.attach(stubViewer as unknown as never)
    const base = performance.now()
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(base + 10_000)
    const listener = preRenderListenerOf(stubViewer)
    stubViewer.camera.setView.mockClear()

    interactionActionsOf().forEach(action => action())
    listener()
    expect(stubViewer.camera.setView).not.toHaveBeenCalled()

    nowSpy.mockReturnValue(base + 10_000 + ORBIT_RESUME_DELAY_MS - 1)
    listener()
    expect(stubViewer.camera.setView).not.toHaveBeenCalled()

    nowSpy.mockReturnValue(base + 10_000 + ORBIT_RESUME_DELAY_MS + 1)
    listener()
    expect(stubViewer.camera.setView).toHaveBeenCalled()
    nowSpy.mockRestore()
  })

  it('恢复自转时从相机当前位置反算轨道', () => {
    const { rig, stubViewer } = makeRig()
    rig.attach(stubViewer as unknown as never)
    // 把相机放到城心以东 0.01°
    stubViewer.camera.positionCartographic = {
      longitude: ((cityConfig.center.lng + 0.01) * Math.PI) / 180,
      latitude: (cityConfig.center.lat * Math.PI) / 180,
      height: 1500,
    }
    const base = performance.now()
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(base + 10_000)
    const listener = preRenderListenerOf(stubViewer)
    interactionActionsOf().forEach(action => action())
    stubViewer.camera.setView.mockClear()
    nowSpy.mockReturnValue(base + 15_000)
    listener()
    expect(stubViewer.camera.setView).toHaveBeenCalled()
    const view = stubViewer.camera.setView.mock.calls[0][0] as { destination: { x: number } }
    expect(view.destination.x).toBeGreaterThan(cityConfig.center.lng)
    nowSpy.mockRestore()
  })

  it('自转时顺带推进流动光效的相位', () => {
    const { rig, primitives, stubViewer } = makeRig()
    rig.attach(stubViewer as unknown as never)
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 10_000)
    preRenderListenerOf(stubViewer)()
    const material = primitives.flowMaterial as unknown as { uniforms: { dashLength: number } }
    expect(material.uniforms.dashLength).not.toBe(FLOW_DASH_LENGTH)
    nowSpy.mockRestore()
  })

  it('没有流动光效材质时自转照常推进', () => {
    const { rig, primitives, stubViewer } = makeRig()
    primitives.flowMaterial = null
    rig.attach(stubViewer as unknown as never)
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 10_000)
    expect(() => preRenderListenerOf(stubViewer)()).not.toThrow()
    nowSpy.mockRestore()
  })

  it('flyToStreetLevel 飞到 1.7 m 的人眼高度，水平朝北', () => {
    const { rig, stubViewer } = makeRig()
    rig.flyToStreetLevel()
    expect(stubViewer.camera.flyTo).toHaveBeenCalledTimes(1)
    const call = stubViewer.camera.flyTo.mock.calls[0][0] as {
      destination: { x: number; y: number; z: number }
      orientation: { heading: number; pitch: number }
      duration: number
    }
    expect(call.destination.z).toBe(cityConfig.streetLevel.height)
    expect(call.orientation.pitch).toBe(0)
    expect(call.orientation.heading).toBe(cityConfig.streetLevel.heading)
    expect(call.duration).toBe(2)
    // 落点是 `streetPosition`（城心在街区内部，平视停在那里会钻进建筑）
    expect(call.destination.x).toBe(cityConfig.streetPosition?.lng)
    expect(call.destination.y).toBe(cityConfig.streetPosition?.lat)
    expect(call.destination.x).not.toBe(cityConfig.center.lng)
  })

  it('flyToOverhead 飞到城心上空 1500 m，俯角 45°', () => {
    const { rig, stubViewer } = makeRig()
    rig.flyToOverhead()
    const call = stubViewer.camera.flyTo.mock.calls[0][0] as {
      destination: { z: number }
      orientation: { pitch: number }
    }
    expect(call.destination.z).toBe(cityConfig.zoomLevel)
    expect(call.orientation.pitch).toBeCloseTo(-OVERHEAD_TILT_RAD)
    // 切换视角后要能接着用户停下的地方转
    expect(rig.cameraOrbit.needsResync).toBe(true)
  })

  it('开场定位不重算轨道（resync: false）', () => {
    const { rig, stubViewer } = makeRig()
    rig.flyToOverhead({ duration: 2, resync: false })
    expect(rig.cameraOrbit.needsResync).toBe(false)
    const call = stubViewer.camera.flyTo.mock.calls[0][0] as { duration: number }
    expect(call.duration).toBe(2)
  })

  it('toggleView 在鸟瞰与平视之间切换', () => {
    const { rig, state, stubViewer } = makeRig()
    rig.toggleView()
    expect(state.viewMode).toBe('street')
    expect(stubViewer.camera.flyTo).toHaveBeenCalledTimes(1)
    rig.toggleView()
    expect(state.viewMode).toBe('overhead')
    expect(stubViewer.camera.flyTo).toHaveBeenCalledTimes(2)
  })

  it('飞行期间不推进自转', () => {
    const { rig, stubViewer } = makeRig()
    rig.attach(stubViewer as unknown as never)
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(performance.now())
    rig.flyToOverhead()
    // 飞行保护期还没过
    nowSpy.mockReturnValue(performance.now() + 1)
    stubViewer.camera.setView.mockClear()
    preRenderListenerOf(stubViewer)()
    expect(stubViewer.camera.setView).not.toHaveBeenCalled()
    nowSpy.mockRestore()
  })

  it('没有 viewer 时飞行与切换都不炸', () => {
    const { rig, viewer, state } = makeRig()
    viewer.value = null
    expect(() => rig.flyToStreetLevel()).not.toThrow()
    expect(() => rig.flyToOverhead()).not.toThrow()
    expect(() => rig.flyTo({
      destination: {} as never,
      orientation: { heading: 0, pitch: 0, roll: 0 },
      duration: 1,
      guardMs: CAMERA_FLIGHT_GUARD_MS,
      resync: true,
    })).not.toThrow()
    expect(() => rig.toggleView()).not.toThrow()
    expect(state.viewMode).toBe('street')
  })

  it('detach 销毁交互监听并摘下自转回调', () => {
    const { rig, stubViewer } = makeRig()
    rig.attach(stubViewer as unknown as never)
    rig.detach(stubViewer as unknown as never)
    expect(stubViewer.scene.preRender.removeEventListener).toHaveBeenCalledTimes(1)
    const handler = (
      Cesium as unknown as {
        ScreenSpaceEventHandler: { mock: { results: Array<{ value: { destroy: { mock: { calls: unknown[][] } } } }> } }
      }
    ).ScreenSpaceEventHandler
    const created = handler.mock.results[handler.mock.results.length - 1]
    expect(created.value.destroy.mock.calls.length).toBeGreaterThan(0)
    // 再 detach 一次也不炸
    expect(() => rig.detach(null)).not.toThrow()
  })

  it('自转的默认轨道就是鸟瞰构图', () => {
    const { rig } = makeRig()
    expect(rig.cameraOrbit.distance).toBe(OVERHEAD_DISTANCE_M)
    expect(rig.cameraOrbit.altitude).toBe(cityConfig.zoomLevel)
    expect(rig.cameraOrbit.azimuth).toBe(0)
  })
})
