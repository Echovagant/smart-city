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
import type { BuildingCollider } from './buildingCollider'

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
  /**
   * 建筑碰撞索引（第一人称漫游时挡墙）。
   *
   * 用 Ref：索引是**建筑数据到了之后**才建好的 ✓，
   * 相机 rig 早在挂载时就创建了 ✓ —— 传 Ref 就不用重建 rig ✓。
   */
  collider?: Ref<BuildingCollider | null>
}

/** 走 / 跑 / 冲刺的目标速度（米/秒）。 */
export const STREET_SPEED_WALK = 2.5
export const STREET_SPEED_RUN = 6
export const STREET_SPEED_SPRINT = 15

/** 加速 / 减速（米/秒²）：有加速度才不会「一按就瞬移、松键滑行」。 */
const STREET_ACCEL = 14
const STREET_DECEL = 18

/** 第一人称的视野（度）。默认 60° 太像望远镜，75° 接近 3A 第一人称。 */
export const STREET_FOV_RAD = (75 * Math.PI) / 180

/** 鸟瞰的视野（度）—— Cesium 的默认值，离开街道要还原。 */
const OVERHEAD_FOV_RAD = (60 * Math.PI) / 180

/** 输入框里打字时不触发漫游快捷键。 */
const isTypingTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  if (!element || !element.tagName) return false
  const tag = element.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable === true
}

