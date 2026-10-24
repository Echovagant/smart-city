import { isRef, onUnmounted, ref, shallowRef, toRaw, watch } from 'vue'
import type { Ref } from 'vue'
import * as Cesium from 'cesium'
import { apiGet, ApiError } from '@/api/client'
import { METERS_PER_DEGREE_LAT } from './useSceneStage'
import type { SceneStage } from './useSceneStage'
import type { AreaStats, LngLat } from '../../types/city'

/**
 * 区域统计：**在场景里点一下地面 → 问后端那片范围的统计**。
 *
 * 交互方案是「点选 + 半径」（不是拖拽框选）：
 * - 点一下地面 → 命中点的经纬度 → 以它为中心取一个**固定半径**的矩形范围
 *   → `GET /api/city/area?bbox=...` → 面板显示建筑数 / 路网长度 / 设施分类 / 密度。
 * - 半径是**可调**的（200 / 300 / 500 m 三档），不写死。
 *
 * **为什么不抢相机**
 * ----------------
 * 本模块只往 Cesium 的画布上挂**一个 `LEFT_CLICK` 监听**，没有一行相机代码。
 * Cesium 的 `ScreenSpaceEventHandler` 只在「按下与抬起之间没有位移」时才算一次
 * 点击 —— 于是拖拽仍然是拖拽：无修饰键拖拽照旧旋转相机，滚轮照旧缩放。
 * 反过来说，用户**拖拽完**松手也不会误触发一次查询（那是一次拖拽，不是点击）。
 *
 * **场景底座由调用方显式传入**
 * --------------------------
 * 拾取必须发生在 Cesium 场景里，所以要拿到 `useSceneStage` 暴露的那份 `viewer`。
 * 那份底座在 `SmartCity.vue` 里，**由它显式传给大屏面板**
 * （`<DashboardOverlay :stage="stage">` → `useAreaQuery({ stage })`）。
 *
 * 这里**不从组件实例上翻** —— 生产构建里 `<script setup>` 的顶层绑定
 * 不会挂到 `setupState` 上（`inlineTemplate` 打开时 setup 直接返回渲染函数），
 * 那条「dev 能用、生产不能用」的路子已经坑过一次，不再来第二次。
 * 拿不到底座就是拿不到：界面显示「场景底座未就绪，无法拾取」，不假装能用。
 */

/** 半径档位（米）。面板上给这三档，不写死。 */
export const AREA_RADIUS_OPTIONS = [200, 300, 500] as const

/** 默认半径（米）。 */
export const DEFAULT_AREA_RADIUS_M = 300

/** 还没选区域时的空态文案。 */
export const AREA_EMPTY_TEXT = '在场景里点一下地面，查看该范围的统计'

/** 场景底座没接上时的文案：直说不能拾取，不装成「在场景里点一下地面」。 */
export const AREA_STAGE_NOT_READY_TEXT = '场景底座未就绪，无法拾取'

/** 点到天空（没命中地面）时的提示。 */
export const AREA_GROUND_HINT = '刚才点到了天空，请点地面上的位置'

/** 一片矩形范围（西 / 南 / 东 / 北，单位：度）。 */
export interface AreaBBox {
  west: number
  south: number
  east: number
  north: number
}

/**
 * 中心点 + 半径 → 矩形范围。
 *
 * 纬度方向 1 度约 111 320 m；经度方向要除以 `cos(纬度)` ——
 * 在北纬 41° 附近，经度一度比纬度一度短约 25%，不算这一项范围会偏。
 *
 * 半径非正数或中心点非法时返回 null（不构造一个倒置的框）。
 */
export const buildAreaBBox = (center: LngLat, radiusM: number): AreaBBox | null => {
  if (!center || !Number.isFinite(center.lng) || !Number.isFinite(center.lat)) return null
  if (!Number.isFinite(radiusM) || radiusM <= 0) return null
  const latRad = (center.lat * Math.PI) / 180
  const dLat = radiusM / METERS_PER_DEGREE_LAT
  const dLng = radiusM / (METERS_PER_DEGREE_LAT * Math.cos(latRad))
  return {
    west: center.lng - dLng,
    south: center.lat - dLat,
    east: center.lng + dLng,
    north: center.lat + dLat,
  }
}

/**
 * 范围 → 后端要的查询串（`min_lon,min_lat,max_lon,max_lat`）。
 *
 * 保留 6 位小数：约 0.1 m 的精度，远够用；固定位数也让同一片范围
 * 每次都得到同一个 key（后端的缓存才命得上）。
 */
