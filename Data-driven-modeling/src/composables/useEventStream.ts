import type { CityEvent, CityOverview, EventLocation, LngLat, Metric, Series } from '../../types/city'

/**
 * 事件流的前端辅助（**纯函数**，不碰 Vue 响应式，好测）。
 *
 * 三件事：
 * 1. **去重**：事件 id 是稳定的（后端保证），轮询拿到同一批事件时按 id 去重；
 * 2. **空态解释**：事件为空时说清楚「检查了哪些条件、为什么没触发」——
 *    这比编三条假事件有信息量得多；
 * 3. **时间显示**：时间戳是 UTC，界面要显示**本地时间**。
 *
 * > **阈值是从后端规则镜像过来的**（后端 `city_data/events.py` 是唯一事实来源）。
 * > 这里只用来**解释**为什么没有事件，不参与判定「有没有事件」——
 * > 事件的有无完全由后端给的 `events` 数组决定。
 */

/**
 * 事件派生规则的阈值（与后端 `city_data/events.py` 一一对应）。
 *
 * 只用于生成空态解释文案，**不参与事件判定**。
 */
export const EVENT_RULE_THRESHOLDS = {
  /** 规则 2：当前 AQI 等级达到这个数才出事件（3 = 轻度污染）。 */
  aqiAlertLevel: 3,
  /** 规则 3：路网负载指数的告警阈值。 */
  roadLoadAlert: 80,
  /** 规则 4：低温线（℃）。 */
  weatherLow: 0,
  /** 规则 4：高温线（℃）。 */
  weatherHigh: 35,
} as const

/** AQI 分级带（上界含端点）：与后端、cnemc 的 `AqiLevel` 一致。 */
const AQI_LEVEL_BANDS: Array<{ upper: number; grade: number; label: string }> = [
  { upper: 50, grade: 1, label: '优' },
  { upper: 100, grade: 2, label: '良' },
  { upper: 150, grade: 3, label: '轻度污染' },
  { upper: 200, grade: 4, label: '中度污染' },
  { upper: 300, grade: 5, label: '重度污染' },
  { upper: Infinity, grade: 6, label: '严重污染' },
]

/** AQI 数值 → 分级。取不到（null / 非数字 / 负数）返回 null。 */
export const aqiGradeOf = (
  value: unknown,
): { grade: number; label: string } | null => {
  if (value === null || value === undefined || typeof value === 'boolean') return null
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return null
  const band = AQI_LEVEL_BANDS.find(item => number <= item.upper)
  return band ? { grade: band.grade, label: band.label } : null
}

/** 按 key 找指标。找不到返回 undefined。 */
const metricOf = (overview: CityOverview | null, key: string): Metric | undefined =>
  overview?.metrics?.find(metric => metric && metric.key === key)

/** 按 key 找序列。找不到返回 undefined。 */
const seriesOf = (overview: CityOverview | null, key: string): Series | undefined =>
  overview?.series?.find(item => item && item.key === key)

