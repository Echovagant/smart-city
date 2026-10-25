import { describe, it, expect, vi, beforeEach } from 'vitest'
import { reactive, ref } from 'vue'
import type { Ref } from 'vue'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

vi.mock('cesium', async () => {
  const { createCesiumStub } = await import('./cesiumStub')
  return createCesiumStub()
})

import { useTrafficFleet } from '../useTrafficFleet'
import type { SmartCityState } from '../useSceneStage'
import { getCesiumStub } from './cesiumStub'
import type { StubViewer } from './cesiumStub'

const stub = () => getCesiumStub()

beforeEach(() => {
  vi.clearAllMocks()
})

/** 造一个车队（带一个假的 viewer）。 */
const makeFleet = () => {
  const viewer = ref<unknown>(null)
  const state = reactive<SmartCityState>({
    buildingVisible: true,
    roadVisible: true,
    trafficVisible: true,
    viewMode: 'overhead',
    buildingEntities: [],
    roadEntities: [],
    trafficEntities: [],
    firstPerson: false,
  })
  const fleet = useTrafficFleet({ viewer: viewer as Ref<never>, state })
  const stubViewer = stub().Viewer() as unknown as StubViewer
  viewer.value = stubViewer
  return { fleet, viewer, state, stubViewer }
}

describe('useTrafficFleet', () => {
  it('createTrafficSystem 建出交通灯、车辆与路灯', () => {
    const { fleet, state, stubViewer } = makeFleet()
    fleet.createTrafficSystem()
    const descriptors = stubViewer.entities.add.mock.calls.map(([options]) => options as {
      name?: string
      box?: unknown
      cylinder?: unknown
      point?: unknown
      model?: unknown
    })
    expect(descriptors.filter(d => d.name === 'Traffic Light')).toHaveLength(2)
    expect(descriptors.filter(d => d.name?.startsWith('Vehicle'))).toHaveLength(4)
    expect(descriptors.filter(d => d.name?.startsWith('Street Light'))).toHaveLength(4)
    // 车辆是长方体，灯是圆柱 + 发光点
    expect(descriptors.filter(d => d.name?.startsWith('Vehicle')).every(d => d.box && !d.cylinder)).toBe(true)
    expect(descriptors.filter(d => d.name === 'Traffic Light').every(d => d.cylinder && d.point)).toBe(true)
    // 全部进状态列表
    expect(state.trafficEntities).toHaveLength(10)
  })

  it('不引用任何 .glb 模型（资源守卫）', () => {
    // 与 src/__tests__/SmartCity-features.test.ts 同一道守卫：
    // 拆分之前它守的是 SmartCity.vue，交通代码搬走之后由这里接着守。
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../useTrafficFleet.ts'),
      'utf-8',
    )
    expect(source).not.toMatch(/uri:\s*['"]\/models\/[^'"]+\.glb['"]/)
  })

  it('没有 viewer 时 createTrafficSystem 不抛', () => {
    const { fleet, viewer } = makeFleet()
    viewer.value = null
    expect(() => fleet.createTrafficSystem()).not.toThrow()
  })

  it('toggleTraffic 隐藏 / 恢复实体', () => {
    const { fleet, state, stubViewer } = makeFleet()
    fleet.createTrafficSystem()
    const first = stubViewer.entities.add.mock.results[0].value
    fleet.toggleTraffic()
    expect(state.trafficVisible).toBe(false)
    expect(first.show).toBe(false)
    fleet.toggleTraffic()
    expect(state.trafficVisible).toBe(true)
    expect(first.show).toBe(true)
  })

  it('隐藏交通时动画链断开，重新显示时拉起来', () => {
    const frameQueue: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      frameQueue.push(callback)
      return frameQueue.length
    })
    const { fleet, stubViewer } = makeFleet()
    fleet.createTrafficSystem()

    const addMock = stubViewer.entities.add
    const vehicleIndex = addMock.mock.calls.findIndex(
      ([options]) => (options as { name?: string }).name?.startsWith('Vehicle'),
    )
    expect(vehicleIndex).toBeGreaterThan(-1)
    const vehicle = addMock.mock.results[vehicleIndex].value as { position: unknown }

    const stepFrame = () => {
      const callback = frameQueue.shift()
      if (callback) callback(0)
    }

    const before = vehicle.position
    stepFrame()
    expect(vehicle.position).not.toBe(before)

    // 隐藏：动画链断开，不再排新帧
    fleet.toggleTraffic()
    let guard = 0
    while (frameQueue.length > 0 && guard < 100) {
      stepFrame()
      guard += 1
    }
    expect(frameQueue.length).toBe(0)

    // 重新显示：链被重新拉起
    fleet.toggleTraffic()
    expect(frameQueue.length).toBeGreaterThan(0)
    const beforeRestart = vehicle.position
    stepFrame()
    expect(vehicle.position).not.toBe(beforeRestart)
  })

  it('cancelAllAnimations 取消所有在途帧', () => {
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame')
    const { fleet } = makeFleet()
    fleet.createTrafficSystem()
    fleet.cancelAllAnimations()
    expect(cancelSpy).toHaveBeenCalled()
    cancelSpy.mockRestore()
  })

  it('车辆按四个方向排布', () => {
    const { fleet, stubViewer } = makeFleet()
    fleet.createTrafficSystem()
    const vehicles = stubViewer.entities.add.mock.calls
      .map(([options]) => options as { name?: string; position?: { x: number; y: number } })
      .filter(d => d.name?.startsWith('Vehicle'))
    expect(vehicles).toHaveLength(4)
    const xs = new Set(vehicles.map(v => v.position?.x))
    const ys = new Set(vehicles.map(v => v.position?.y))
    // 城心左右各一辆 + 城心南北各一辆
    expect(xs.size).toBe(3)
    expect(ys.size).toBe(3)
  })

  it('Cesium 图元只用 box / cylinder / point', () => {
    const { fleet, stubViewer } = makeFleet()
    fleet.createTrafficSystem()
    const descriptors = stubViewer.entities.add.mock.calls.map(([options]) => options as {
      model?: unknown
    })
    expect(descriptors.every(d => d.model === undefined)).toBe(true)
  })
})
