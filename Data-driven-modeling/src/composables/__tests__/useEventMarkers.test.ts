import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, shallowRef } from 'vue'
import type { Ref } from 'vue'

vi.mock('cesium', async () => {
  const { createCesiumStub } = await import('./cesiumStub')
  return createCesiumStub()
})

import {
  EVENT_FOCUS_DURATION_S,
  EVENT_FOCUS_HEIGHT_M,
  EVENT_FOCUS_PITCH_RAD,
  MAX_EVENT_MARKERS,
  MAX_PULSE_RINGS,
  useEventMarkers,
  ringPositions,
} from '../useEventMarkers'
import { CAMERA_FLIGHT_GUARD_MS } from '../useCameraRig'
import { cityConfig } from '../useSceneStage'
import { getCesiumStub } from './cesiumStub'
import type { StubViewer } from './cesiumStub'
import type { CityEvent, CityOverview } from '../../../types/city'

const stub = () => getCesiumStub()

beforeEach(() => {
  vi.clearAllMocks()
})

const SOURCE = {
  name: '中国环境监测总站',
  url: 'https://air.cnemc.cn:18007/x',
  observed_at: '2026-10-22T04:00:00Z',
  fetched_at: '2026-10-22T04:30:00Z',
  realtime: true,
  estimated: false,
}

/** 全市级事件：落点由前端解析到城心。 */
const CITY_EVENT: CityEvent = {
  id: 'air_quality:level_change:2026-10-22T03:00:00Z',
  type: 'air_quality',
  level: 'info',
  title: '空气质量由优转为良',
  time: '2026-10-22T03:00:00Z',
  location_kind: 'city',
  location: { lng: 2.1694155, lat: 41.4048679, label: '数据范围中心' },
  metric_key: 'aqi_24h',
  source: SOURCE,
  estimated: false,
}

/** 几何锚定事件：落点用真实几何坐标。 */
const GEOMETRY_EVENT: CityEvent = {
  id: 'road_load:over_threshold:92.4',
  type: 'road_load',
  level: 'alert',
  title: '路网负载指数 92.4 超过参考阈值 80',
  time: '2026-10-22T09:00:00Z',
  location_kind: 'geometry',
  location: { lng: 2.1774, lat: 41.4095, label: '主路段（OSM way/41662973）' },
  metric_key: 'road_load_index',
  source: SOURCE,
  estimated: true,
}

const overviewOf = (events: CityEvent[]): CityOverview => ({
  city: { id: 'barcelona', name: '巴塞罗那', latitude: 41.395, longitude: 2.165, timezone: 'Europe/Madrid' },
  generated_at: '2026-10-22T04:00:00Z',
  metrics: [],
  series: [],
  facilities: [],
  events,
  degraded: [],
})

/** 造一套事件标记（带一个假的 viewer 与相机）。 */
const makeMarkers = (events: CityEvent[] = []) => {
  const viewer = ref<unknown>(null)
  const cityOverview = shallowRef<CityOverview | null>(overviewOf(events))
  const flyTo = vi.fn()
  const camera = {
    cameraOrbit: { azimuth: 0, distance: 0, altitude: 0, needsResync: false },
    attach: vi.fn(),
    detach: vi.fn(),
    flyTo,
    flyToStreetLevel: vi.fn(),
    flyToOverhead: vi.fn(),
    toggleView: vi.fn(),
  }
  const markers = useEventMarkers({
    viewer: viewer as Ref<never>,
    camera,
    cityOverview,
  })
  const stubViewer = stub().Viewer() as unknown as StubViewer
  viewer.value = stubViewer
  return { markers, viewer, cityOverview, camera, flyTo, stubViewer }
}

