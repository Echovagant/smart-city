import { computed, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import * as Cesium from 'cesium'
import { EVENT_COLORS, createPrimitiveGlowMaterial, createPulseGlowMaterial, cssColor } from '@/theme/dark'
import type { EventTone } from '@/theme/dark'
import { dedupeEvents, resolveEventLocation } from './useEventStream'
import { CAMERA_FLIGHT_GUARD_MS } from './useCameraRig'
import type { CameraRig } from './useCameraRig'
import { METERS_PER_DEGREE_LAT, cityConfig } from './useSceneStage'
import { useTheme } from './useTheme'
import type { CityEvent, CityOverview, EventLocation } from '../../types/city'

/**
 * 事件标记：告警光柱 / 体量圆柱 / 脉冲环的创建与清理，点事件飞过去。
 *
 * 事件全部是后端从**真实指标派生**出来的（`/api/city/overview` 的 `events`）。
 * 派生不出来就是空数组 —— 那时场景里什么也不画，**不许编造标记**。
 */

/** 场景里最多渲染几个事件标记（列表里全给，场景里只给前几个）。 */
export const MAX_EVENT_MARKERS = 8

/** 同时最多几个脉冲环（多了帧率会掉）。 */
export const MAX_PULSE_RINGS = 3

/** 光柱的高度（米）。 */
export const EVENT_COLUMN_HEIGHT_M = 300

/** 光柱的线宽（像素）。 */
export const EVENT_COLUMN_WIDTH_PX = 10

/** 光柱的辉光强度。 */
export const EVENT_COLUMN_GLOW_POWER = 0.3

/** 光柱底部的半透明圆柱半径（米）—— 只为增加体量感。 */
export const EVENT_VOLUME_RADIUS_M = 40

/** 光柱底部的半透明圆柱透明度。 */
export const EVENT_VOLUME_ALPHA = 0.18

/** 脉冲环的最大半径（米）。 */
export const PULSE_RING_RADIUS_M = 260

/** 脉冲环的最小半径（米）：环不会缩到 0（半径为 0 时几何退化，Cesium 会跳过这一帧）。 */
export const PULSE_RING_MIN_RADIUS_M = 20

/** 脉冲环一个完整周期的时长（毫秒）。 */
export const PULSE_PERIOD_MS = 2400

/** 脉冲环的线宽（像素）。 */
export const PULSE_RING_WIDTH_PX = 3

/** 脉冲环的起始透明度（随周期淡出）。 */
export const PULSE_RING_ALPHA = 0.9

/** 脉冲环的圆周分段数。 */
export const PULSE_RING_SEGMENTS = 48

/** 点击事件后相机飞到的高度（米，与鸟瞰视高同量级）。 */
export const EVENT_FOCUS_HEIGHT_M = 800

/** 点击事件后飞行时长（秒）。 */
export const EVENT_FOCUS_DURATION_S = 1.2

/** 点击事件后的俯角（弧度，负数 = 从上往下看 45°）。 */
export const EVENT_FOCUS_PITCH_RAD = -Math.PI / 4

/**
 * 事件标记的句柄。
 *
 * 组件卸载时必须**全部**清掉（重新挂载不许叠加）。
 */
export interface EventMarker {
  /** 光柱（自己建的 Primitive）。 */
  column: Cesium.Primitive | null
  /** 半透明体量圆柱（实体）。 */
  volume: Cesium.Entity | null
  /** 脉冲环（实体，**贴地**）。 */
  ring: Cesium.Entity | null
}

/** 事件标记对外暴露的东西。 */
export interface EventMarkers {
  /** 派生事件（按 id 去重，新的在前）。 */
  events: ComputedRef<CityEvent[]>
  /** 落点已解析的事件（全市级事件落在城心）。 */
  resolvedEvents: ComputedRef<CityEvent[]>
  /** 按当前事件集合重建场景里的标记（幂等）。 */
  syncEventMarkers(): void
  /** 清掉全部事件标记。 */
  clearEventMarkers(): void
  /** 点击事件 → 相机飞到事件位置。 */
  flyToEvent(event: CityEvent): void
}

/** 事件标记的输入。 */
export interface EventMarkersOptions {
  /** Cesium 视图（场景底座给的那一份）。 */
  viewer: Ref<Cesium.Viewer | null>
  /** 相机机位（点事件时让它飞过去）。 */
  camera: CameraRig
  /** 城市运行指标（事件的来源）。 */
  cityOverview: Ref<CityOverview | null>
}

/** 圆环上的点（贴地，高度 0）。 */
export const ringPositions = (lng: number, lat: number, radius: number): Cesium.Cartesian3[] => {
  const points: Cesium.Cartesian3[] = []
  if (radius <= 0) return points
  const latRad = (lat * Math.PI) / 180
  const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos(latRad)
  for (let index = 0; index <= PULSE_RING_SEGMENTS; index++) {
    const angle = (index / PULSE_RING_SEGMENTS) * Math.PI * 2
    points.push(
      Cesium.Cartesian3.fromDegrees(
        lng + (Math.cos(angle) * radius) / metersPerDegreeLng,
        lat + (Math.sin(angle) * radius) / METERS_PER_DEGREE_LAT,
        0
      )
    )
  }
  return points
}

export function useEventMarkers({ viewer, camera, cityOverview }: EventMarkersOptions): EventMarkers {
  /** 当前挂在场景里的事件标记。 */
  let eventMarkers: EventMarker[] = []

  /** 事件标记的签名（用来判断要不要重建）。 */
  let eventMarkerSignature = ''

  // 主题状态是模块级单例：标记的颜色取自当前主题
  // （橙 / 红是语义色，三套主题一致；「提示级」的强调色随主题变）。
  const { theme } = useTheme()

  /**
   * 派生事件（按 id 去重，新的在前）。
   *
   * 事件的 id 是**稳定**的（后端保证），所以 60 秒一次的轮询
   * 不会在场景里越积越多标记。
   */
  const events = computed<CityEvent[]>(() => dedupeEvents(cityOverview.value?.events))

  /**
   * **落点已解析**的事件列表（场景标记、事件流面板都用这一份）。
   *
   * - 全市级事件（`location_kind === 'city'`）→ 落在**城心**（`cityConfig.center`），
   *   也就是相机绕行的那一点 → 默认鸟瞰视角下标记永远在屏幕中心；
   * - 几何锚定事件（`location_kind === 'geometry'`）→ 用**真实几何**坐标，不替换。
   */
  const resolvedEvents = computed<CityEvent[]>(() =>
    events.value.map(event => ({
      ...event,
      location: resolveEventLocation(event, cityConfig.center),
    })),
  )

  /**
   * 事件光柱（自己建的 Primitive，`asynchronous: false`）。
   *
   * **必须自己建 Primitive**：实体的非贴地 polyline 走 Cesium 的异步路径 →
   * 需要 `Workers/createPolylineGeometry.js` —— 那个 worker 被剪枝清单剪掉了 →
   * 404 → 页面报 "Rendering has stopped."，整个城市画不出来。
   */
  const createEventColumn = (
    activeViewer: Cesium.Viewer,
    location: EventLocation,
    tone: EventTone,
  ): Cesium.Primitive => {
    const geometry = new Cesium.PolylineGeometry({
      positions: [
        Cesium.Cartesian3.fromDegrees(location.lng, location.lat, 0),
        Cesium.Cartesian3.fromDegrees(location.lng, location.lat, EVENT_COLUMN_HEIGHT_M),
      ],
      width: EVENT_COLUMN_WIDTH_PX,
      vertexFormat: Cesium.PolylineMaterialAppearance.VERTEX_FORMAT,
      arcType: Cesium.ArcType.RHUMB,
    })
    const primitive = new Cesium.Primitive({
      geometryInstances: [new Cesium.GeometryInstance({ geometry })],
      appearance: new Cesium.PolylineMaterialAppearance({
        material: createPrimitiveGlowMaterial(EVENT_COLORS[tone], EVENT_COLUMN_GLOW_POWER, 0.85),
      }),
      asynchronous: false,
    })
    activeViewer.scene.primitives.add(primitive)
    return primitive
  }

  /** 光柱底部的半透明圆柱（实体）—— 只为增加体量感。 */
  const createEventVolume = (
    activeViewer: Cesium.Viewer,
    location: EventLocation,
    tone: EventTone,
  ): Cesium.Entity =>
    activeViewer.entities.add({
      name: 'EventVolume',
      position: Cesium.Cartesian3.fromDegrees(
        location.lng,
        location.lat,
        EVENT_COLUMN_HEIGHT_M / 2
      ),
      cylinder: {
        length: EVENT_COLUMN_HEIGHT_M,
        topRadius: 0,
        bottomRadius: EVENT_VOLUME_RADIUS_M,
        material: cssColor(EVENT_COLORS[tone], EVENT_VOLUME_ALPHA),
      },
    })

  /**
   * 告警脉冲环（**贴地**的 dynamic polyline 实体）。
   *
   * `clampToGround: true` 是**硬要求**：贴地的 dynamic polyline 走
   * `GroundPolylinePrimitive`（主线程建几何），不会去请求被剪掉的 worker；
   * 非贴地的 dynamic polyline 会走异步 `Primitive` 路径 → 404 →
   * "Rendering has stopped."（这是 S0 踩过的真 bug，不许重犯）。
   */
  const createPulseRing = (
    activeViewer: Cesium.Viewer,
    event: CityEvent,
    location: EventLocation,
    tone: EventTone,
  ): Cesium.Entity => {
    const startedAt = performance.now()
    const phaseOf = () =>
      ((performance.now() - startedAt) % PULSE_PERIOD_MS) / PULSE_PERIOD_MS
    const positions = new Cesium.CallbackProperty(
      () =>
        ringPositions(
          location.lng,
          location.lat,
          PULSE_RING_MIN_RADIUS_M +
            (PULSE_RING_RADIUS_M - PULSE_RING_MIN_RADIUS_M) * phaseOf()
        ),
      false
    )
    return activeViewer.entities.add({
      name: `EventPulse ${event.id}`,
      polyline: {
        positions,
        width: PULSE_RING_WIDTH_PX,
        // 辉光强度是常量（createPulseGlowMaterial 已经包好），
        // 只有透明度随周期淡出（前半程基本不透明，后半程快速淡出）。
        material: createPulseGlowMaterial(EVENT_COLORS[tone], () => {
          const phase = phaseOf()
          // 透明度按 (1 - phase)^0.6 衰减：前半程基本不透明（环看得见），
          // 后半程快速淡出 —— 直线淡出会让环「刚变大就看不见了」。
          return PULSE_RING_ALPHA * Math.pow(1 - phase, 0.6)
        }),
        clampToGround: true,
      },
    })
  }

  /** 清掉全部事件标记（组件卸载、切页签、事件集合变化时都要调）。 */
  const clearEventMarkers = () => {
    const activeViewer = viewer.value
    if (activeViewer) {
      eventMarkers.forEach(marker => {
        if (marker.column) activeViewer.scene.primitives.remove(marker.column)
        if (marker.volume) activeViewer.entities.remove(marker.volume)
        if (marker.ring) activeViewer.entities.remove(marker.ring)
      })
    }
    eventMarkers = []
  }

  /**
   * 按当前事件集合重建场景里的标记。
   *
   * 幂等：事件集合没变就不重建（不重复挂实体）。
   */
  const syncEventMarkers = () => {
    const activeViewer = viewer.value
    if (!activeViewer) return
    // 用**已解析落点**的事件：全市级事件落在城心，几何事件用真实坐标。
    const list = resolvedEvents.value.slice(0, MAX_EVENT_MARKERS)
    // 签名里带上主题 id：换主题后标记要按新配色重建
    // （标记是「一次性」的 Primitive / 实体，不是可原地改色的 uniform）。
    const signature = `${theme.value.id}@${list
      .map(event => `${event.id}@${event.location?.lng ?? ''},${event.location?.lat ?? ''}`)
      .join('|')}`
    if (signature === eventMarkerSignature) return
    eventMarkerSignature = signature

    clearEventMarkers()
    list.forEach((event, index) => {
      const location = event.location
      if (!location) return
      const tone = (event.level ?? 'info') as EventTone
      eventMarkers.push({
        column: createEventColumn(activeViewer, location, tone),
        volume: createEventVolume(activeViewer, location, tone),
        ring:
          index < MAX_PULSE_RINGS
            ? createPulseRing(activeViewer, event, location, tone)
            : null,
      })
    })
  }

  /**
   * 点击事件 → 相机飞到事件位置。
   *
   * - 飞行期间**不推进自转**（飞行与自转会互相打架）；
   * - 飞行结束后自转从**相机当前位置**反算轨道状态，不硬拽回去；
   * - 这是用户主动触发的，**不算「相机交互」** —— 不把自转永久停掉。
   *
   * 落点用**已解析**的位置：全市级事件飞到**城心**（= 绕行中心），
   * 飞行后标记正好落在屏幕中心；几何锚定事件飞到真实几何上的点。
   */
  const flyToEvent = (event: CityEvent) => {
    const activeViewer = viewer.value
    const location = resolveEventLocation(event, cityConfig.center)
    if (!activeViewer || !location) return
    // 目标高度 800 m、俯角 45° → 相机落在事件点正南 800 m 处，朝北俯视。
    const southOffsetDeg = EVENT_FOCUS_HEIGHT_M / METERS_PER_DEGREE_LAT
    const destination = Cesium.Cartesian3.fromDegrees(
      location.lng,
      location.lat - southOffsetDeg,
      EVENT_FOCUS_HEIGHT_M
    )
    camera.flyTo({
      destination,
      orientation: { heading: 0, pitch: EVENT_FOCUS_PITCH_RAD, roll: 0 },
      duration: EVENT_FOCUS_DURATION_S,
      guardMs: EVENT_FOCUS_DURATION_S * 1000 + CAMERA_FLIGHT_GUARD_MS,
      resync: true,
    })
  }

  /**
   * 换主题 → 重建标记（颜色变了）。
   *
   * 事件标记是「一次性」的 Primitive / 实体（不是可原地改色的 uniform），
   * 所以换主题只能重建 —— 数量很少（最多 8 个），代价可忽略。
   */
  watch(
    theme,
    () => {
      syncEventMarkers()
    },
    { flush: 'post' }
  )

  return {
    events,
    resolvedEvents,
    syncEventMarkers,
    clearEventMarkers,
    flyToEvent,
  }
}
