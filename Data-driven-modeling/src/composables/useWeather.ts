/**
 * 天气效果层 —— 把城市当前天气渲染进 3D 场景。
 *
 * ## 数据从哪来
 *
 * 后端 `/api/city/overview` 的天气指标：
 * - `weather_temp`（气温 ℃）→ 决定是雨还是雪；
 * - `weather_humidity`（相对湿度 %）→ 决定雾的浓度；
 * - `extra.precipitation`（降水量 mm）→ 决定雨/雪强度；
 * - `extra.wind_speed_10m`（风速 m/s）→ 决定雨丝倾斜与飘落方向。
 *
 * **取不到就什么都不做**：不画雨、不压暗地面、不动雾 ✓
 * （没有来源的数字不画 —— 与项目里「取不到就 null，不拿 0 顶替」的口径一致 ✓）。
 *
 * ## 为什么用后处理而不是粒子系统
 *
 * - `ParticleSystem` 需要一张粒子贴图（外部资产）✗；
 * - 屏幕空间后处理用程序化噪声画雨丝，**零资产**✓，
 *   而且雨丝本来就是「贴在镜头上的」效果 ✓ —— 3A 游戏里的雨幕也是屏幕空间为主 ✓。
 *
 * ## 演示开关
 *
 * 真实天气驱动 + 一个手动开关（自动 / 雨 / 雪 / 雾）✓：
 * 巴塞罗那不一定下雨，做完看不到效果就没法验收 ✓；
 * 开关同时也方便汇报时演示 ✓。
 */
import * as Cesium from 'cesium'
import { reactive, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { CityOverview, Metric } from '../../types/city'

/** 天气演示模式。 */
export type WeatherMode = 'auto' | 'rain' | 'snow' | 'fog'

/** 场景里实际生效的天气强度（0~1）。 */
export interface WeatherEffect {
  /** 雨幕强度。 */
  rain: number
  /** 雪幕强度。 */
  snow: number
  /** 雾的额外浓度（0~1，叠加在深度雾之上）。 */
  fog: number
  /** 地面湿滑程度（0~1）：压暗地面 + 微微提亮边缘。 */
  wet: number
  /** 风速（m/s），影响雨丝倾角。 */
  wind: number
}

const emptyEffect = (): WeatherEffect => ({ rain: 0, snow: 0, fog: 0, wet: 0, wind: 0 })

/**
 * 雨雪后处理的着色器。
 *
 * 雨：三层不同速度的斜条纹（近快慢慢 → 有层次 ✓）；
 * 雪：慢速飘落的白点（带横向漂移 ✓）。
 * 全部程序化，**不需要任何贴图** ✓。
 */
export const WEATHER_SHADER = `
uniform sampler2D colorTexture;
uniform float rainAmount;
uniform float snowAmount;
uniform float windAmount;
uniform float time;

in vec2 v_textureCoordinates;

void main(void) {
  vec4 color = texture(colorTexture, v_textureCoordinates);
  vec2 uv = v_textureCoordinates;

  // 雨：三层斜条纹，速度不同 → 看起来有远近层次
  float rain = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float speed = 1.4 + fi * 0.8;
    vec2 p = uv * vec2(45.0 + fi * 30.0, 14.0 + fi * 8.0);
    p.x += (p.y + time * speed) * (0.22 + windAmount * 0.5);
    p.y -= time * speed * 2.2;
    float line = smoothstep(0.94, 1.0, abs(sin(p.x * 3.14159265)));
    rain += line * (0.4 - fi * 0.09);
  }
  rain = clamp(rain * rainAmount * 1.1, 0.0, 1.0);

  // 雪：慢速飘落的**小圆点**（不是方块 —— 格子 hash 直接画会出方块）
  vec2 sp = uv * 150.0;
  sp.y += time * 0.8;
  sp.x += sin(time * 0.9 + floor(sp.y) * 0.5) * 0.8;
  vec2 cell = floor(sp);
  vec2 local = fract(sp) - 0.5;
  float hash = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
  float flake = step(0.992, hash) * smoothstep(0.30, 0.04, length(local));
  float snow = flake * snowAmount * 2.4;

  // 下雨时整体压暗一点（云层挡光 ✓），并加一层冷色
  float wetness = clamp(rainAmount + snowAmount, 0.0, 1.0);
  color.rgb = mix(color.rgb, color.rgb * 0.86, wetness * 0.6);
  color.rgb += rain * vec3(0.62, 0.72, 0.85) * 0.5;
  color.rgb += snow * vec3(0.9, 0.94, 1.0);

  out_FragColor = color;
}
`

/** 从指标里取一个数字；取不到就 null（不拿 0 顶替）。 */
const numberOf = (metric: Metric | undefined, key: string): number | null => {
  if (!metric) return null
  const raw = key in (metric.extra ?? {}) ? (metric.extra as Record<string, unknown>)[key] : undefined
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) ? value : null
}

/**
 * 从城市概览里解析出天气强度。
 *
 * 口径：
 * - 有降水且气温 ≤ 1 ℃ → 雪；否则 → 雨 ✓；
 * - 降水量 0.1 mm ≈ 弱雨，10 mm ≈ 大雨（线性映射到 0~1）✓；
 * - 湿度 ≥ 85% → 有雾/霾 ✓（湿度高本身也让深度雾变浓 ✓）。
 */