describe('useEventMarkers', () => {
  it('events 按 id 去重，新的在前', () => {
    const { markers } = makeMarkers([
      { ...CITY_EVENT, id: 'a', time: '2026-10-22T03:00:00Z' },
      { ...CITY_EVENT, id: 'b', time: '2026-10-22T09:00:00Z' },
      { ...CITY_EVENT, id: 'a', time: '2026-10-22T03:00:00Z' },
    ])
    expect(markers.events.value.map(e => e.id)).toEqual(['b', 'a'])
  })

  it('resolvedEvents：全市级落城心，几何锚定用真实坐标', () => {
    const { markers } = makeMarkers([CITY_EVENT, GEOMETRY_EVENT])
    const byId = new Map(markers.resolvedEvents.value.map(event => [event.id, event]))
    const city = byId.get(CITY_EVENT.id)!
    const geometry = byId.get(GEOMETRY_EVENT.id)!
    expect(city.location?.lng).toBe(cityConfig.center.lng)
    expect(city.location?.lat).toBe(cityConfig.center.lat)
    expect(geometry.location?.lng).toBe(2.1774)
    expect(geometry.location?.lat).toBe(41.4095)
  })

  it('没有指标时事件流是空数组（不编条目）', () => {
    const { markers } = makeMarkers([])
    expect(markers.events.value).toEqual([])
    expect(markers.resolvedEvents.value).toEqual([])
  })

  it('syncEventMarkers 建出光柱、体量圆柱与脉冲环', () => {
    const { markers, stubViewer } = makeMarkers([CITY_EVENT])
    markers.syncEventMarkers()
    // 光柱是自己建的 Primitive
    expect(stubViewer.scene.primitives.add).toHaveBeenCalledTimes(1)
    // 圆柱 + 脉冲环是两个实体
    expect(stubViewer.entities.add).toHaveBeenCalledTimes(2)
    const names = stubViewer.entities.add.mock.calls.map(
      ([options]) => (options as { name?: string }).name,
    )
    expect(names).toContain('EventVolume')
    expect(names).toContain(`EventPulse ${CITY_EVENT.id}`)
  })

  it('标记数有上限：最多 8 个光柱、3 个脉冲环', () => {
    const many = Array.from({ length: MAX_EVENT_MARKERS + 3 }, (_, index) => ({
      ...CITY_EVENT,
      id: `event-${index}`,
    }))
    const { markers, stubViewer } = makeMarkers(many)
    markers.syncEventMarkers()
    expect(stubViewer.scene.primitives.add).toHaveBeenCalledTimes(MAX_EVENT_MARKERS)
    // 每个事件一个圆柱 + 最多 3 个脉冲环
    const names = stubViewer.entities.add.mock.calls.map(
      ([options]) => (options as { name?: string }).name ?? '',
    )
    expect(names.filter(name => name === 'EventVolume')).toHaveLength(MAX_EVENT_MARKERS)
    expect(names.filter(name => name.startsWith('EventPulse'))).toHaveLength(MAX_PULSE_RINGS)
  })

  it('事件集合没变就不重建（幂等）', () => {
    const { markers, stubViewer } = makeMarkers([CITY_EVENT])
    markers.syncEventMarkers()
    stubViewer.scene.primitives.add.mockClear()
    markers.syncEventMarkers()
    expect(stubViewer.scene.primitives.add).not.toHaveBeenCalled()
  })

  it('事件集合变了就重建', () => {
    const { markers, cityOverview, stubViewer } = makeMarkers([CITY_EVENT])
    markers.syncEventMarkers()
    stubViewer.scene.primitives.add.mockClear()
    cityOverview.value = overviewOf([CITY_EVENT, GEOMETRY_EVENT])
    markers.syncEventMarkers()
    expect(stubViewer.scene.primitives.add).toHaveBeenCalledTimes(2)
  })

  it('clearEventMarkers 把光柱、圆柱与脉冲环全部清掉', () => {
    const { markers, stubViewer } = makeMarkers([CITY_EVENT])
    markers.syncEventMarkers()
    markers.clearEventMarkers()
    expect(stubViewer.scene.primitives.remove).toHaveBeenCalledTimes(1)
    expect(stubViewer.entities.remove).toHaveBeenCalledTimes(2)
  })

  it('没有 viewer 时同步与清理都不炸', () => {
    const { markers, viewer } = makeMarkers([CITY_EVENT])
    viewer.value = null
    expect(() => markers.syncEventMarkers()).not.toThrow()
    expect(() => markers.clearEventMarkers()).not.toThrow()
  })

  it('flyToEvent：全市级事件飞到城心，俯角 45°，1.2 秒', () => {
    const { markers, flyTo } = makeMarkers([CITY_EVENT])
    markers.flyToEvent(CITY_EVENT)
    expect(flyTo).toHaveBeenCalledTimes(1)
    const flight = flyTo.mock.calls[0][0] as {
      destination: { x: number; y: number; z: number }
      orientation: { heading: number; pitch: number }
      duration: number
      guardMs: number
      resync: boolean
    }
    expect(flight.destination.x).toBe(cityConfig.center.lng)
    expect(flight.destination.z).toBe(EVENT_FOCUS_HEIGHT_M)
    expect(flight.orientation.pitch).toBeCloseTo(EVENT_FOCUS_PITCH_RAD)
    expect(flight.orientation.heading).toBe(0)
    expect(flight.duration).toBe(EVENT_FOCUS_DURATION_S)
    expect(flight.guardMs).toBe(EVENT_FOCUS_DURATION_S * 1000 + CAMERA_FLIGHT_GUARD_MS)
    expect(flight.resync).toBe(true)
  })

  it('flyToEvent：几何锚定事件飞到真实几何', () => {
    const { markers, flyTo } = makeMarkers([GEOMETRY_EVENT])
    markers.flyToEvent(GEOMETRY_EVENT)
    const flight = flyTo.mock.calls[0][0] as { destination: { x: number } }
    expect(flight.destination.x).toBe(2.1774)
    expect(flight.destination.x).not.toBe(cityConfig.center.lng)
  })

  it('flyToEvent：没有落点时不飞', () => {
    const { markers, flyTo } = makeMarkers([])
    markers.flyToEvent({ ...CITY_EVENT, location: undefined, location_kind: 'geometry' })
    expect(flyTo).not.toHaveBeenCalled()
  })

  it('ringPositions：半径为 0 时给空数组，否则按分段数给点', () => {
    expect(ringPositions(2.1674, 41.3895, 0)).toEqual([])
    expect(ringPositions(2.1674, 41.3895, 100)).toHaveLength(49)
  })
})
