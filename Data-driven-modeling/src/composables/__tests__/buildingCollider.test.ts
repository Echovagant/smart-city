import { describe, it, expect } from 'vitest'
import { buildBuildingCollider } from '../buildingCollider'

/** 造一个方形建筑（经纬度）。 */
const square = (lng: number, lat: number, size: number) => [
  [
    [lng, lat],
    [lng + size, lat],
    [lng + size, lat + size],
    [lng, lat + size],
    [lng, lat],
  ],
]

const origin = { lng: 2.1652, lat: 41.39585 }

describe('buildingCollider —— 第一人称漫游挡墙', () => {
  it('点在建筑内部 → 判定为挡路', () => {
    const collider = buildBuildingCollider(
      [{ geometry: { type: 'Polygon', coordinates: square(2.1652, 41.39585, 0.001) } }],
      origin,
    )
    expect(collider.size).toBe(1)
    expect(collider.isBlocked(2.1655, 41.3961)).toBe(true)
  })

  it('点在建筑外面 → 判定为可走', () => {
    const collider = buildBuildingCollider(
      [{ geometry: { type: 'Polygon', coordinates: square(2.1652, 41.39585, 0.001) } }],
      origin,
    )
    expect(collider.isBlocked(2.1700, 41.39585)).toBe(false)
  })

  it('MultiPolygon 里的每一块都要算进去（巴塞罗那有 22% 是 MultiPolygon）', () => {
    const collider = buildBuildingCollider(
      [
        {
          geometry: {
            type: 'MultiPolygon',
            coordinates: [square(2.1652, 41.39585, 0.001), square(2.1700, 41.39585, 0.001)],
          },
        },
      ],
      origin,
    )
    expect(collider.size).toBe(2)
    expect(collider.isBlocked(2.1655, 41.3961)).toBe(true)
    expect(collider.isBlocked(2.1703, 41.3961)).toBe(true)
    expect(collider.isBlocked(2.1680, 41.3961)).toBe(false)
  })

  it('空数据 → 什么都不挡', () => {
    const collider = buildBuildingCollider([], origin)
    expect(collider.size).toBe(0)
    expect(collider.isBlocked(2.1652, 41.39585)).toBe(false)
  })

  it('跨网格边界的建筑两个格子都能查到', () => {
    // 一栋横跨 ~150 m 的楼（网格 100 m）→ 落在中间格也必须判定为挡路。
    const collider = buildBuildingCollider(
      [{ geometry: { type: 'Polygon', coordinates: square(2.1652, 41.39585, 0.0018) } }],
      origin,
    )
    expect(collider.isBlocked(2.1668, 41.3965)).toBe(true)
  })
})