export const parseWeatherEffect = (overview: CityOverview | null): WeatherEffect => {
  if (!overview) return emptyEffect()
  const metrics = overview.metrics ?? []
  const temp = metrics.find(metric => metric.key === 'weather_temp')
  const humidity = metrics.find(metric => metric.key === 'weather_humidity')
  const temperature = typeof temp?.value === 'number' ? temp.value : null
  const relativeHumidity = typeof humidity?.value === 'number' ? humidity.value : null
  const precipitation = numberOf(temp, 'precipitation') ?? numberOf(humidity, 'precipitation')
  const wind = numberOf(temp, 'wind_speed_10m') ?? numberOf(humidity, 'wind_speed_10m')
  if (precipitation === null && relativeHumidity === null) return emptyEffect()

  // 雨雪互斥：气温 ≤ 1℃ 且有降水 → 下雪，否则下雨。
  const isSnow = precipitation !== null && precipitation > 0 && temperature !== null && temperature <= 1
  const rain = isSnow || precipitation === null ? 0 : Math.min(1, precipitation / 10)
  const snow = isSnow ? Math.min(1, (precipitation ?? 0) / 4) : 0
  const fog = relativeHumidity === null ? 0 : Math.min(1, Math.max(0, (relativeHumidity - 75) / 25))
  const wet = precipitation === null ? 0 : Math.min(1, precipitation / 3)
  return { rain, snow, fog, wet, wind: wind ?? 0 }
}

/** 演示模式下的效果（覆盖真实天气）。 */
const effectOfMode = (mode: WeatherMode): WeatherEffect => {
  switch (mode) {
    case 'rain':
      return { rain: 0.55, snow: 0, fog: 0.15, wet: 0.9, wind: 6 }
    case 'snow':
      return { rain: 0, snow: 0.6, fog: 0.2, wet: 0.4, wind: 3 }
    case 'fog':
      return { rain: 0, snow: 0, fog: 0.85, wet: 0.3, wind: 1 }
    default:
      return emptyEffect()
  }
}

export interface WeatherOptions {
  /** Cesium 视图。 */
  viewer: Ref<Cesium.Viewer | null>
  /** 城市概览（天气数据从这儿来）。 */
  overview: Ref<CityOverview | null>
  /**
   * 取深度雾阶段（天气要联动它）。
   *
   * 用**回调**而不是 Ref：雾阶段是 Cesium 对象（不能被 Vue 代理），
   * 而且它是在 `initCesium` 里才建出来的 ✓ —— 回调每次现取 ✓。
   */
  getFogStage: () => Cesium.PostProcessStage | null
  /** 取深度雾的基础强度（天气在此之上叠加）。 */
  getFogBaseStrength: () => number
}

/** 天气层对外的东西。 */
export interface WeatherLayer {
  /** 当前模式（演示开关）。 */
  mode: WeatherMode
  /** 切换模式：自动 → 雨 → 雪 → 雾 → 自动。 */
  cycleMode: () => void
  /** 当前生效的效果。 */
  effect: WeatherEffect
  /** 阶段（测试用）。 */
  stage: Cesium.PostProcessStage | null
}

export function useWeather({ viewer, overview, getFogStage, getFogBaseStrength }: WeatherOptions): WeatherLayer {
  const mode = ref<WeatherMode>('auto')
  const effect = reactive<WeatherEffect>(emptyEffect())
  const stage = ref<Cesium.PostProcessStage | null>(null)

  const buildStage = (): Cesium.PostProcessStage =>
    new Cesium.PostProcessStage({
      name: 'smart-city-weather',
      fragmentShader: WEATHER_SHADER,
      uniforms: {
        rainAmount: 0,
        snowAmount: 0,
        windAmount: 0,
        time: 0,
      },
    })

  const applyEffect = (next: WeatherEffect) => {
    Object.assign(effect, next)
    const active = stage.value
    if (!active) return
    const uniforms = active.uniforms
    uniforms.rainAmount = next.rain
    uniforms.snowAmount = next.snow
    uniforms.windAmount = Math.min(1, next.wind / 12)
    // 雾与天气联动：湿度/降水高 → 深度雾更浓。
    const fog = getFogStage()
    if (fog) {
      fog.uniforms.fogStrength = Math.min(1, getFogBaseStrength() * (1 + next.fog * 0.8))
    }
  }

  const refresh = () => {
    const next =
      mode.value === 'auto' ? parseWeatherEffect(overview.value ?? null) : effectOfMode(mode.value)
    applyEffect(next)
  }

  // 阶段：viewer 起来之后建一次。
  watch(
    viewer,
    activeViewer => {
      if (!activeViewer) return
      if (!stage.value) {
        const created = buildStage()
        stage.value = created
        activeViewer.scene.postProcessStages.add(created)
      }
      refresh()
    },
    { immediate: true },
  )

  // 真实天气数据到位后重算。
  watch(overview, refresh)

  // 主题换色后雾的基准强度会变 → 重算。
  watch(getFogBaseStrength, refresh)

  // 每帧推进雨雪的相位（雨在动 ✓）。
  // 挂在场景的 preRender 上：跟着 viewer 一起生灭，不用自己开一个 RAF 循环。
  watch(
    viewer,
    activeViewer => {
      if (!activeViewer) return
      const advance = () => {
        if (stage.value) {
          stage.value.uniforms.time = (Number(stage.value.uniforms.time) + 0.016) % 1000
        }
      }
      activeViewer.scene.preRender.addEventListener(advance)
    },
    { immediate: true },
  )

  return reactive({
    mode,
    cycleMode: () => {
      const order: WeatherMode[] = ['auto', 'rain', 'snow', 'fog']
      const index = order.indexOf(mode.value)
      mode.value = order[(index + 1) % order.length]
      refresh()
    },
    effect,
    stage,
  })
}
