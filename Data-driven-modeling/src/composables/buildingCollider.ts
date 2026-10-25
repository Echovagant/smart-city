/**
 * 建筑碰撞索引 —— 第一人称漫游用。
 *
 * ## 为什么需要
 *
 * 平视（第一人称）如果不管碰撞，相机能直接穿过楼 —— 看着像穿模。
 * 数据是现成的：前端已经加载了当前城市的建筑 GeoJSON（巴塞罗那 4366 栋），
 * 只需要一份「这个点是不是在建筑里」的快速查询。
 *
 * ## 怎么做
 *
 * - 把每个建筑多边形登记到它**包围盒覆盖的所有网格**里（网格 100 m）；
 * - 查询时只看相机所在的那一格 —— 因为多边形被登记进了它覆盖的每一格，
 *   所以不会漏；相邻格的建筑不影响这一格 ✓；
 * - 点在多边形内用**射线法**（水平方向数交点，奇数即在内部）✓。
 *
 * 代价：建索引一次（巴塞罗那约 4366 个多边形，实测几十毫秒），
 * 查询一次是 O(该格里的多边形数) ✓。
 */

/** 网格边长（米）。 */
const CELL_SIZE_M = 100

/** 一个建筑多边形（经纬度环）。 */
type Ring = number[][]

/** GeoJSON 坐标结构（只取需要的层级，不做形状校验）。 */
type GeoPolygon = Ring[]

/** 建筑碰撞查询。 */
export interface BuildingCollider {
  /** 这个经纬度是否落在某个建筑内部。 */
  isBlocked(lng: number, lat: number): boolean
  /** 索引里的多边形数量（自检用）。 */
  readonly size: number
}

/** 射线法：点是否在多边形内。 */
const pointInRing = (lng: number, lat: number, ring: Ring): boolean => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    // 交点在测试射线（y = lat）上，且交点位于边的 x 区间内
    const crosses = yi > lat !== yj > lat
    if (crosses && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** 把经纬度换算成以城心为原点的米制平面坐标（用于分桶）。 */
const toLocalMeters = (
  lng: number,
  lat: number,
  originLng: number,
  originLat: number,
): { x: number; y: number } => ({
  x: (lng - originLng) * 111320 * Math.cos((originLat * Math.PI) / 180),
  y: (lat - originLat) * 111320,
})

/**
 * 用建筑要素建一份碰撞索引。
 *
 * 要素结构与后端 `/api/buildings` 一致：GeoJSON Feature 的 `geometry` 可能是
 * `Polygon` 或 `MultiPolygon`（巴塞罗那有 22% 是 MultiPolygon ✓ 要都算上）。
 */
export const buildBuildingCollider = (
  features: Array<{
    geometry?: { type?: string; coordinates?: unknown } | null
  }>,
  origin: { lng: number; lat: number },
): BuildingCollider => {
  const cells = new Map<string, Ring[]>()
  let size = 0

  const addRing = (ring: Ring) => {
    if (ring.length < 3) return
    size += 1
    const points = ring.map(([lng, lat]) =>
      toLocalMeters(lng, lat, origin.lng, origin.lat),
    )
    const xs = points.map(point => point.x)
    const ys = points.map(point => point.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const x0 = Math.floor(minX / CELL_SIZE_M)
    const x1 = Math.floor(maxX / CELL_SIZE_M)
    const y0 = Math.floor(minY / CELL_SIZE_M)
    const y1 = Math.floor(maxY / CELL_SIZE_M)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = `${cx}:${cy}`
        const bucket = cells.get(key)
        if (bucket) bucket.push(ring)
        else cells.set(key, [ring])
      }
    }
  }

  for (const feature of features) {
    const geometry = feature.geometry
    if (!geometry || !geometry.coordinates) continue
    if (geometry.type === 'Polygon') {
      const rings = geometry.coordinates as GeoPolygon
      if (rings[0]) addRing(rings[0])
    } else if (geometry.type === 'MultiPolygon') {
      for (const polygon of geometry.coordinates as GeoPolygon[]) {
        if (polygon[0]) addRing(polygon[0])
      }
    }
  }

  return {
    isBlocked(lng: number, lat: number): boolean {
      const local = toLocalMeters(lng, lat, origin.lng, origin.lat)
      const key = `${Math.floor(local.x / CELL_SIZE_M)}:${Math.floor(local.y / CELL_SIZE_M)}`
      const bucket = cells.get(key)
      if (!bucket) return false
      for (const ring of bucket) {
        if (pointInRing(lng, lat, ring)) return true
      }
      return false
    },
    get size() {
      return size
    },
  }
}
