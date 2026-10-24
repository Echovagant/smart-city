/**
 * 深度雾 —— 让远景融进底色。
 *
 * ## 为什么**不**用 `scene.fog`
 *
 * Cesium 1.134 的 `scene.fog` 在本项目里是**无效的**，有三条硬理由（都是实测 + 读源码）：
 *
 * 1. **它只作用于地形瓦片**。`czm_fog` 只出现在 `GlobeFS` 与 3D Tiles 的
 *    `AtmosphereStageFS` 里；我们的建筑与道路走 `MaterialAppearanceFS`，
 *    那段着色器**一行雾都没有** —— 实体不吃雾。
 * 2. **它的密度是物理量，小到等于零**。`Fog.update` 里
 *    `density = density × heightScalar × (相机高度 / maxHeight)^-heightFalloff × (1 - |dot(视线, 径向)|)`。
 *    1500 m 高度、45° 俯角下有效密度约 **2.4e-6**；`czm_fog` 在 3 km 处算出来的雾量
 *    不到 **万分之一** —— 数学上就是「没有」。
 * 3. **它的颜色不可设**（绑在大气上），而本项目刻意关掉了大气
 *    （`skyAtmosphere.show = false`）。Cesium 1.134 的 `Fog` 也没有 `color` 属性。
 *
 * 顺带说一句：`Fog` **没有** `near` / `far` 这两个属性。写了也只是往对象上挂两个
 * 没人读的属性 —— 类型上凑巧能过（项目自己补过 Cesium 类型缺口），运行时完全被忽略。
 *
 * ## 那用什么
 *
 * **后处理**：`PostProcessStage` + 深度纹理。这条通道是 Cesium 官方
 * `DepthOfField` / `EdgeDetection` / `AmbientOcclusion` 用的同一条 ——
 * `PostProcessStage` 检测到着色器里声明了 `uniform sampler2D depthTexture`，
 * 就自动把深度纹理喂进来（`PostProcessStage.js` 里的 `depthTextureRegex`）。
 *
 * 深度纹理里是**地面**的深度。我们的建筑站在地面上，所以某栋楼所在像素的深度
 * 就是它脚下的地面深度 —— 这正好是「空气透视」要的距离尺度：
 * 越远的街区，雾越浓，自然就沉进背景。
 *
 * 雾色取**底色**（`palette.screen`），远景融进背景而不是融进白色 ——
 * 白雾会把整片远景洗成灰白，对比度被吃掉。
 *
 * ## 降级
 *
 * 深度纹理需要 `WEBGL_depth_texture` 扩展。没有的话 `PostProcessStage.ready`
 * 一直是 false，这个阶段**不会被渲染** —— 画面退回到「没有雾」，不会崩、不会黑屏。
 */
import * as Cesium from 'cesium'
import type { ThemeDefinition } from '@/theme/themes/types'
import { cssColor } from '@/theme/dark'

/** 后处理阶段的内部名字（Cesium 用它做调试与去重）。 */
export const DEPTH_FOG_STAGE_NAME = 'smart-city-depth-fog'

/**
 * 深度雾的片元着色器。
 *
 * 写法照抄 Cesium 官方 `DepthOfField`（`Shaders/PostProcessStages/DepthOfField.js`）：
 * `czm_readDepth` 取深度 → `czm_inverseProjection` 反投影到相机空间 → 取 `-z` 当距离。
 * `czm_readDepth` 内部已经做过 `czm_reverseLogDepth`，对数深度缓冲下也是对的。
 *
 * ## 为什么是「上升 + 回落」两段
 *
 * 深度纹理里**地面**的深度是偏大的：地面是椭球体的大瓦片，深度在瓦片上按屏幕空间
 * 线性插值，插不准 —— 实测地面落在 4.7~5.7 km，而建筑只有 2.75~3.5 km。
 *
 * 后果是：**吃不到自己深度的东西**（底座网格、流动光效层、事件光柱 ——
 * 它们要么太细、要么根本不在深度纹理里）都会读到「地面那一档」的远距离，
 * 于是被雾整片糊掉（实测：底座网格直接消失）。
 *
 * 所以雾只在**城区那一档距离**上生效：near → far 逐渐起雾，
 * far → far + falloff 逐渐退雾。建筑拿到梯度，网格与路网保持原样。
 */
export const DEPTH_FOG_FRAGMENT_SHADER = `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
uniform float fogFalloff;
uniform float fogStrength;

in vec2 v_textureCoordinates;

void main(void) {
  vec4 color = texture(colorTexture, v_textureCoordinates);

  // 深度 1.0 = 这一像素没有地面（天空 / 背景），不参与雾。
  float depth = czm_readDepth(depthTexture, v_textureCoordinates);
  if (depth >= 1.0) {
    out_FragColor = color;
    return;
  }

  // 屏幕坐标 → 相机空间（与 Cesium 官方 DoF 的 toEye() 同一个算法）。
  vec2 ndc = vec2(
    v_textureCoordinates.x * 2.0 - 1.0,
    (1.0 - v_textureCoordinates.y) * 2.0 - 1.0
  );
  vec4 eye = czm_inverseProjection * vec4(ndc, depth, 1.0);
  eye = eye / eye.w;
  float distanceToCamera = -eye.z;

  // 上升段：near → far 逐渐起雾。
  float rise = clamp((distanceToCamera - fogNear) / max(fogFar - fogNear, 1.0), 0.0, 1.0);
  rise = rise * rise * (3.0 - 2.0 * rise);

  // 回落段：far → far + falloff 逐渐退雾（保住网格 / 路网 / 事件光柱）。
  float fall = 1.0 - clamp((distanceToCamera - fogFar) / max(fogFalloff, 1.0), 0.0, 1.0);
  fall = fall * fall * (3.0 - 2.0 * fall);

  float fog = rise * fall * fogStrength;

  out_FragColor = mix(color, vec4(fogColor, color.a), fog);
}
`

/**
 * 造一个深度雾后处理阶段。
 *
 * 阶段的 uniform 是**活对象**：改 `stage.uniforms.fogColor` 等值就生效，
 * 不需要重建阶段（重建会让整帧重来一遍）。
 */
export const createDepthFogStage = (theme: ThemeDefinition): Cesium.PostProcessStage => {
  const stage = new Cesium.PostProcessStage({
    name: DEPTH_FOG_STAGE_NAME,
    fragmentShader: DEPTH_FOG_FRAGMENT_SHADER,
    uniforms: {
      fogColor: cssColor(theme.palette.screen),
      fogNear: theme.fog.near,
      fogFar: theme.fog.far,
      fogFalloff: theme.fog.falloff,
      fogStrength: theme.fog.strength,
    },
  })
  return stage
}

/**
 * 把主题的雾参数写进阶段。
 *
 * 只改 uniform 的值 —— **不重建阶段**（重建会丢掉 Cesium 已经编译好的着色器程序，
 * 换主题时卡一下）。
 */
export const applyFogTheme = (
  stage: Cesium.PostProcessStage | null,
  theme: ThemeDefinition,
): void => {
  if (!stage) return
  stage.uniforms.fogColor = cssColor(theme.palette.screen)
  stage.uniforms.fogNear = theme.fog.near
  stage.uniforms.fogFar = theme.fog.far
  stage.uniforms.fogFalloff = theme.fog.falloff
  stage.uniforms.fogStrength = theme.fog.strength
}
