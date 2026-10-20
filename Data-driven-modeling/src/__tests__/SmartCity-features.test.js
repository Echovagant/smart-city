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

  it('configures a non-Ion imagery provider', () => {
    // 国内网络环境下 OSM 经常被墙;我们用高德 UrlTemplateImageryProvider。
    // 关键:必须提前把 UrlTemplateImageryProvider 包成 ImageryLayer 实例,然后
    // 传给 Viewer 的 baseLayer 选项,这样 Cesium 1.134 Viewer 构造逻辑才会
    // 透传给 CesiumWidget,CesiumWidget 直接 add 而不走 fromWorldImagery()。
    // 关键不变:绝不手动设置 Ion.defaultAccessToken = '' 这种空字符串赋值。
    expect(source).toMatch(/new\s+Cesium\.ImageryLayer\(/)
    expect(source).toMatch(/UrlTemplateImageryProvider/)
    expect(source).not.toMatch(/defaultAccessToken\s*=\s*['"]['"]/)
    // 截取 new Cesium.Viewer 的 options block,断言其中显式禁用了两个会触发 ion 的选项。
    const optionsBlock = source.match(/new\s+Cesium\.Viewer\(\s*cesiumContainer\.value\s*,\s*\{([\s\S]*?)\}\)/)
    expect(optionsBlock).not.toBeNull()
    // baseLayerPicker 不禁用 → 默认构造 BaseLayerPickerViewModel,
    // 其构造末尾 this.selectedImagery = n[0] 触发 Bing Maps Aerial 的
    // creationCommand → createWorldImageryAsync → IonImageryProvider.fromAssetId(2)
    // → api.cesium.com 401
    expect(optionsBlock[1]).toMatch(/baseLayerPicker:\s*false/)
    // geocoder 不禁用 → 默认构造 GeocoderViewModel,geocoderServices 为空时
    // 自动 new IonGeocoderService → 同样触发 ion 401
    expect(optionsBlock[1]).toMatch(/geocoder:\s*false/)
    // baseLayer 不显式设为 false → CesiumWidget 拿到 undefined →
    // 走 fromWorldImagery() → fromAssetId(2) → 又触发 ion 401
    expect(optionsBlock[1]).toMatch(/baseLayer:\s*false/)
    // 高德 ImageryLayer 是在 Viewer 构造后显式 add,不是通过 baseLayer 选项
    expect(source).toMatch(/imageryLayers\.add\(gaodeLayer\)/)
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