import { ref, onUnmounted } from 'vue'
import { apiGet, ApiError } from '@/api/client'

// 默认 bbox：覆盖北京天安门 ±2km，与 backend-python/scripts/fetch_osm_data.py 的 BBOX 对齐。
const DEFAULT_BBOX = '116.380,39.905,116.420,39.925'

export function useCityData() {
  const buildings = ref(null)
  const roads = ref(null)
  const trafficStatus = ref(null)
  const loading = ref(false)
  const error = ref(null)
  const cancelled = ref(false)

  const loadAll = async ({ bbox = DEFAULT_BBOX } = {}) => {
    loading.value = true
    error.value = null
    try {
      const [b, r, t] = await Promise.all([
        apiGet(`/api/buildings?bbox=${encodeURIComponent(bbox)}`),
        apiGet(`/api/roads?bbox=${encodeURIComponent(bbox)}`),
        apiGet('/api/traffic-status'),
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

  onUnmounted(() => {
    cancelled.value = true
  })

  return { buildings, roads, trafficStatus, loading, error, loadAll }
}