/** 指标值 → 有限数字。取不到（降级占位是 null）返回 null。 */
const numberOf = (metric: Metric | undefined): number | null => {
  if (!metric) return null
  const value = metric.value
  if (value === null || value === undefined || typeof value === 'boolean') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * 事件按 id 去重，新的在前。
 *
 * 事件的 id 是**稳定**的（后端保证），所以轮询拿到同一批事件时
 * 不会在列表里越积越多。
 */
export const dedupeEvents = (events: CityEvent[] | null | undefined): CityEvent[] => {
  if (!Array.isArray(events)) return []
  const seen = new Set<string>()
  const unique: CityEvent[] = []
  for (const event of events) {
    if (!event || typeof event.id !== 'string' || !event.id) continue
    if (seen.has(event.id)) continue
    seen.add(event.id)
    unique.push(event)
  }
  const timeOf = (event: CityEvent) => (typeof event.time === 'string' ? event.time : '')
  // 时间倒序（新的在前）；没有时间的排在后面
  return unique.sort((a, b) => {
    const left = timeOf(b)
    const right = timeOf(a)
    if (left === right) return 0
    return left > right ? 1 : -1
  })
}

/**
 * 时间戳 → 本地 HH:MM。
 *
 * 自己按 `getHours()/getMinutes()` 拼，**不用 `toLocaleTimeString`** ——
 * 后者受运行环境的 ICU 数据影响，输出格式不保证一致。
 */
export const formatEventTime = (value?: string | null): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

/**
 * 事件位置 → 实际落点。
 *
 * 两类事件，**全项目只有一个城心**（天安门 = `cityConfig.center`，也是相机的绕行中心）：
 *
 * - **全市级**（`location_kind === 'city'`：空气质量、天气）——
 *   全市指标**没有空间位置**，落在城心是准确的；
 *   而且城心就是相机盯着的那一点，所以默认鸟瞰视角下标记**永远在屏幕中心**。
 * - **几何锚定**（`location_kind === 'geometry'`：路网负载）——
 *   位置是**真实几何**上的点（最长主干道的弧长中点），原样使用，不拿城心替换。
 *
 * 缺省（没有 `location_kind`）按 `'geometry'` 处理 —— 沿用 `location` 原坐标。
 */
export const resolveEventLocation = (
  event: CityEvent,
  cityCenter: LngLat,
): EventLocation | undefined => {
  const kind = event.location_kind ?? 'geometry'
  if (kind === 'city') {
    return {
      lng: cityCenter.lng,
      lat: cityCenter.lat,
      label: CITY_EVENT_LOCATION_LABEL,
    }
  }
  return event.location
}

/** 全市级事件的位置标签（城心 = 天安门）。 */
export const CITY_EVENT_LOCATION_LABEL = '城心（全市指标）'

/**
 * 空态解释：说清楚「检查了哪些条件、为什么没触发」。
 *
 * 例：「当前无触发事件 —— 最近 24 小时 AQI 等级未变化（当前「良」）；
 * 路网负载 63.5 低于阈值 80」。
 *
 * 只陈述**事实**：某个条件成立时就不提它（那样会与「没有事件」自相矛盾）。
 */
export const explainEmptyEvents = (overview: CityOverview | null): string => {
  if (!overview) return '正在获取事件数据…'
  const reasons: string[] = []

  // 规则 1：AQI 等级变化
  const series = seriesOf(overview, 'aqi_24h')
  if (!series || !Array.isArray(series.points) || series.points.length === 0) {
    reasons.push('24 小时 AQI 序列暂不可用，无法判定等级变化')
  } else {
    const grades = series.points
      .map(point => aqiGradeOf(point?.v))
      .filter((item): item is { grade: number; label: string } => item !== null)
    if (grades.length === 0) {
      reasons.push('24 小时 AQI 序列没有可用数据点')
    } else {
      const changed = grades.some(
        (item, index) => index > 0 && item.grade !== grades[index - 1]!.grade,
      )
      if (!changed) {
        const last = grades[grades.length - 1]!
        reasons.push(`最近 24 小时 AQI 等级未变化（当前「${last.label}」）`)
      }
    }
  }

  // 规则 2：当前 AQI 等级
  const aqi = metricOf(overview, 'aqi')
  const aqiValue = numberOf(aqi)
  if (aqiValue === null) {
    reasons.push('空气质量源暂不可用')
  } else {
    const grade = aqi?.level ?? aqiGradeOf(aqiValue)?.grade ?? null
    if (grade !== null && grade < EVENT_RULE_THRESHOLDS.aqiAlertLevel) {
      const label = aqi?.level_label ?? aqiGradeOf(aqiValue)?.label ?? String(grade)
      reasons.push(`当前 AQI 等级「${label}」低于告警线 ${EVENT_RULE_THRESHOLDS.aqiAlertLevel}`)
    }
  }

  // 规则 3：路网负载
  const load = metricOf(overview, 'road_load_index')
  const loadValue = numberOf(load)
  if (loadValue === null) {
    reasons.push('路网负载数据暂不可用')
  } else if (loadValue < EVENT_RULE_THRESHOLDS.roadLoadAlert) {
    reasons.push(`路网负载 ${loadValue} 低于阈值 ${EVENT_RULE_THRESHOLDS.roadLoadAlert}`)
  }

  // 规则 4：极端天气
  const temperature = metricOf(overview, 'weather_temp')
  const temperatureValue = numberOf(temperature)
  if (temperatureValue === null) {
    reasons.push('天气源暂不可用')
  } else if (
    temperatureValue > EVENT_RULE_THRESHOLDS.weatherLow &&
    temperatureValue < EVENT_RULE_THRESHOLDS.weatherHigh
  ) {
    reasons.push(
      `气温 ${temperatureValue}${temperature?.unit ?? '℃'} 在正常区间（${EVENT_RULE_THRESHOLDS.weatherLow}~${EVENT_RULE_THRESHOLDS.weatherHigh}℃）`,
    )
  }

  if (reasons.length === 0) return '当前无触发事件'
  return `当前无触发事件 —— ${reasons.join('；')}`
}
