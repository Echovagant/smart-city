import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const componentPath = resolve(__dirname, '../components/SmartCity.vue')
const source = readFileSync(componentPath, 'utf-8')

describe('SmartCity.vue feature wiring', () => {
  it('does not reference any .glb asset (primitives only)', () => {
    expect(source).not.toMatch(/uri:\s*['"]\/models\/[^'"]+\.glb['"]/)
  })

  it('uses Cesium primitives for traffic entities', () => {
    expect(source).toMatch(/box:\s*\{/)
    expect(source).toMatch(/cylinder:\s*\{/)
  })

  it('uses OpenStreetMap as the imagery provider', () => {
    expect(source).toMatch(/OpenStreetMapImageryProvider/)
    expect(source).not.toMatch(/defaultAccessToken\s*=\s*['"]['"]/)
  })

  it('uncomments the feature calls in onMounted', () => {
    // Plan 007 turned onMounted into async (it awaits loadAll from useCityData).
    const onMounted = source.match(/onMounted\(async\s*\(\)\s*=>\s*\{([\s\S]*?)\}\)/)
    expect(onMounted).not.toBeNull()
    const body = onMounted[1]
    expect(body).toMatch(/loadGeoJSONBuildings\(\)/)
    expect(body).toMatch(/loadGeoJSONRoads\(\)/)
    expect(body).toMatch(/createTrafficSystem\(\)/)
    expect(body).toMatch(/optimizePerformance\(\)/)
  })

  it('consumes data via the useCityData composable, not direct URL fetches', () => {
    expect(source).toMatch(/import\s*\{\s*useCityData\s*\}\s*from\s*['"]@\/composables\/useCityData['"]/)
    expect(source).not.toMatch(/Cesium\.GeoJsonDataSource\.load\(['"]\/api\//)
  })
})