export function useCameraRig({ viewer, state, primitives, collider }: CameraRigOptions): CameraRig {
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

  /** 当前按下的键（`KeyboardEvent.code`）。 */
  const keysDown = new Set<string>()

  /** 第一人称：按住修饰键从鸟瞰临时落到街上。 */
  let firstPerson = false

  /** 街上时相机所在的经纬度（脚下那个点）。 */
  let streetLng = 0
  let streetLat = 0

  /** 街上时的前向 / 侧向速度（米/秒，带符号）。 */
  let forwardSpeed = 0
  let strafeSpeed = 0

  /** 上一帧的时间戳（算 dt 用）。 */
  let lastMoveFrameAt = 0

  /** 键盘监听的清理函数（detach 时要摘掉 window 上的监听）。 */
  let keyboardCleanup: (() => void) | null = null

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

    // 街上：每帧推进移动（速度有加速度，所以不是「一按就瞬移」）。
    if (onStreet()) {
      const deltaSeconds = lastMoveFrameAt === 0 ? 0 : Math.min(0.1, (now - lastMoveFrameAt) / 1000)
      lastMoveFrameAt = now
      updateStreetMovement(activeViewer, deltaSeconds)
      return
    }
    lastMoveFrameAt = 0

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
    installKeyboardWatcher()
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
    if (keyboardCleanup) {
      keyboardCleanup()
    }
    if (activeViewer) {
      activeViewer.scene.preRender.removeEventListener(onScenePreRender)
    }
  }

  /**
   * 街道视角（平视）当前的相机位置与朝向。
   *
   * 位置由我们自己管（不用 Cesium 的 lookAt 变换 —— 那正是之前
   * `HeadingPitchRange(..., 0)` 把整个场景搞崩的原因）。
   */
  const applyStreetView = (activeViewer: Cesium.Viewer) => {
    activeViewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        streetLng,
        streetLat,
        cityConfig.streetLevel.height,
      ),
      orientation: {
        heading: activeViewer.camera.heading,
        pitch: activeViewer.camera.pitch,
        roll: 0,
      },
    })
  }

  /** 相机现在是不是在街上（底栏切的平视，或 Alt 临时进入的第一人称）。 */
  const onStreet = (): boolean => state.viewMode === 'street' || firstPerson

  /**
   * 设置视野角（弧度）。
   *
   * 只有透视相机有 `fov` ✓（正交相机没有）→ 用 instanceof 判一下 ✓。
   */
  const setCameraFov = (activeViewer: Cesium.Viewer, radians: number) => {
    const frustum = activeViewer.camera.frustum
    if (frustum instanceof Cesium.PerspectiveFrustum) {
      frustum.fov = radians
    }
  }

  /** 速度趋近目标值：加速度有限，所以有起步与刹车。 */
  const approachSpeed = (current: number, target: number, dt: number): number => {
    const rate = target === 0 ? STREET_DECEL : STREET_ACCEL
    const delta = target - current
    const step = rate * dt
    if (Math.abs(delta) <= step) return target
    return current + Math.sign(delta) * step
  }

  /**
   * 街上移动：先试完整位移，撞墙就拆成「只前进」或「只侧移」——沿墙滑。
   */
  const moveOnStreet = (activeViewer: Cesium.Viewer, north: number, east: number) => {
    const metersPerDegLat = METERS_PER_DEGREE_LAT
    const metersPerDegLng = METERS_PER_DEGREE_LAT * Math.cos((streetLat * Math.PI) / 180)
    const activeCollider = collider?.value ?? null
    const attempt = (dn: number, de: number): { lng: number; lat: number } | null => {
      const lng = streetLng + de / metersPerDegLng
      const lat = streetLat + dn / metersPerDegLat
      if (activeCollider && activeCollider.isBlocked(lng, lat)) return null
      return { lng, lat }
    }
    let next = attempt(north, east)
    if (!next) next = attempt(north, 0)
    if (!next) next = attempt(0, east)
    if (!next) return
    streetLng = next.lng
    streetLat = next.lat
    applyStreetView(activeViewer)
  }

  /**
   * 每帧的移动积分。
   *
   * 朝向用的是**相机当前的 heading**（拖拽已经在改它 ✓），
   * 所以「边走边转」是自然的 ✓。
   */
  const updateStreetMovement = (activeViewer: Cesium.Viewer, dt: number) => {
    const forwardInput = (keysDown.has('KeyW') ? 1 : 0) - (keysDown.has('KeyS') ? 1 : 0)
    const strafeInput = (keysDown.has('KeyD') ? 1 : 0) - (keysDown.has('KeyA') ? 1 : 0)
    const sprint = keysDown.has('ControlLeft') || keysDown.has('ControlRight')
    const run = keysDown.has('ShiftLeft') || keysDown.has('ShiftRight')
    const targetSpeed = sprint ? STREET_SPEED_SPRINT : run ? STREET_SPEED_RUN : STREET_SPEED_WALK

    forwardSpeed = approachSpeed(forwardSpeed, forwardInput * targetSpeed, dt)
    strafeSpeed = approachSpeed(strafeSpeed, strafeInput * targetSpeed, dt)
    if (forwardSpeed === 0 && strafeSpeed === 0) return

    const heading = activeViewer.camera.heading
    // 相机朝向的单位向量（ENU）：前 = (sin, cos)，右 = (cos, -sin)
    const north =
      Math.cos(heading) * forwardSpeed * dt - Math.sin(heading) * strafeSpeed * dt
    const east =
      Math.sin(heading) * forwardSpeed * dt + Math.cos(heading) * strafeSpeed * dt
    moveOnStreet(activeViewer, north, east)
  }

  /**
   * 从鸟瞰**临时落到街上**（按住修饰键）。
   *
   * 落点的算法（按顺序试）：
   * 1. 当前鸟瞰相机的**正下方** —— 「从你正在看的地方掉到街上」；
   * 2. 那儿被楼占了（大概率：1500 m 高空的正下方几乎肯定是个屋顶），
   *    就往城心方向逐级退（最多 5 步 × 30 m）；
   * 3. 还是被占，就落到**平视落点** —— 那是实测过在街上的位置 ✓。
   *
   * 落地时**抬头到水平**（pitch = 0）：保留鸟瞰的 -45° 俯角会让人一直低头看地 ✓。
   */
  const enterFirstPerson = (activeViewer: Cesium.Viewer) => {
    if (firstPerson || state.viewMode === 'street') return
    const carto = activeViewer.camera.positionCartographic
    if (!carto) return
    const heading = activeViewer.camera.heading
    const activeCollider = collider?.value ?? null
    let lng = (carto.longitude * 180) / Math.PI
    let lat = (carto.latitude * 180) / Math.PI
    const free = (testLng: number, testLat: number) =>
      !activeCollider || !activeCollider.isBlocked(testLng, testLat)
    /**
     * 这个点算不算「在街上」：脚下不能是楼，而且**周围要有楼**。
     *
     * 只查脚下是不够的 —— 退到一个开阔地（周围没楼）虽然不穿墙，
     * 但画面里全是空地，没有街道峡谷的感觉 ✓。
     */
    const onStreetSpot = (testLng: number, testLat: number) => {
      if (!free(testLng, testLat)) return false
      if (!activeCollider) return true
      const metersPerDegLat = METERS_PER_DEGREE_LAT
      const metersPerDegLng = METERS_PER_DEGREE_LAT * Math.cos((testLat * Math.PI) / 180)
      for (let i = 0; i < 8; i++) {
        const angle = (i * Math.PI) / 4
        const probeLng = testLng + (40 * Math.sin(angle)) / metersPerDegLng
        const probeLat = testLat + (40 * Math.cos(angle)) / metersPerDegLat
        if (activeCollider.isBlocked(probeLng, probeLat)) return true
      }
      return false
    }
    if (!onStreetSpot(lng, lat)) {
      let found = false
      for (let step = 0; step < 5; step++) {
        const toCenter = Math.atan2(
          (cityConfig.center.lng - lng) * Math.cos((lat * Math.PI) / 180),
          cityConfig.center.lat - lat,
        )
        lng -= (30 * Math.sin(toCenter)) / (METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180))
        lat -= (30 * Math.cos(toCenter)) / METERS_PER_DEGREE_LAT
        if (onStreetSpot(lng, lat)) {
          found = true
          break
        }
      }
      if (!found) {
        const fallback = cityConfig.streetPosition ?? cityConfig.center
        lng = fallback.lng
        lat = fallback.lat
      }
    }
    streetLng = lng
    streetLat = lat
    forwardSpeed = 0
    strafeSpeed = 0
    firstPerson = true
    state.firstPerson = true
    // 街上时 Cesium 自己的旋转/缩放都要关（同平视）。
    setStreetControls(activeViewer, true)
    setCameraFov(activeViewer, STREET_FOV_RAD)
    activeViewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        streetLng,
        streetLat,
        cityConfig.streetLevel.height,
      ),
      orientation: { heading, pitch: 0, roll: 0 },
    })
  }

  /** 松开修饰键：从第一人称飞回鸟瞰轨道。 */
  const exitFirstPerson = (activeViewer: Cesium.Viewer) => {
    if (!firstPerson) return
    firstPerson = false
    state.firstPerson = false
    forwardSpeed = 0
    strafeSpeed = 0
    // 回到鸟瞰：把控制权还给 Cesium（旋转/缩放/碰撞检测都恢复）。
    setStreetControls(activeViewer, false)
    setCameraFov(activeViewer, OVERHEAD_FOV_RAD)
    const view = overheadView()
    activeViewer.camera.flyTo({
      destination: view.destination,
      orientation: { heading: view.heading, pitch: view.pitch, roll: 0 },
      duration: 0.8,
    })
  }

  /**
   * 键盘监听：WASD 移动 + 修饰键进出第一人称。
   *
   * 挂在 `window` 上：大屏常常是全屏无焦点的，
   * 只监听 canvas 的话键盘根本收不到。
   */
  const installKeyboardWatcher = () => {
    const onKeyDown = (event: KeyboardEvent) => {      if (isTypingTarget(event.target)) return
      const activeViewer = viewer.value
      if (!activeViewer) return
      keysDown.add(event.code)
      if (event.code === 'AltLeft' || event.code === 'AltRight') {
        event.preventDefault()
        enterFirstPerson(activeViewer)
      }
      if (
        event.code === 'Space' ||
        event.code === 'Tab' ||
        event.code.startsWith('Arrow')
      ) {
        event.preventDefault()
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      keysDown.delete(event.code)
      const activeViewer = viewer.value
      if (!activeViewer) return
      if (event.code === 'AltLeft' || event.code === 'AltRight') {
        exitFirstPerson(activeViewer)
      }
    }
    // 失焦（切窗口 / Alt+Tab）时松开所有键，否则会一直往前走。
    const onBlur = () => {
      keysDown.clear()
      const activeViewer = viewer.value
      if (activeViewer) exitFirstPerson(activeViewer)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    keyboardCleanup = () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      keyboardCleanup = null
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
      if (!onStreet()) return
      streetDrag = {
        x: event.position.x,
        y: event.position.y,
        heading: activeViewer.camera.heading,
        pitch: activeViewer.camera.pitch,
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN)

    handler.setInputAction((event: { endPosition: Cesium.Cartesian2 }) => {
      if (!onStreet() || !streetDrag) return
      const dx = event.endPosition.x - streetDrag.x
      const dy = event.endPosition.y - streetDrag.y
      activeViewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(
          streetLng,
          streetLat,
          cityConfig.streetLevel.height,
        ),
        orientation: {
          heading: streetDrag.heading - dx * STREET_DRAG_RADIANS_PER_PIXEL,
          pitch: streetDrag.pitch + dy * STREET_DRAG_RADIANS_PER_PIXEL,
          roll: 0,
        },
      })
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
    // 街道位置由我们自己管：拖拽与 WASD 都在这个经纬度上改。
    streetLng = streetPosition.lng
    streetLat = streetPosition.lat
    forwardSpeed = 0
    strafeSpeed = 0
    setCameraFov(activeViewer, STREET_FOV_RAD)
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
        applyStreetView(current)
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
    // 视野还原成鸟瞰的默认值（街上时是 75°）。
    setCameraFov(activeViewer, OVERHEAD_FOV_RAD)
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
