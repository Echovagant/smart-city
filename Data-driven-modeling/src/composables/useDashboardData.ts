import type {
  CityOverview,
  DashboardBar,
  DashboardLineMetric,
  DashboardMetricCard,
  DashboardSlice,
  DashboardTab,
  DashboardTone,
  FacilityCategory,
  Metric,
  Series,
  SeriesPoint,
  SourceInfo,
  TabView,
} from '../../types/city'

/**
 * 大屏的数据模型层。
 *
 * 核心是**纯函数** `resolveTabView(tab, overview)`：
 * 输入输出都是普通数据，**不碰 Vue 响应式**（所以好测）。
 *
 * 四条不可让步的规则
 * ------------------
 * 1. **每个数字都要能追到来源**：卡片带 `source`（来源名 + 观测时间 + 取数时间）。
 * 2. **取不到就写 `null`**：`value: null` + `unavailable: true`，
 *    界面显示「数据源暂不可用」—— 不用 0、也不用上一次的旧值冒充。
 * 3. **模型估算必须标出来**：`source.estimated === true` → 卡片显示「（模型估算）」。
 * 4. **实时性照实说**：`source.realtime === false` → 界面标「（非实时）」。
 *
 * 页签切换 = **换「看哪一组指标 / 哪一类分布」，不是换图表类型**：
 * 每个页签的每个数字都来自 `/api/city/overview` 的真实字段。
 */

/** 道路分级指标（键 → 中文名）。与后端 `road_network` 的分级表同口径。 */
const ROAD_TIER_METRICS: Array<{ key: string; label: string }> = [
  { key: 'road_count_main', label: '主干道' },
  { key: 'road_count_secondary', label: '次干道' },
  { key: 'road_count_local', label: '支路' },
  { key: 'road_count_footway', label: '人行道/步行区' },
  { key: 'road_count_other', label: '其他道路' },
]

/** 污染物指标（键 → 中文名）。 */
const POLLUTANT_METRICS: Array<{ key: string; label: string }> = [
  { key: 'pm25', label: 'PM2.5' },
  { key: 'pm10', label: 'PM10' },
  { key: 'o3', label: 'O3' },
  { key: 'no2', label: 'NO2' },
  { key: 'so2', label: 'SO2' },
  { key: 'co', label: 'CO' },
]

/**
 * CO 的单位是 mg/m³，其余污染物是 μg/m³（上游给的是 μg/m³，这里换算成 mg/m³）。
 * 环形图要比较各污染物的相对浓度，必须先统一到 μg/m³ 才能相加。
 */
const POLLUTANT_UNIT_SCALE: Record<string, number> = { co: 1000 }

/**
 * 逐日趋势里可切换的指标（键 → 中文名 / 单位）。
 *
 * 键与后端逐日序列的点里 `values` 的键**完全一致**，
 * 也与逐小时污染物的指标 key 一致（`pm25` / `pm10` / …）——
 * 前端不重新实现任何分类规则，只是把后端给的键翻译成能显示的名字。
 */
const DAILY_TREND_METRICS: DashboardLineMetric[] = [
  { key: 'aqi', label: 'AQI', unit: 'AQI' },
  { key: 'pm25', label: 'PM2.5', unit: 'μg/m³' },
  { key: 'pm10', label: 'PM10', unit: 'μg/m³' },
  { key: 'o3', label: 'O3', unit: 'μg/m³' },
  { key: 'no2', label: 'NO2', unit: 'μg/m³' },
  { key: 'so2', label: 'SO2', unit: 'μg/m³' },
  { key: 'co', label: 'CO', unit: 'mg/m³' },
]

/**
 * 设施分类的**兜底标题**。
 *
 * 注意：这不是分类**规则** —— 规则（哪个 OSM 标签归哪一类）只写在后端
 * `city_data/sources/facilities.py`，前端不判定任何标签。
 * 这里只是「后端没给数据时，卡片还得有个标题」的兜底文案；
 * 后端给了分类名时一律用后端的。
 */
