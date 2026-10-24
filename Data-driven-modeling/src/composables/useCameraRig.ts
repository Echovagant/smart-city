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

/**
 * 平视拖拽的灵敏度（弧度 / 像素）。
 *
 * 约 0.2°/px：横向拖 400 px 转头 80°，手感接近 Cesium 自己的鸟瞰旋转。
 * **必须自己定这个系数**：Cesium 3D 的默认拖拽是「绕光标下的地面点转」，
 * 在 1.7 m 高度上那个点就在脚边，转角会被放大到失控（拖一下就翻跟头），
 * 而且相机会被甩出去 —— 用户报的「卡顿 + 高度乱飘」就是它。
 */
export const STREET_DRAG_RADIANS_PER_PIXEL = 0.0035

/** 平视俯仰的上下限（弧度）：±75°，避免完全垂直看天 / 看地。 */
export const STREET_PITCH_LIMIT_RAD = (75 * Math.PI) / 180

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

  /** 平视拖拽的监听器（平视时我们自己接管转向）。 */
  let streetDragHandler: Cesium.ScreenSpaceEventHandler | null = null

  /** 平视拖拽的起点与起始朝向（null = 没在拖）。 */
  let streetDrag: { x: number; y: number; heading: number; pitch: number } | null = null

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

    const now = performance.now()

    // 流动光效的相位**每帧都要推进**（鸟瞰、平视都一样）——
    // 之前这段挂在「鸟瞰」分支里，切到平视时流动层就**冻住**了。
    if (primitives.flowMaterial) {
      primitives.flowMaterial.uniforms.dashLength = flowDashLength(FLOW_DASH_LENGTH, FLOW_PERIOD_SECONDS)
    }

    if (state.viewMode !== 'overhead') return
    if (now < cameraFlightUntil) return
    if (now - lastInteractionAt < ORBIT_RESUME_DELAY_MS) return

    const deltaSeconds = lastOrbitFrameAt === 0 ? 0 : Math.min(0.1, (now - lastOrbitFrameAt) / 1000)
    lastOrbitFrameAt = now

    if (cameraOrbit.needsResync) {
      readOrbitFromCamera(activeViewer)
      cameraOrbit.needsResync = false
    }

    cameraOrbit.azimuth += ORBIT_SPEED_RAD_PER_S * deltaSeconds

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
    installStreetDragWatcher(activeViewer)
    activeViewer.scene.preRender.addEventListener(onScenePreRender)
  }

  const detach = (activeViewer: Cesium.Viewer | null) => {
    if (interactionHandler) {
      interactionHandler.destroy()
      interactionHandler = null
    }
    if (streetDragHandler) {
      streetDragHandler.destroy()
      streetDragHandler = null
    }
    if (activeViewer) {
      activeViewer.scene.preRender.removeEventListener(onScenePreRender)
    }
  }

  /**
   * 平视的拖拽：自己接管转向。
   *
   * **为什么不交给 Cesium**：3D 模式的左键拖拽是「绕光标下的地面点旋转」。
   * 平视时那个点就在脚边（1.7 m），转角被放大到失控（拖一下就翻跟头），
   * 而且相机的**位置会被甩出去** —— 表现就是「高度在拖拽过程里一路变」。
   *
   * 所以平视期间关掉 Cesium 的旋转（见 setStreetControls），
   * 这里按固定灵敏度把鼠标位移换算成 heading / pitch，
   * 再用 `setView` 把相机**放回眼睛位置** —— 位置与高度永远不变。
   *
   * 方向约定跟 Cesium 的地球模式一致「抓着世界拖」：
   * 右拖 → 视线左转（heading 减小）；下拖 → 抬头（pitch 增大）。
   */
  const installStreetDragWatcher = (activeViewer: Cesium.Viewer) => {
    const handler = new Cesium.ScreenSpaceEventHandler(activeViewer.canvas)

    // ⚠️ Cesium 的 LEFT_DOWN 回调收到的是 `{ position }`（单个点），
    // **不是** `{ startPosition, endPosition }` —— 那是 MOUSE_MOVE / LEFT_DRAG 的形状。
    // 写错会在回调里抛 TypeError，拖拽静默失效（实测：探针显示 down=2 但 drag 一直是 null）。
    handler.setInputAction((event: { position: Cesium.Cartesian2 }) => {
      if (state.viewMode !== 'street') return
      streetDrag = {
        x: event.position.x,
        y: event.position.y,
        heading: activeViewer.camera.heading,
        pitch: activeViewer.camera.pitch,
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN)

    handler.setInputAction((event: { endPosition: Cesium.Cartesian2 }) => {
      if (state.viewMode !== 'street' || !streetDrag) return
      const dx = event.endPosition.x - streetDrag.x
      const dy = event.endPosition.y - streetDrag.y
      applyStreetView(
        activeViewer,
        streetDrag.heading - dx * STREET_DRAG_RADIANS_PER_PIXEL,
        streetDrag.pitch + dy * STREET_DRAG_RADIANS_PER_PIXEL,
      )
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    handler.setInputAction(() => {
      streetDrag = null
    }, Cesium.ScreenSpaceEventType.LEFT_UP)

    streetDragHandler = handler
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

  // 飞到平视视角：贴近地面（1.7m），pitch=0 水平看出去。
  // 落点用 `streetPosition`（缺省回落到城心）—— 城心在街区内部，
  // 1.7 m 的相机停在那里会钻进建筑。
  const flyToStreetLevel = () => {
    const activeViewer = viewer.value
    if (!activeViewer) return
    const streetPosition = cityConfig.streetPosition ?? cityConfig.center
    cameraFlightUntil = performance.now() + CAMERA_FLIGHT_GUARD_MS
    // 平视期间先关掉缩放与碰撞检测（见 setStreetControls 的说明）。
    setStreetControls(activeViewer, true)
    activeViewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        streetPosition.lng,
        streetPosition.lat,
        cityConfig.streetLevel.height
      ),
      orientation: {
        heading: cityConfig.streetLevel.heading,
        pitch: 0, // 水平
        roll: 0,
      },
      duration: 2,
      complete: () => {
        // 飞行结束后把相机**钉在眼睛位置**上：此后拖拽只转头，不挪位置。
        const current = viewer.value
        if (!current) return
        applyStreetView(current, cityConfig.streetLevel.heading, 0)
      },
    })
  }

  /**
   * 把相机放到平视落点上（位置**钉死**，只给朝向）。
   *
   * 用 `setView` 而不是 `camera.lookAt`：
   * `lookAt` 的半径为 0 时，`offsetFromHeadingPitchRange` 返回零向量，
   * Cesium 归一化它时直接抛 `DeveloperError: normalized result is not a number`
   * ——渲染整个停掉（实测平视一切过去就白屏报错）。
   * 半径给非零值又会把相机放到离落点 range 米的地方，俯仰一变高度就飘。
   *
   * 所以平视的转向**自己接管**（见 installStreetDragWatcher）：
   * 位置永远是眼睛位置，朝向由拖拽改。
   */
  const applyStreetView = (
    activeViewer: Cesium.Viewer,
    heading: number,
    pitch: number,
  ) => {
    const streetPosition = cityConfig.streetPosition ?? cityConfig.center
    activeViewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        streetPosition.lng,
        streetPosition.lat,
        cityConfig.streetLevel.height
      ),
      orientation: {
        heading,
        pitch: Math.max(
          -STREET_PITCH_LIMIT_RAD,
          Math.min(STREET_PITCH_LIMIT_RAD, pitch),
        ),
        roll: 0,
      },
    })
  }

  /**
   * 平视期间的控制器开关。
   *
   * - **关缩放**：平视是「站在原地」，滚轮不该把相机推走（推走 = 高度变了）。
   * - **关碰撞检测**：1.7 m 高度上，碰撞检测一旦发现相机与地面/建筑相交
   *   就会把相机顶上去 —— 表现就是「平视时高度自己往上飘」。
   * - **关 Cesium 自带的旋转**：它拖的是「绕光标下那个地面点转」，
   *   而 1.7 m 高度上那个点就在脚边，转角会被放大到失控（拖一下就翻跟头），
   *   还会把相机位置甩出去。转向我们自己来。
   */
  const setStreetControls = (activeViewer: Cesium.Viewer, enabled: boolean) => {
    const controller = activeViewer.scene.screenSpaceCameraController
    if (!controller) return
    controller.enableZoom = !enabled
    controller.enableCollisionDetection = !enabled
    controller.enableRotate = !enabled
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
    const activeViewer = viewer.value
    if (state.viewMode === 'overhead') {
      state.viewMode = 'street'
      flyToStreetLevel()
    } else {
      state.viewMode = 'overhead'
      // 回鸟瞰前把控制权还给 Cesium：平视期间我们关掉了它的旋转。
      if (activeViewer) setStreetControls(activeViewer, false)
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
