import { ref, shallowRef, onUnmounted } from 'vue'
import { apiGet, ApiError } from '@/api/client'
import type {
  BBoxParam,
  BuildingsResponse,
  CityOverview,
  RoadsResponse,
  TrafficStatus,
} from '../../types/city'

// 默认不传 bbox：后端直接返回完整集合。
// 带 bbox 反而要把全部要素原样过滤一遍——每次请求白白多付一遍几何过滤的 CPU，
// 看起来像在做空间裁剪，其实没有。
// 需要按范围取数时仍然可以显式传 bbox。

/**
 * 当前城市的 id（slug）。
 *
 * 后端按它选数据源与城市表条目；换城市只改这一处。
 */
export const CITY_ID = 'barcelona'

/** 城市运行指标端点（带城市 id）。 */
export const CITY_OVERVIEW_PATH = `/api/city/overview?city=${CITY_ID}`

export function useCityData() {
  // buildings / roads 是几 MB 的 GeoJSON（几万个坐标）。
  // 用 shallowRef：载荷是整体替换的，模板只需要知道「数据到了」，
  // 不需要 Vue 把整棵对象图深度响应式包装一遍。
  const buildings = shallowRef<BuildingsResponse | null>(null)
  const roads = shallowRef<RoadsResponse | null>(null)
  // trafficStatus 是个小对象，普通 ref 即可。
  const trafficStatus = ref<TrafficStatus | null>(null)
  // 城市运行指标（空气质量 / 天气 / 路网静态指标）。
  // 载荷不大但结构固定，用 shallowRef 即可 —— 整体替换，不做深度响应式。
  const cityOverview = shallowRef<CityOverview | null>(null)
  const cityOverviewError = ref<ApiError | null>(null)
  const cityOverviewLoading = ref(false)
  const loading = ref(false)
  const error = ref<ApiError | null>(null)
  const cancelled = ref(false)

  const loadAll = async ({ bbox = null }: { bbox?: BBoxParam | null } = {}) => {
    loading.value = true
    error.value = null
    const query = bbox ? `?bbox=${encodeURIComponent(bbox)}` : ''
    try {
      const [b, r, t] = await Promise.all([
        apiGet<BuildingsResponse>(`/api/buildings${query}`),
        apiGet<RoadsResponse>(`/api/roads${query}`),
        apiGet<TrafficStatus>('/api/traffic-status'),
      ])
      if (cancelled.value) return
      buildings.value = b
      roads.value = r
      trafficStatus.value = t
    } catch (e) {
      if (cancelled.value) return
      error.value = e instanceof ApiError ? e : new ApiError(String(e))
    } finally {
      loading.value = false
    }
  }

  // 只刷新交通状态这一个端点。
  // 它不参与 3D 渲染，单独取：轮询失败时保留上一次的读数，
  // 不动 buildings / roads，也不把「数据加载失败」横幅拉起来。
  const refreshTrafficStatus = async () => {
    try {
      const t = await apiGet<TrafficStatus>('/api/traffic-status')
      if (cancelled.value) return
      trafficStatus.value = t
    } catch {
      // 轮询失败保持上一次的读数即可，不必打扰用户。
    }
  }

  /**
   * 取一次城市运行指标。
   *
   * 与 buildings / roads 分开取：它要走外部上游（可能慢到 5 秒），
   * 绝不能拖慢首屏的场景装配。失败只记在 cityOverviewError 上，
   * 不动全局的 error 横幅 —— 3D 城市本身还是好的。
   */
  const loadCityOverview = async () => {
    cityOverviewLoading.value = true
    cityOverviewError.value = null
    try {
      const overview = await apiGet<CityOverview>(CITY_OVERVIEW_PATH)
      if (cancelled.value) return
      cityOverview.value = overview
    } catch (e) {
      if (cancelled.value) return
      cityOverviewError.value = e instanceof ApiError ? e : new ApiError(String(e))
    } finally {
      cityOverviewLoading.value = false
    }
  }

  /**
   * 轮询用：只刷新城市指标。
   *
   * 失败时保留上一次的读数（不把旧值说成新值）：
   * 后端已经把「某个源取不到」表达成 value = null + degraded，
   * 端点本身挂掉时宁可什么都不显示，也不要拿旧值冒充。
   */
  const refreshCityOverview = async () => {
    try {
      const overview = await apiGet<CityOverview>(CITY_OVERVIEW_PATH)
      if (cancelled.value) return
      cityOverview.value = overview
    } catch {
      // 轮询失败保持上一次的读数即可。
    }
  }

  onUnmounted(() => {
    cancelled.value = true
  })

  return {
    buildings,
    roads,
    trafficStatus,
    refreshTrafficStatus,
    cityOverview,
    cityOverviewError,
    cityOverviewLoading,
    loadCityOverview,
    refreshCityOverview,
    loading,
    error,
    loadAll,
  }
}