const FACILITY_FALLBACK_LABELS: Record<string, string> = {
  medical: '医疗设施',
  public_safety: '公共安全设施',
  education: '教育设施',
  heritage: '历史建筑',
  commerce: '商业与办公',
}

/** 取数上下文：把 `CityOverview` 摊成几个便于查询的索引。 */
interface ResolveContext {
  metrics: Map<string, Metric>
  facilities: FacilityCategory[]
  series: Map<string, Series>
}

function buildContext(overview: CityOverview | null): ResolveContext {
  const metrics = new Map<string, Metric>()
  const series = new Map<string, Series>()
  const facilities: FacilityCategory[] = []
  if (overview) {
    const metricList = Array.isArray(overview.metrics) ? overview.metrics : []
    metricList.forEach(metric => {
      if (metric && typeof metric.key === 'string') metrics.set(metric.key, metric)
    })
    const seriesList = Array.isArray(overview.series) ? overview.series : []
    seriesList.forEach(item => {
      if (item && typeof item.key === 'string') series.set(item.key, item)
    })
    const facilityList = Array.isArray(overview.facilities) ? overview.facilities : []
    facilityList.forEach(item => {
      if (item && typeof item.key === 'string') facilities.push(item)
    })
  }
  return { metrics, facilities, series }
}

