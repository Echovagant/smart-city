import { ref, shallowRef, onUnmounted } from 'vue'
import { apiGet, ApiError } from '@/api/client'

// 默认不传 bbox：后端直接返回完整集合。
// 之前默认带的 bbox（116.380,39.905,116.420,39.925）与 OSM 提取范围完全一致，
// 过滤等于把全部要素原样返回——每次请求白白多付一遍几何过滤的 CPU，
// 看起来像在做空间裁剪，其实没有。
// 需要按范围取数时仍然可以显式传 bbox。
export function useCityData() {
  // buildings / roads 是几 MB 的 GeoJSON（几万个坐标）。
  // 用 shallowRef：载荷是整体替换的，模板只需要知道「数据到了」，
  // 不需要 Vue 把整棵对象图深度响应式包装一遍。
  const buildings = shallowRef(null)
  const roads = shallowRef(null)
  // trafficStatus 是个小对象，普通 ref 即可。
  const trafficStatus = ref(null)
  const loading = ref(false)
  const error = ref(null)
  const cancelled = ref(false)

  const loadAll = async ({ bbox = null } = {}) => {
    loading.value = true
    error.value = null
    const query = bbox ? `?bbox=${encodeURIComponent(bbox)}` : ''
    try {
      const [b, r, t] = await Promise.all([
        apiGet(`/api/buildings${query}`),
        apiGet(`/api/roads${query}`),
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