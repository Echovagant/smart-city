"""派生事件流 —— **纯函数模块**（不联网、不碰 I/O）。

这个项目**没有告警系统**、没有摄像头、没有工单系统。
事件流里的每一条都必须是从**真实指标**派生出来的：
派生不出来就是空数组 —— **空数组是对的**，伪造事件是错的。

四条不可让步的规则
------------------
1. **每条事件都有来源**：``source`` 指向它依据的那个指标/序列的 ``SourceInfo``，
   另带 ``metric_key`` 与 ``time``。没有来源的事件不许出现在响应里。
2. **模型估算派生的事件** ``estimated = true``（目前只有规则 3：路网负载）。
3. **id 必须稳定**：同一条事件重复派生时 id 不变 ——
   前端据此去重，60 秒一次的轮询不会把同一条事件插进列表好几次。
4. **派生不出来就少一条**：某个源降级 → 依赖它的规则**不产生事件**
   （不是产生一条「数据不可用」事件）。

派生规则（全部有真实依据）
--------------------------
====  ==================================================================  ==========  ==========  ================  ===============
#     规则                                                                level       estimated  位置             ``location_kind``
====  ==================================================================  ==========  ==========  ================  ===============
1     ``aqi_24h`` 序列相邻两点的分级不同 → 「空气质量由{旧}转为{新}」   按新等级     false       城心（全市）     ``"city"``
2     当前 ``aqi.level >= 3`` → 「当前空气质量{等级}」                    按等级       false       城心（全市）     ``"city"``
3     ``road_load_index >= 80`` → 「路网负载指数 {v} 超过参考阈值 80」      alert        **true**    **最长主干道中点**  ``"geometry"``
4     ``weather_temp <= 0``（低温）/ ``>= 35``（高温）→ 极端天气提示        warn         false       城心（全市）     ``"city"``
====  ==================================================================  ==========  ==========  ================  ===============

**「城心」只有一个**：应用里唯一定义的城心是 ``cityConfig.center``（前端），
也是相机的绕行中心。规则 1/2/4 是**全市级**事件 —— 全市指标本来就没有空间位置，
落在城心是准确的，而且这样它在默认鸟瞰视角下**永远在屏幕中心**。
规则 3 是**几何锚定**事件 —— 位置是真实道路上的点，不许用城心假装路段。

事件的 ``estimated`` 继承自它依据的那个源
------------------------------------------
事件是**派生**出来的：它依据的指标本身是实测还是模型估算，
这条事件就是实测还是模型估算。所以 ``estimated`` 不写死，
而是取 ``source.estimated``（路网负载那条本来就是估算，不变）。

AQI 分级换算
------------
逐小时序列的点上**只有 AQI 数值，没有分级字段**，所以按国标
（HJ 633-2012 的六档）换算，与 ``city_data/aqi.py`` 的分级一致：

=====  ==========  ==============
AQI   分级        ``AqiLevel``
=====  ==========  ==============
0-50  优          1
51-100 良         2
101-150 轻度污染   3
151-200 中度污染   4
201-300 重度污染   5
>300  严重污染    6
=====  ==========  ==============

这是**确定性标准映射**，不是猜测，所以分级本身不带估算标记
（``estimated`` 取自它依据的源，见上面的说明）。
"""
import logging
import math
from typing import List, Optional, Sequence, Tuple

from .aqi import AQI_LEVEL_BANDS, aqi_level
from .models import CityEvent, EventLocation, Metric, RoadAnchor, Series, SourceInfo

logger = logging.getLogger(__name__)

# 逐小时 AQI 序列的 key（规则 1 用的就是它）。
AQI_SERIES_KEY = "aqi_24h"

# AQI 分级带定义在 ``city_data/aqi.py``（与换算口径放在一起）。
# 这里重新导出，保留「从本模块取分级」的既有用法。
__all__ = [
    "AQI_LEVEL_BANDS",
    "AQI_SERIES_KEY",
    "aqi_level",
    "derive_events",
]

# 规则 2：当前 AQI 等级达到这个数就出事件（3 = 轻度污染）。
AQI_ALERT_LEVEL = 3

# 规则 3：路网负载指数的参考阈值（模型估算）。
ROAD_LOAD_ALERT_THRESHOLD = 80.0

# 规则 4：气温的极端区间（摄氏度）。
WEATHER_LOW_TEMP_C = 0.0
WEATHER_HIGH_TEMP_C = 35.0

# 事件流的长度上限：前端只渲染前若干条，列表里全给。
MAX_EVENTS = 20

# 全市级事件的 ``location_kind``：没有空间位置，前端落在**城心**。
LOCATION_KIND_CITY = "city"

