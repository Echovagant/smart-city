import type { Ref } from 'vue'
import * as Cesium from 'cesium'
import { flowDashLength } from '@/theme/dark'
import {
  FLOW_DASH_LENGTH,
  FLOW_PERIOD_SECONDS,
  METERS_PER_DEGREE_LAT,
  cityConfig,
} from './useSceneStage'
import type { ScenePrimitives, SmartCityState } from './useSceneStage'

/**
 * 相机：鸟瞰 / 平视、环绕自转、交互打断与恢复、相机飞行。
 *
 * **自转状态只有这一份**（`cameraOrbit`）：相机相对城心的方位角、距离、高度。
 * 其余 composable 通过 `camera.flyTo()` 请求一次飞行，不直接碰这个状态。
 */

/** 鸟瞰相机相对城心的俯角（弧度）。正数 = 从上往下看。 */
export const OVERHEAD_TILT_RAD = Math.PI / 4

/** 鸟瞰相机相对城心的水平距离（米）= 高度 / tan(俯角)。 */
export const OVERHEAD_DISTANCE_M = cityConfig.zoomLevel / Math.tan(OVERHEAD_TILT_RAD)

/** 自转速度（弧度/秒）。0.02 rad/s ≈ 1.1°/s，一圈约 5 分钟。 */
export const ORBIT_SPEED_RAD_PER_S = 0.02

/** 距上次交互超过这个时长才恢复自转（毫秒）。 */
export const ORBIT_RESUME_DELAY_MS = 4000

/** 恢复自转后，距离/高度回到目标值的时间常数（秒）。 */
export const ORBIT_RESUME_TAU_S = 0.8

/** 相机飞行期间不推进自转（飞行与自转会打架）。 */
export const CAMERA_FLIGHT_GUARD_MS = 2600

/** 自转状态：相机相对城心的位置。 */
export interface CameraOrbit {
  /** 相机在城心 ENU 平面上的方位角（自北顺时针，弧度）。 */
  azimuth: number
  /** 相机相对城心的水平距离（米）。 */
  distance: number
  /** 相机相对城心的高度（米）。 */
  altitude: number
  /** 恢复自转时是否需要重新读取相机位置（用户动过相机）。 */
  needsResync: boolean
}

/** 一次相机飞行的参数。 */
export interface CameraFlight {
  /** 落点。 */
  destination: Cesium.Cartesian3
  /** 朝向。 */
  orientation: { heading: number; pitch: number; roll: number }
  /** 飞行时长（秒）。 */
  duration: number
  /** 飞行保护期（毫秒）：这段时间里不推进自转。 */
  guardMs: number
  /** 飞行结束后是否从相机当前位置反算轨道状态。 */
  resync: boolean
}

/** 相机机位对外暴露的东西。 */
export interface CameraRig {
  /** 自转状态（全项目唯一一份）。 */
  cameraOrbit: CameraOrbit
  /** 把相机装到 viewer 上：交互监听 + 每帧自转。 */
  attach(viewer: Cesium.Viewer): void
  /** 摘掉相机：销毁交互监听、摘下自转回调。 */
  detach(viewer: Cesium.Viewer | null): void
  /** 飞一次（飞行期间不推进自转）。 */
  flyTo(flight: CameraFlight): void
  /** 飞到平视视角（1.7 m 人眼高度，朝北）。 */
  flyToStreetLevel(): void
  /** 飞到鸟瞰视角（城心上空 1500 m，俯角 45°）。 */
  flyToOverhead(options?: { duration?: number; resync?: boolean }): void
  /** 鸟瞰 ↔ 平视切换。 */
  toggleView(): void
}

/** 相机机位的输入。 */
export interface CameraRigOptions {
  /** Cesium 视图（场景底座给的那一份）。 */
  viewer: Ref<Cesium.Viewer | null>
  /** 视图状态（相机要读 `viewMode`）。 */
  state: SmartCityState
  /** 场景里的 Primitive 引用（自转时要推进流动光效的相位）。 */
  primitives: ScenePrimitives
}