export const formatAreaBBox = (bbox: AreaBBox): string =>
  [bbox.west, bbox.south, bbox.east, bbox.north].map(value => value.toFixed(6)).join(',')

/** 区域统计的输入。 */
export interface AreaQueryOptions {
  /**
   * 场景底座（只用到它的 `viewer`）。
   *
   * 由调用方**显式传入**（`SmartCity.vue` → `DashboardOverlay` → 这里）。
   * 没有底座就没有拾取：界面会显示「场景底座未就绪，无法拾取」，不假装能用。
   */
  stage?: SceneStage | null
}

/** 区域统计对外暴露的东西。 */
export interface AreaQuery {
  /** 当前半径（米）。 */
  radiusM: Ref<number>
  /** 当前选中的中心点；null = 还没选区域。 */
  center: Ref<LngLat | null>
  /** 最近一次取到的统计；null = 还没取到 / 取失败。 */
  stats: Ref<AreaStats | null>
  /** 正在取数。 */
  loading: Ref<boolean>
  /** 错误文案（人话）；null = 没有错误。 */
  error: Ref<string | null>
  /** 错误的原始信息（悬停提示用）。 */
  errorDetail: Ref<string | null>
  /** 一次性提示（例如「刚才点到了天空」）。 */
  hint: Ref<string | null>
  /** 空态文案。 */
  emptyText: string
  /** 选一个中心点并查询那片范围。 */
  pickAt(lng: number, lat: number): Promise<void>
  /** 改半径（有选区时按新半径重查）。 */
  setRadius(meters: number): Promise<void>
  /** 清掉当前选区。 */
  clear(): void
  /** 挂上场景底座（换底座时旧的监听会被摘掉）。 */
  attachStage(stage: SceneStage | null): void
}

/** 半径是不是允许的那几档。 */
const isKnownRadius = (meters: number): boolean =>
  (AREA_RADIUS_OPTIONS as readonly number[]).includes(meters)

/**
 * 错误 → 人话。取不到就是取不到，不编一个 0 顶上。
 *
 * 单独导出（纯函数，好测）：接口失败有好几种说法，面板上得给一句人话。
 */
export const areaErrorText = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 400) return '范围参数无效'
    if (error.status === 503) return '数据源暂不可用'
    if (error.status === 0) return '数据源暂不可用'
  }
  return '区域统计取不到'
}

/** 错误 → 原始信息（悬停提示）。 */
export const areaErrorDetail = (error: unknown): string => {
  if (error instanceof ApiError) {
    return error.status ? `${error.message}（状态码 ${error.status}）` : error.message
  }
  return String(error)
}