# 几何锚定事件的 ``location_kind``：位置是真实几何上的点。
LOCATION_KIND_GEOMETRY = "geometry"

# 本地 OSM 快照不可用时的兜底参考点。
#
# 注意：这是**数据范围中心**（OSM 抽取范围的围中心），**不是城心** ——
# 全项目只有一个城心：前端 ``cityConfig.center``（也是相机的绕行中心）。
# 全市级事件的坐标由前端按 ``location_kind`` 解析到城心，这里只是后端自己的参考点。
SCENE_CENTER_FALLBACK = EventLocation(
    lng=2.1650, lat=41.3950, label="数据范围中心（默认位置）"
)


def aqi_level(value: Optional[float]) -> Optional[Tuple[int, str]]:
    """AQI 数值 → ``(分级编号, 中文名)``。取不到或不是数字时返回 ``None``。

    按国标 HJ 633-2012 换算，与 ``city_data/aqi.py`` 的分级一致。
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number < 0:
        return None
    for upper, level, label in AQI_LEVEL_BANDS:
        if number <= upper:
            return level, label
    return None


def event_level_of(aqi_grade: int) -> str:
    """AQI 分级 → 事件严重度。

    优/良（1-2）是常态 → ``info``；轻度/中度污染（3-4）→ ``warn``；
    重度/严重污染（5-6）→ ``alert``。
    """
    if aqi_grade <= 2:
        return "info"
    if aqi_grade <= 4:
        return "warn"
    return "alert"


def _find_metric(metrics: Sequence[Metric], key: str) -> Optional[Metric]:
    """按 key 找指标。找不到返回 ``None``。"""
    for metric in metrics:
        if isinstance(metric, Metric) and metric.key == key:
            return metric
    return None


def _metric_value(metric: Optional[Metric]) -> Optional[float]:
    """取指标里的数值。取不到（降级占位是 ``None``）返回 ``None``。"""
    if metric is None:
        return None
    value = metric.value
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _event_time(source: SourceInfo) -> str:
    """事件的判定时刻：优先用上游的观测时间，没有就用取数时间。"""
    if source.observed_at:
        return source.observed_at
    return source.fetched_at


def _rule_aqi_level_change(
    series_list: Sequence[Series], center: EventLocation
) -> List[CityEvent]:
    """规则 1：逐小时 AQI 序列里**分级变了**。

    依据是真实逐小时序列；分级按国标从 AQI 数值换算。
    """
    events: List[CityEvent] = []
    for item in series_list:
        if not isinstance(item, Series) or item.key != AQI_SERIES_KEY:
            continue
        previous: Optional[Tuple[int, str]] = None
        for point in item.points:
            grade = aqi_level(point.v)
            if grade is None:
                continue
            if previous is not None and previous[0] != grade[0]:
                new_grade, new_label = grade
                events.append(
                    CityEvent(
                        id="air_quality:level_change:%s" % point.t,
                        type="air_quality",
                        level=event_level_of(new_grade),
                        title="空气质量由%s转为%s" % (previous[1], new_label),
                        detail=(
                            "%s 的 AQI 为 %s，按 AQI 分级标准换算为「%s」"
                            "（上一小时为「%s」）。"
                            % (point.t, point.v, new_label, previous[1])
                        ),
                        time=point.t,
                        location_kind=LOCATION_KIND_CITY,
                        location=center,
                        metric_key=item.key,
                        source=item.source,
                        # 事件是派生的：依据的源是模型数据，事件就是模型数据。
                        estimated=bool(item.source.estimated),
                    )
                )
            previous = grade
    return events


def _rule_current_aqi(metrics: Sequence[Metric], center: EventLocation) -> List[CityEvent]:
    """规则 2：当前 AQI 等级达到告警线（轻度污染及以上）。"""
    metric = _find_metric(metrics, "aqi")
    value = _metric_value(metric)
    if metric is None or value is None:
        return []
    grade = metric.level
    label = metric.level_label
    if grade is None:
        converted = aqi_level(value)
        if converted is None:
            return []
        grade, label = converted
    if grade < AQI_ALERT_LEVEL:
        return []
    label = label or "等级 %s" % grade
    return [
        CityEvent(
            id="air_quality:current_level:%s" % grade,
            type="air_quality",
            level=event_level_of(grade),
            title="当前空气质量%s" % label,
            detail=(
                "实时 AQI 为 %s（分级 %s）。当前等级已达到告警线 %s。"
                % (value, grade, AQI_ALERT_LEVEL)
            ),
            time=_event_time(metric.source),
            location_kind=LOCATION_KIND_CITY,
            location=center,
            metric_key=metric.key,
            source=metric.source,
            estimated=bool(metric.source.estimated),
        )
    ]


def _rule_road_load(
    metrics: Sequence[Metric],
    center: EventLocation,
    road_anchor: Optional[RoadAnchor],
) -> List[CityEvent]:
    """规则 3：路网负载指数超过参考阈值。

    位置必须落在**真实道路几何**上：本地 OSM 快照里等级最高且最长的那条线段的中点。
    拿不到锚点时退回参考点（不编造位置），但 kind 仍然是 ``geometry`` ——
    这条事件本来就是**几何锚定**的。
    """
    metric = _find_metric(metrics, "road_load_index")
    value = _metric_value(metric)
    if metric is None or value is None:
        return []
    if value < ROAD_LOAD_ALERT_THRESHOLD:
        return []
    location = center
    if road_anchor is not None:
        location = EventLocation(
            lng=road_anchor.lng, lat=road_anchor.lat, label=road_anchor.label
        )
    return [
        CityEvent(
            id="road_load:over_threshold:%s" % value,
            type="road_load",
            level="alert",
            title="路网负载指数 %s 超过参考阈值 %s"
            % (value, int(ROAD_LOAD_ALERT_THRESHOLD)),
            detail=(
                "路网负载指数是静态几何折算的供给紧张度（模型估算），"
                "不含任何实时车流或路况观测，不能当作实时路况读数。"
            ),
            time=_event_time(metric.source),
            location_kind=LOCATION_KIND_GEOMETRY,
            location=location,
            metric_key=metric.key,
            source=metric.source,
            estimated=True,
        )
    ]


def _rule_weather(metrics: Sequence[Metric], center: EventLocation) -> List[CityEvent]:
    """规则 4：气温极端（低温 ≤ 0℃ / 高温 ≥ 35℃）。"""
    metric = _find_metric(metrics, "weather_temp")
    value = _metric_value(metric)
    if metric is None or value is None:
        return []
    if value <= WEATHER_LOW_TEMP_C:
        cold = True
    elif value >= WEATHER_HIGH_TEMP_C:
        cold = False
    else:
        return []
    unit = metric.unit or "℃"
    if cold:
        title = "低温提示：气温 %s%s" % (value, unit)
        detail = "气温已达到低温提示线（≤ %s%s）。" % (int(WEATHER_LOW_TEMP_C), unit)
        event_id = "weather:extreme:cold"
    else:
        title = "高温提示：气温 %s%s" % (value, unit)
        detail = "气温已达到高温提示线（≥ %s%s）。" % (int(WEATHER_HIGH_TEMP_C), unit)
        event_id = "weather:extreme:hot"
    return [
        CityEvent(
            id=event_id,
            type="weather",
            level="warn",
            title=title,
            detail=detail,
            time=_event_time(metric.source),
            location_kind=LOCATION_KIND_CITY,
            location=center,
            metric_key=metric.key,
            source=metric.source,
            estimated=bool(metric.source.estimated),
        )
    ]


def derive_events(
    metrics: Sequence[Metric],
    series: Sequence[Series],
    *,
    center: Optional[EventLocation] = None,
    road_anchor: Optional[RoadAnchor] = None,
) -> List[CityEvent]:
    """从真实指标派生事件流。

    - ``metrics`` / ``series``：聚合器拿到的全部指标与序列（**含降级占位**）。
    - ``center``：**数据范围中心**（本地 OSM 快照的围中心）——
      全市级事件（``location_kind="city"``）的后端参考点。
      前端会按 kind 把它们改放到**城心**（``cityConfig.center``），所以这里的坐标只是载荷里的参考值。
    - ``road_anchor``：最长主干道的中点（规则 3 的**真实几何**位置）。

    **每条规则各自兜住自己的异常**：任何一条规则出错只是跳过那条规则，
    其余照常产出 —— 端点因此永不 500。
    """
    scene_center = center if center is not None else SCENE_CENTER_FALLBACK
    events: List[CityEvent] = []

    rules = (
        ("AQI 等级变化", lambda: _rule_aqi_level_change(series, scene_center)),
        ("当前 AQI 等级", lambda: _rule_current_aqi(metrics, scene_center)),
        ("路网负载", lambda: _rule_road_load(metrics, scene_center, road_anchor)),
        ("极端天气", lambda: _rule_weather(metrics, scene_center)),
    )
    for name, rule in rules:
        try:
            events.extend(rule())
        except Exception:  # noqa: BLE001 —— 一条规则出错不许拖垮整个端点
            logger.warning("事件派生规则「%s」出错，已跳过该规则", name, exc_info=True)

    # 按时间倒序（新的在前）；同一时刻保持产生顺序（规则 1 → 4）。
    events.sort(key=lambda item: item.time, reverse=True)
    return events[:MAX_EVENTS]
