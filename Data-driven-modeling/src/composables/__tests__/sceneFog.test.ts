import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('cesium', async () => {
  const { createCesiumStub } = await import('./cesiumStub')
  return createCesiumStub()
})

import { CLAY, DEEP_SPACE } from '@/theme/themes'
import { applyFogTheme, createDepthFogStage, DEPTH_FOG_STAGE_NAME } from '../sceneFog'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('sceneFog —— 深度雾后处理阶段', () => {
  it('阶段的 uniform 直接取自主题（颜色=底色，near/far/falloff/强度）', () => {
    const stage = createDepthFogStage(CLAY)
    expect(stage.name).toBe(DEPTH_FOG_STAGE_NAME)
    const uniforms = stage.uniforms as unknown as Record<string, unknown>
    // 雾色 = 大屏底色：远景要沉进**底色**（白雾会把画面洗灰）。
    expect((uniforms.fogColor as { name?: string }).name).toBe(CLAY.palette.screen)
    expect(uniforms.fogNear).toBe(CLAY.fog.near)
    expect(uniforms.fogFar).toBe(CLAY.fog.far)
    expect(uniforms.fogFalloff).toBe(CLAY.fog.falloff)
    expect(uniforms.fogStrength).toBe(CLAY.fog.strength)
  })

  it('换主题只改 uniform 的值，不重建阶段', () => {
    const stage = createDepthFogStage(CLAY)
    const before = stage.uniforms
    applyFogTheme(stage, DEEP_SPACE)
    const after = stage.uniforms as unknown as Record<string, unknown>
    // 同一个 uniform 对象被就地改写 —— 重建阶段会丢掉已编译的着色器程序。
    expect(stage.uniforms).toBe(before)
    expect((after.fogColor as { name?: string }).name).toBe(DEEP_SPACE.palette.screen)
    expect(after.fogStrength).toBe(DEEP_SPACE.fog.strength)
  })

  it('阶段为 null 时不报错（场景还没建好就换主题的情况）', () => {
    expect(() => applyFogTheme(null, DEEP_SPACE)).not.toThrow()
  })

  it('着色器声明了深度纹理与雾色（缺一个 Cesium 就不会自动绑定深度）', () => {
    const stage = createDepthFogStage(CLAY)
    expect(stage.fragmentShader).toContain('uniform sampler2D depthTexture;')
    expect(stage.fragmentShader).toContain('uniform sampler2D colorTexture;')
    expect(stage.fragmentShader).toContain('uniform vec3 fogColor;')
    // 天空（没有地面）不参与雾
    expect(stage.fragmentShader).toContain('czm_readDepth')
  })
})