export function useAreaQuery(options: AreaQueryOptions = {}): AreaQuery {
  const radiusM = ref<number>(DEFAULT_AREA_RADIUS_M)
  const center = ref<LngLat | null>(null)
  // 载荷是整体替换的，用 shallowRef：不值得让 Vue 把整棵对象图深度响应式包装一遍。
  const stats = shallowRef<AreaStats | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const errorDetail = ref<string | null>(null)
  const hint = ref<string | null>(null)

  /** 请求序号：只有最后一次请求的结果算数（快速连点时旧结果直接丢掉）。 */
  let requestSeq = 0
  /** 组件是否还活着。 */
  let disposed = false

  /** 取一次统计。 */
  const load = async (target: LngLat): Promise<void> => {
    const bbox = buildAreaBBox(target, radiusM.value)
    if (!bbox) {
      error.value = '范围参数无效'
      errorDetail.value = '中心点或半径不合法'
      stats.value = null
      return
    }
    const seq = ++requestSeq
    loading.value = true
    error.value = null
    errorDetail.value = null
    try {
      const payload = await apiGet<AreaStats>(
        `/api/city/area?bbox=${encodeURIComponent(formatAreaBBox(bbox))}`,
      )
      if (disposed || seq !== requestSeq) return
      stats.value = payload
    } catch (e) {
      if (disposed || seq !== requestSeq) return
      stats.value = null
      error.value = areaErrorText(e)
      errorDetail.value = areaErrorDetail(e)
    } finally {
      if (!disposed && seq === requestSeq) loading.value = false
    }
  }

  /** 选一个中心点。 */
  const pickAt = async (lng: number, lat: number): Promise<void> => {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return
    center.value = { lng, lat }
    hint.value = null
    await load(center.value)
  }

  /** 改半径。 */
  const setRadius = async (meters: number): Promise<void> => {
    if (!isKnownRadius(meters)) return
    radiusM.value = meters
    if (!center.value) return
    await load(center.value)
  }

  /** 清掉选区（在途的请求一并作废）。 */
  const clear = (): void => {
    requestSeq += 1
    center.value = null
    stats.value = null
    error.value = null
    errorDetail.value = null
    loading.value = false
  }

  /* -------------------------------------------------------------------------
   * 拾取：Cesium 画布上的「点一下地面」
   * ---------------------------------------------------------------------- */

  /** 当前的点击监听器。 */
  let pickHandler: Cesium.ScreenSpaceEventHandler | null = null
  /** 当前监听器挂在哪个 viewer 上。 */
  let pickedViewer: Cesium.Viewer | null = null

  /** 摘掉点击监听。 */
  const uninstallPick = (): void => {
    if (pickHandler) {
      pickHandler.destroy()
      pickHandler = null
    }
    pickedViewer = null
  }

  /** 点一下：命中地面就查询，没命中（点到天空）就清掉当前选区。 */
  const onLeftClick = (movement: { position: Cesium.Cartesian2 }): void => {
    const viewer = pickedViewer
    if (!viewer) return
    const position = movement.position
    // 屏幕坐标 → 射线 → 地面交点。
    // 先问地面（跟着地形走），再退回到椭球面（地面没渲染出来时也兜得住）。
    const ray = viewer.camera.getPickRay(position)
    const picked =
      (ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined) ??
      viewer.camera.pickEllipsoid(position, viewer.scene.globe.ellipsoid)
    if (!picked) {
      clear()
      hint.value = AREA_GROUND_HINT
      return
    }
    const cartographic = Cesium.Cartographic.fromCartesian(picked)
    if (!cartographic) {
      clear()
      hint.value = AREA_GROUND_HINT
      return
    }
    void pickAt(
      Cesium.Math.toDegrees(cartographic.longitude),
      Cesium.Math.toDegrees(cartographic.latitude),
    )
  }

  /** 装上点击监听。 */
  const installPick = (viewer: Cesium.Viewer): void => {
    uninstallPick()
    pickHandler = new Cesium.ScreenSpaceEventHandler(viewer.canvas)
    pickHandler.setInputAction(onLeftClick, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    pickedViewer = viewer
  }

  /* -------------------------------------------------------------------------
   * 场景底座
   * ---------------------------------------------------------------------- */

  /** 盯着底座里的 viewer：它什么时候有值，就什么时候装上监听。 */
  let stopWatch: (() => void) | null = null

  /**
   * 底座里那个 `viewer` 引用。
   *
   * **为什么要 `toRaw`**：底座可能经过**深响应式代理**传进来，而 Vue 在深响应式对象上
   * **会解包 ref** —— `stage.viewer` 拿回来的是 `null` 而不是那个 `Ref`。
   * 拿它去 `watch` 只会得到一句「Invalid watch source」警告，监听根本装不上，
   * 表现为「点地面没反应」且没有任何报错。
   * `toRaw` 拿回原始对象，ref 还在原位；解包后的副本只作为兜底。
   */
  const viewerRefOf = (stage: SceneStage): Ref<Cesium.Viewer | null> | null => {
    const raw = toRaw(stage) as { viewer?: unknown }
    const candidate = isRef(raw.viewer) ? raw.viewer : stage.viewer
    return isRef(candidate) ? (candidate as Ref<Cesium.Viewer | null>) : null
  }

  const attachStage = (stage: SceneStage | null): void => {
    stopWatch?.()
    stopWatch = null
    if (!stage) {
      uninstallPick()
      return
    }
    const viewerRef = viewerRefOf(stage)
    if (!viewerRef) {
      // 底座里没有可用的 viewer 引用：不装监听（装了也是坏的）。
      uninstallPick()
      return
    }
    stopWatch = watch(
      viewerRef,
      (viewer) => {
        if (viewer) installPick(viewer)
        else uninstallPick()
      },
      { immediate: true },
    )
  }

  attachStage(options.stage ?? null)

  /** Esc 收起当前选区。 */
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    clear()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeydown)
  }

  onUnmounted(() => {
    disposed = true
    requestSeq += 1
    stopWatch?.()
    stopWatch = null
    uninstallPick()
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKeydown)
    }
  })

  return {
    radiusM,
    center,
    stats,
    loading,
    error,
    errorDetail,
    hint,
    emptyText: AREA_EMPTY_TEXT,
    pickAt,
    setRadius,
    clear,
    attachStage,
  }
}