export function useCameraRig({ viewer, state, primitives }: CameraRigOptions): CameraRig {
  const cameraOrbit: CameraOrbit = {
    azimuth: 0,
    distance: OVERHEAD_DISTANCE_M,
    altitude: cityConfig.zoomLevel,
    needsResync: false
  }

  /** 最后一次相机交互的时间戳（performance.now() 口径）。 */
  let lastInteractionAt = 0

  /** 相机飞行结束前的时间戳：这段时间里不推进自转。 */
  let cameraFlightUntil = 0

  /** 上一帧推进自转的时间戳。 */
  let lastOrbitFrameAt = 0

  /** 交互监听器：记录「最后一次交互时间」。 */
  let interactionHandler: Cesium.ScreenSpaceEventHandler | null = null

  /** 城心在城心 ENU 平面上的经纬度换算系数。 */
  const centerLatRad = (cityConfig.center.lat * Math.PI) / 180

  /** 把「城心 ENU 平面上的方位角 + 距离」换算成经纬度偏移。 */
  const offsetToLngLat = (azimuth: number, distance: number): { lng: number; lat: number } => ({
    lng: cityConfig.center.lng + (distance * Math.sin(azimuth)) / (METERS_PER_DEGREE_LAT * Math.cos(centerLatRad)),
    lat: cityConfig.center.lat + (distance * Math.cos(azimuth)) / METERS_PER_DEGREE_LAT
  })

  /** 自转落点：相机位置与朝向（始终看向城心）。 */
  const overheadView = (): { destination: Cesium.Cartesian3; heading: number; pitch: number } => {
    const { lng, lat } = offsetToLngLat(cameraOrbit.azimuth, cameraOrbit.distance)
    return {
      destination: Cesium.Cartesian3.fromDegrees(lng, lat, cameraOrbit.altitude),
      // 相机在城心的方位角 + 180° = 它看向城心的罗盘方位
      heading: cameraOrbit.azimuth + Math.PI,
      pitch: -OVERHEAD_TILT_RAD
    }
  }

  /** 把鸟瞰视角落到相机上。 */
  const applyOverheadView = (activeViewer: Cesium.Viewer) => {
    const view = overheadView()
    activeViewer.camera.setView({
      destination: view.destination,
      orientation: { heading: view.heading, pitch: view.pitch, roll: 0 }
    })
  }

  /**
   * 重新从相机当前位置读取自转状态。
   *
   * 用户操作过相机之后，相机已经不在轨道上了；恢复自转时先按它当前的位置
   * 重新起算，这样恢复的那一刻**不会跳**。
   */
  const readOrbitFromCamera = (activeViewer: Cesium.Viewer) => {
    const cartographic = activeViewer.camera.positionCartographic
    if (!cartographic) return
    const dLng =
      ((cartographic.longitude * 180) / Math.PI - cityConfig.center.lng) *
      METERS_PER_DEGREE_LAT *
      Math.cos(centerLatRad)
    const dLat = ((cartographic.latitude * 180) / Math.PI - cityConfig.center.lat) * METERS_PER_DEGREE_LAT
    cameraOrbit.distance = Math.hypot(dLng, dLat)
    cameraOrbit.azimuth = Math.atan2(dLng, dLat)
    cameraOrbit.altitude = cartographic.height
  }

  /**
   * 每帧推进自转。
   *
   * 三条规则：
   * 1. **平视不转**（1.7 m 高度自转会让人晕）。
   * 2. **用户刚操作过就不转**（距上次交互 > 4 秒才恢复）。
   * 3. 相机在飞行途中也不转（飞行与自转会互相打架）。
   */
  const onScenePreRender = () => {
    const activeViewer = viewer.value
    if (!activeViewer) return
    if (state.viewMode !== 'overhead') return

    const now = performance.now()
    if (now < cameraFlightUntil) return
    if (now - lastInteractionAt < ORBIT_RESUME_DELAY_MS) return

    const deltaSeconds = lastOrbitFrameAt === 0 ? 0 : Math.min(0.1, (now - lastOrbitFrameAt) / 1000)
    lastOrbitFrameAt = now

    if (cameraOrbit.needsResync) {
      readOrbitFromCamera(activeViewer)
      cameraOrbit.needsResync = false
    }

    cameraOrbit.azimuth += ORBIT_SPEED_RAD_PER_S * deltaSeconds

    // 流动光效推进：改材质的 dashLength 即可（渲染器每帧从 material.uniforms 读值）。
    if (primitives.flowMaterial) {
      primitives.flowMaterial.uniforms.dashLength = flowDashLength(FLOW_DASH_LENGTH, FLOW_PERIOD_SECONDS)
    }

    // 恢复自转时把距离/高度平滑收敛回目标值：用户拉近拉远的视角会被拉回大屏构图。
    const blend = 1 - Math.exp(-deltaSeconds / ORBIT_RESUME_TAU_S)
    cameraOrbit.distance += (OVERHEAD_DISTANCE_M - cameraOrbit.distance) * blend
    cameraOrbit.altitude += (cityConfig.zoomLevel - cameraOrbit.altitude) * blend

    applyOverheadView(activeViewer)
  }

  /** 任何相机输入都记一笔「最后一次交互时间」。 */
  const markCameraInteraction = () => {
    lastInteractionAt = performance.now()
    cameraOrbit.needsResync = true
  }

  /** 装上交互监听：鼠标一操作就停自转。 */
  const installCameraInteractionWatcher = (activeViewer: Cesium.Viewer) => {
    const handler = new Cesium.ScreenSpaceEventHandler(activeViewer.canvas)
    const eventTypes = [
      Cesium.ScreenSpaceEventType.LEFT_DOWN,
      Cesium.ScreenSpaceEventType.RIGHT_DOWN,
      Cesium.ScreenSpaceEventType.MIDDLE_DOWN,
      Cesium.ScreenSpaceEventType.MOUSE_MOVE,
      Cesium.ScreenSpaceEventType.WHEEL,
      Cesium.ScreenSpaceEventType.PINCH_START
    ]
    eventTypes.forEach((type) => handler.setInputAction(markCameraInteraction, type))
    interactionHandler = handler
  }

  const attach = (activeViewer: Cesium.Viewer) => {
    installCameraInteractionWatcher(activeViewer)
    activeViewer.scene.preRender.addEventListener(onScenePreRender)
  }

  const detach = (activeViewer: Cesium.Viewer | null) => {
    if (interactionHandler) {
      interactionHandler.destroy()
      interactionHandler = null
    }
    if (activeViewer) {
      activeViewer.scene.preRender.removeEventListener(onScenePreRender)
    }
  }

  /** 飞一次（飞行期间不推进自转）。 */
  const flyTo = (flight: CameraFlight) => {
    const activeViewer = viewer.value
    if (!activeViewer) return
    cameraFlightUntil = performance.now() + flight.guardMs
    if (flight.resync) {
      // 恢复自转时从相机当前位置重新起算，不硬拽回轨道。
      cameraOrbit.needsResync = true
    }
    activeViewer.camera.flyTo({
      destination: flight.destination,
      orientation: flight.orientation,
      duration: flight.duration,
    })
  }

  // 飞到平视视角：贴近地面（1.7m），pitch=0 水平看出去
  const flyToStreetLevel = () => {
    const activeViewer = viewer.value
    if (!activeViewer) return
    cameraFlightUntil = performance.now() + CAMERA_FLIGHT_GUARD_MS
    activeViewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        cityConfig.center.lng,
        cityConfig.center.lat,
        cityConfig.streetLevel.height
      ),
      orientation: {
        heading: cityConfig.streetLevel.heading,
        pitch: 0, // 水平
        roll: 0,
      },
      duration: 2,
    })
  }

  // 飞到鸟瞰视角：城心上空 1500m，俯角 45°，并恢复自转
  const flyToOverhead = (options: { duration?: number; resync?: boolean } = {}) => {
    const activeViewer = viewer.value
    if (!activeViewer) return
    const view = overheadView()
    flyTo({
      destination: view.destination,
      orientation: { heading: view.heading, pitch: view.pitch, roll: 0 },
      duration: options.duration ?? 2,
      guardMs: CAMERA_FLIGHT_GUARD_MS,
      resync: options.resync ?? true,
    })
  }

  const toggleView = () => {
    state.viewMode = state.viewMode === 'overhead' ? 'street' : 'overhead'
    if (state.viewMode === 'street') {
      flyToStreetLevel()
    } else {
      flyToOverhead()
    }
  }

  return {
    cameraOrbit,
    attach,
    detach,
    flyTo,
    flyToStreetLevel,
    flyToOverhead,
    toggleView,
  }
}