/** 指标值 → 数字。取不到（null / undefined / 非有限数）返回 null。 */
function numericValue(metric: Metric | undefined): number | null {
  if (!metric) return null
  const value = metric.value
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/** 空气质量等级 → 色调：优/良是常态，污染开始是预警，严重是告警。 */
function toneOfLevel(level: number | null | undefined): DashboardTone {
  if (level === null || level === undefined) return 'accent'
  if (level <= 2) return 'ok'
  if (level === 3) return 'warn'
  return 'alert'
}

/** 造一张指标卡。`value` 为 null 表示「这个源没取到」。 */
function cardFromValue(
  key: string,
  label: string,
  value: number | string | null,
  source: SourceInfo | null,
  options: { unit?: string; badge?: string | null; tone?: DashboardTone } = {},
): DashboardMetricCard {
  const unavailable = value === null || value === undefined
  return {
    key,
    label,
    value: unavailable ? null : value,
    unit: options.unit,
    badge: options.badge ?? null,
    tone: options.tone ?? 'accent',
    source,
    estimated: source?.estimated === true,
    unavailable,
  }
}

/** 用一个指标造卡：值、单位、分级徽标、来源都取自指标本身。 */
function cardFromMetric(
  key: string,
  label: string,
  metric: Metric | undefined,
  options: { labelOverride?: string } = {},
): DashboardMetricCard {
  const raw = metric?.value
  const unavailable = !metric || raw === null || raw === undefined || raw === ''
  const value: number | string | null = unavailable
    ? null
    : typeof raw === 'number'
      ? raw
      : String(raw)
  return cardFromValue(key, options.labelOverride ?? label, value, metric?.source ?? null, {
    unit: metric?.unit,
    // 没取到数据就不知道分级 —— 不显示上一档的「良」。
    badge: unavailable ? null : (metric?.level_label ?? null),
    tone: unavailable ? 'accent' : toneOfLevel(metric?.level),
  })
}

/** 用一个设施分类造卡（分类计数来自后端）。 */
function facilityCard(ctx: ResolveContext, key: string): DashboardMetricCard {
  const category = ctx.facilities.find(item => item.key === key)
  return cardFromValue(
    key,
    category?.label ?? FACILITY_FALLBACK_LABELS[key] ?? '设施分类',
    category ? category.count : null,
    category?.source ?? null,
    { unit: category ? '处' : undefined },
  )
}

/** 首要污染物：值在 `aqi` 指标的 `extra.primary_pollutant` 里。 */
function primaryPollutantCard(ctx: ResolveContext): DashboardMetricCard {
  const metric = ctx.metrics.get('aqi')
  const extra = metric?.extra
  const raw =
    extra && typeof extra === 'object'
      ? (extra as Record<string, unknown>).primary_pollutant
      : undefined
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : null
  return cardFromValue('primary_pollutant', '首要污染物', value, metric?.source ?? null)
}

/**
 * 道路分级合计（五个分级之和）。
 *
 * 分级只统计**线要素**（1955 条），与「道路总数」（2260 条，含广场地面）
 * 不是同一个数 —— 卡片标题写清楚，别让人对不上账。
 * 任一分级取不到时整张卡片不可用（不许拿部分和冒充总数）。
 */
function roadTierTotalCard(ctx: ResolveContext): DashboardMetricCard {
  const values = ROAD_TIER_METRICS.map(tier => numericValue(ctx.metrics.get(tier.key)))
  const missing = values.some(value => value === null)
  const total = missing ? null : (values as number[]).reduce((sum, value) => sum + value, 0)
  return cardFromValue(
    'road_tier_total',
    '道路分级合计',
    total,
    ctx.metrics.get('road_count_main')?.source ?? null,
    { unit: '条' },
  )
}

/** 一组「取得到就进环、取不到就丢掉」的段。 */
function buildSlices(
  items: Array<{ key: string; label: string; value: number | null }>,
): { slices: DashboardSlice[]; total: number; missing: number } {
  const slices: DashboardSlice[] = []
  let total = 0
  let missing = 0
  for (const item of items) {
    if (item.value === null) {
      missing += 1
      continue
    }
    slices.push({ key: item.key, label: item.label, value: item.value })
    total += item.value
  }
  return { slices, total, missing }
}

/** 环形图中心标签：有段取不到时如实说明「部分数据不可用」。 */
function centerLabel(base: string, missing: number): string {
  return missing > 0 ? `${base}（部分数据不可用）` : base
}

/** 道路等级分布环形图。 */
function roadTierDonut(ctx: ResolveContext): TabView['donut'] {
  const built = buildSlices(
    ROAD_TIER_METRICS.map(tier => ({
      key: tier.key,
      label: tier.label,
      value: numericValue(ctx.metrics.get(tier.key)),
    })),
  )
  return {
    slices: built.slices,
    // 环形图只画**线要素**（分级只统计线要素），
    // 所以这里的合计与「道路总数」不是同一个数 —— 标题写清楚。
    centerLabel: centerLabel('道路分级合计', built.missing),
    centerValue: built.total,
    source: ctx.metrics.get('road_count_main')?.source ?? null,
  }
}

/** 污染物浓度环形图（统一到 μg/m³）。 */
function pollutantDonut(ctx: ResolveContext): TabView['donut'] {
  const built = buildSlices(
    POLLUTANT_METRICS.map(item => {
      const value = numericValue(ctx.metrics.get(item.key))
      if (value === null) return { key: item.key, label: item.label, value: null }
      const scale = POLLUTANT_UNIT_SCALE[item.key] ?? 1
      return { key: item.key, label: item.label, value: value * scale }
    }),
  )
  return {
    slices: built.slices,
    centerLabel: centerLabel('浓度合计 μg/m³', built.missing),
    centerValue: built.total,
    source: ctx.metrics.get('pm25')?.source ?? null,
  }
}

/** 设施分类环形图（分类计数来自后端，分类互斥所以合计 = 设施总数）。 */
function facilityDonut(ctx: ResolveContext): TabView['donut'] {
  const built = buildSlices(
    ctx.facilities.map(item => ({
      key: item.key,
      label: item.label,
      value: Number.isFinite(item.count) ? item.count : null,
    })),
  )
  return {
    slices: built.slices,
    centerLabel: centerLabel('设施分类合计', built.missing),
    centerValue: built.total,
    source: ctx.facilities[0]?.source ?? null,
  }
}

/**
 * 趋势折线：24 小时 AQI + 逐日 AQI（带各项污染物的日均值）。
 *
 * 两条序列来自后端的**两条不同序列**（`aqi_24h` / `aqi_daily`），
 * 各自带自己的来源标注。取不到时是空数组（界面显示空态，不编数字）。
 */
function aqiLine(ctx: ResolveContext): TabView['line'] {
  const series = ctx.series.get('aqi_24h')
  const points: SeriesPoint[] = Array.isArray(series?.points) ? series.points : []
  const dailySeries = ctx.series.get('aqi_daily')
  const daily: SeriesPoint[] = Array.isArray(dailySeries?.points)
    ? dailySeries.points
    : []
  return {
    points,
    daily,
    dailyMetrics: DAILY_TREND_METRICS,
    unit: series?.unit,
    source: series?.source ?? null,
    emptyText: '暂无 24 小时 AQI 数据',
    dailySource: dailySeries?.source ?? null,
    dailyEmptyText: '暂无逐日 AQI 数据',
  }
}

/** 道路分级条形。 */
function roadTierBars(ctx: ResolveContext): DashboardBar[] {
  return ROAD_TIER_METRICS.map(tier => {
    const metric = ctx.metrics.get(tier.key)
    return {
      key: tier.key,
      label: tier.label,
      value: numericValue(metric),
      unit: metric?.unit ?? '条',
    }
  })
}

/** 污染物浓度条形（各自带自己的单位：CO 是 mg/m³，其余是 μg/m³）。 */
function pollutantBars(ctx: ResolveContext): DashboardBar[] {
  return POLLUTANT_METRICS.map(item => {
    const metric = ctx.metrics.get(item.key)
    return {
      key: item.key,
      label: item.label,
      value: numericValue(metric),
      unit: metric?.unit,
    }
  })
}

/** 设施分类条形。 */
function facilityBars(ctx: ResolveContext): DashboardBar[] {
  return ctx.facilities.map(item => ({
    key: item.key,
    label: item.label,
    value: Number.isFinite(item.count) ? item.count : null,
    unit: '处',
  }))
}

/**
 * 区域概览。
 *
 * **顶栏读数带已经显示 `aqi` / `weather_temp` / `road_load_index`**
 * （S1 的 `.metric-strip` 移到顶栏右侧），所以这里的 6 张卡片
 * **不许再出现这三个数字** —— 同一个数字在大屏上出现两次就是信息噪音。
 */
function overviewView(tab: DashboardTab, ctx: ResolveContext): TabView {
  return {
    tab,
    metrics: [
      cardFromMetric('building_count', '建筑总数', ctx.metrics.get('building_count')),
      cardFromMetric('road_count', '道路总数', ctx.metrics.get('road_count')),
      cardFromMetric('road_length_km', '路网总长', ctx.metrics.get('road_length_km')),
      cardFromMetric('coverage_area_km2', '覆盖面积', ctx.metrics.get('coverage_area_km2')),
      roadTierTotalCard(ctx),
      cardFromMetric('facility_total', '设施分类总数', ctx.metrics.get('facility_total')),
    ],
    donut: roadTierDonut(ctx),
    line: aqiLine(ctx),
    bars: facilityBars(ctx),
    barsSource: ctx.facilities[0]?.source ?? null,
  }
}

/**
 * 空气质量。
 *
 * AQI 本身在顶栏读数带上，卡片里放污染物浓度（首要污染物 + 5 项浓度）。
 */
function airView(tab: DashboardTab, ctx: ResolveContext): TabView {
  return {
    tab,
    metrics: [
      primaryPollutantCard(ctx),
      cardFromMetric('pm25', 'PM2.5', ctx.metrics.get('pm25')),
      cardFromMetric('pm10', 'PM10', ctx.metrics.get('pm10')),
      cardFromMetric('o3', 'O3', ctx.metrics.get('o3')),
      cardFromMetric('no2', 'NO2', ctx.metrics.get('no2')),
      cardFromMetric('so2', 'SO2', ctx.metrics.get('so2')),
    ],
    donut: pollutantDonut(ctx),
    line: aqiLine(ctx),
    bars: pollutantBars(ctx),
    barsSource: ctx.metrics.get('pm25')?.source ?? null,
  }
}

/**
 * 公共安全。
 *
 * 设施分类计数全部来自后端 `facilities`（分类互斥，合计 = 设施总数）。
 */
function publicSafetyView(tab: DashboardTab, ctx: ResolveContext): TabView {
  return {
    tab,
    metrics: [
      facilityCard(ctx, 'medical'),
      facilityCard(ctx, 'public_safety'),
      facilityCard(ctx, 'education'),
      facilityCard(ctx, 'heritage'),
      facilityCard(ctx, 'commerce'),
      cardFromMetric('facility_total', '设施分类总数', ctx.metrics.get('facility_total')),
    ],
    donut: facilityDonut(ctx),
    line: aqiLine(ctx),
    bars: facilityBars(ctx),
    barsSource: ctx.facilities[0]?.source ?? null,
  }
}

/** 城市文旅。 */
function heritageView(tab: DashboardTab, ctx: ResolveContext): TabView {
  return {
    tab,
    metrics: [
      facilityCard(ctx, 'heritage'),
      cardFromMetric('facility_total', '设施分类总数', ctx.metrics.get('facility_total')),
      cardFromMetric('building_count', '建筑总数', ctx.metrics.get('building_count')),
      cardFromMetric('road_count', '道路总数', ctx.metrics.get('road_count')),
      cardFromMetric('road_length_km', '路网总长', ctx.metrics.get('road_length_km')),
      cardFromMetric('coverage_area_km2', '覆盖面积', ctx.metrics.get('coverage_area_km2')),
    ],
    donut: facilityDonut(ctx),
    line: aqiLine(ctx),
    bars: facilityBars(ctx),
    barsSource: ctx.facilities[0]?.source ?? null,
  }
}

/**
 * 路网运行。
 *
 * 路网负载（`road_load_index`）是**模型估算**，它在顶栏读数带上并标着
 * 「（模型估算）」，所以这里不再重复它。
 */
function networkView(tab: DashboardTab, ctx: ResolveContext): TabView {
  return {
    tab,
    metrics: [
      cardFromMetric('road_length_km', '路网总长', ctx.metrics.get('road_length_km')),
      cardFromMetric('coverage_area_km2', '覆盖面积', ctx.metrics.get('coverage_area_km2')),
      roadTierTotalCard(ctx),
      cardFromMetric('road_count_main', '主干道', ctx.metrics.get('road_count_main')),
      cardFromMetric('road_count_local', '支路', ctx.metrics.get('road_count_local')),
      cardFromMetric('road_count', '道路总数', ctx.metrics.get('road_count')),
    ],
    donut: roadTierDonut(ctx),
    line: aqiLine(ctx),
    bars: roadTierBars(ctx),
    barsSource: ctx.metrics.get('road_count_main')?.source ?? null,
  }
}

/**
 * 算出某个页签的视图数据。
 *
 * **纯函数**：不碰 Vue 响应式，输入输出都是普通数据。
 * `overview` 为 null（还没取到数据）时，每个数字都是 null + unavailable，
 * 界面显示「数据源暂不可用」—— 不显示 0。
 */
export function resolveTabView(tab: DashboardTab, overview: CityOverview | null): TabView {
  const ctx = buildContext(overview)
  switch (tab.key) {
    case 'air':
      return airView(tab, ctx)
    case 'public_safety':
      return publicSafetyView(tab, ctx)
    case 'heritage':
      return heritageView(tab, ctx)
    case 'network':
      return networkView(tab, ctx)
    case 'overview':
    default:
      return overviewView(tab, ctx)
  }
}

/** 按页签 key 算视图数据（key 未知时回落到区域概览）。 */
export function resolveTabViewByKey(
  key: string,
  overview: CityOverview | null,
): TabView {
  const tab: DashboardTab = { key, label: key }
  return resolveTabView(tab, overview)
}
