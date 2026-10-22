import { describe, it, expect } from 'vitest'

import { resolveFocusBuildingIds, resolveSceneLinkage } from '../useSceneLinkage'
import type { FacilityCategory, SourceInfo } from '../../../types/city'

/**
 * 页签 → 场景联动的**行为断言**（纯函数）。
 *
 * 关键契约：焦点建筑集合来自**后端** `facilities[].members`，
 * 前端不重新实现分类规则。
 */

const SOURCE: SourceInfo = {
  name: 'OpenStreetMap 本地快照',
  url: 'backend-python/geojson/buildings.geojson',
  observed_at: '2026-06-21T11:37:06Z',
  fetched_at: '2026-10-22T04:30:00Z',
  realtime: false,
  estimated: false,
}

const category = (key: string, members: string[]): FacilityCategory => ({
  key,
  label: key,
  count: members.length,
  criteria: [],
  members,
  source: SOURCE,
})

describe('resolveSceneLinkage', () => {
  it('does nothing on the overview tab', () => {
    const linkage = resolveSceneLinkage('overview')
    expect(linkage.focusFacilityKeys).toEqual([])
    expect(linkage.dimBuildings).toBe(false)
    expect(linkage.brightenFlow).toBe(false)
    expect(linkage.note).toBeNull()
  })

  it('explains that air quality has no spatial position', () => {
    const linkage = resolveSceneLinkage('air')
    expect(linkage.focusFacilityKeys).toEqual([])
    expect(linkage.dimBuildings).toBe(false)
    expect(linkage.note).toContain('无空间定位')
  })

  it('highlights public safety and medical and dims the rest', () => {
    const linkage = resolveSceneLinkage('public_safety')
    expect(linkage.focusFacilityKeys).toEqual(['public_safety', 'medical'])
    expect(linkage.dimBuildings).toBe(true)
    expect(linkage.brightenFlow).toBe(false)
  })

  it('highlights heritage and dims the rest', () => {
    const linkage = resolveSceneLinkage('heritage')
    expect(linkage.focusFacilityKeys).toEqual(['heritage'])
    expect(linkage.dimBuildings).toBe(true)
  })

  it('brightens the flow layer without dimming the buildings', () => {
    const linkage = resolveSceneLinkage('network')
    expect(linkage.focusFacilityKeys).toEqual([])
    expect(linkage.dimBuildings).toBe(false)
    expect(linkage.brightenFlow).toBe(true)
  })

  it('does nothing for an unknown tab', () => {
    const linkage = resolveSceneLinkage('不存在的页签')
    expect(linkage.focusFacilityKeys).toEqual([])
    expect(linkage.dimBuildings).toBe(false)
    expect(linkage.brightenFlow).toBe(false)
  })
})

describe('resolveFocusBuildingIds', () => {
  const facilities = [
    category('medical', ['relation/1', 'relation/2']),
    category('public_safety', ['relation/3']),
    category('heritage', ['relation/4']),
  ]

  it('collects the member ids of the focused categories', () => {
    const ids = resolveFocusBuildingIds(facilities, ['public_safety', 'medical'])
    expect(Array.from(ids).sort()).toEqual([
      'relation/1',
      'relation/2',
      'relation/3',
    ])
  })

  it('takes only the requested category', () => {
    const ids = resolveFocusBuildingIds(facilities, ['heritage'])
    expect(Array.from(ids)).toEqual(['relation/4'])
  })

  it('is empty when nothing is focused or there are no facilities', () => {
    expect(resolveFocusBuildingIds(facilities, []).size).toBe(0)
    expect(resolveFocusBuildingIds([], ['heritage']).size).toBe(0)
    expect(resolveFocusBuildingIds(null, ['heritage']).size).toBe(0)
  })

  it('ignores categories without members', () => {
    const ids = resolveFocusBuildingIds([category('commerce', [])], ['commerce'])
    expect(ids.size).toBe(0)
  })
})
