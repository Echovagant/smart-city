"""空气质量数据源 —— open-meteo Air Quality API（CAMS 模型再分析）。

接口（2026-10-24 实测）
----------------------
``GET https://air-quality-api.open-meteo.com/v1/air-quality`` → 200 JSON::

    {"latitude": 41.4, "longitude": 2.2000008,
     "utc_offset_seconds": 7200, "timezone": "Europe/Madrid", "elevation": 47.0,
     "current_units": {"time": "unixtime", "pm2_5": "μg/m³", ...},
     "current": {"time": 1792803600, "interval": 3600,
                 "pm10": 13.0, "pm2_5": 8.3, "ozone": 30.0,
                 "nitrogen_dioxide": 33.6, "sulphur_dioxide": 2.9,
                 "carbon_monoxide": 167.0, "us_aqi": 40, "european_aqi": 45},
     "hourly": {"time": [1792706400, 1792710000, ...],
                "pm2_5": [...], "ozone": [...], ...}}

一个请求给出全部所需数据
------------------------
上游同时给 ``hourly`` 与 ``current``，所以本模块是**一个源**：
7 个指标 + 2 条序列。取不到就整体降级（调用方把它当一个源注册）。

自己算 AQI
----------
上游只给**污染物浓度**（μg/m³），不给国标口径的 AQI —— 换算在
``city_data/aqi.py`` 里做（GB/T 3095-2012 的 IAQI 分段 + 线性内插）。
本模块负责**口径**：把逐小时浓度聚合成国标要的平均值。

- **指标**（截至当前小时）：PM2.5 / PM10 / O3 / NO2 / SO2 / CO 取**24 小时
  滑动平均**；CO 的单位是 **mg/m³**（上游是 μg/m³，除以 1000）。
- **AQI 指标**：PM2.5 / PM10 / NO2 / SO2 / CO 用 **24 小时滑动平均**，
  O3 用 **8 小时滑动平均**（``aqi.AVERAGING_HOURS``）——
  指标口径与 AQI 口径**可以不同**，前者是「当前浓度水平」，后者是国标口径。
- **滑动平均**：窗口内**有值**的那些点的算术平均；一个值都没有就跳过
  （该指标 ``value = None``，不参与 AQI 的最大值）。
  窗口里的点太少时也算不出来（数据刚开头时平均值不稳，宁可不给数）——
  点数下限是 ``min(MIN_WINDOW_POINTS, 窗口小时数)``：
  24 小时窗口至少要 12 个点，8 小时的 O3 窗口要凑满 8 个点。
- **逐日序列**：只取**完整的本地日**（一天 24 个小时都有数据），
  不含今天的不完整日，也不含未来的预报日。
  日 AQI 里 PM/NO2/SO2/CO 用当日 24 小时平均，O3 用**当日 8 小时滑动平均
  的最大值**（国标的日 O3 口径）；``values`` 里各项污染物的日统计值
  与该日 AQI 的输入**一致**（CO 换算成 mg/m³）。

已知限制
--------
1. **这是 CAMS 模型再分析值（11 km 网格），不是站点实测**
   → ``source.estimated = True``。
2. 上游**没有 ``daily`` 段落** → 日聚合全部由本模块从 ``hourly`` 算出来。
3. ``utc_offset_seconds`` 是**请求时刻的固定偏移**，整个响应里不变
   （夏令时切换会被忽略）—— 用它分本地日与上游自己的日边界一致。
4. 上游的 ``european_aqi`` / ``us_aqi`` 是按**瞬时值**算的官方指数，
   与我们按**国标 24 小时滑动平均**换算出来的 AQI **不是同一个口径，
   不能直接比大小** —— 响应里同时给出，但用途不同。
5. 署名要求：同时署名 **CAMS ENSEMBLE 数据提供方** 与 **Open-Meteo**
   （免费档的授权条件）—— 署名写在响应的 ``extra.attribution`` 里，
   随数据一起发出去，不只写在文档里。
6. 免费档仅限非商业用途。
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib.parse import urlencode

from .. import http
from ..aqi import AVERAGING_HOURS, aqi_from_pollutants, aqi_level
from ..cities import City
from ..http import SourceUnavailable
from ..models import Metric, Series, SeriesPoint, SourceInfo, SourceResult

BASE_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"

# 源的名字（前端会直接显示在指标带上）。
SOURCE_NAME = "Open-Meteo 空气质量（CAMS 模型再分析）"

# 上游变量名 → (指标 key, 中文名, 单位)。
# CO 的单位是 mg/m³（上游给的是 μg/m³，换算在下面做）。
POLLUTANTS: Tuple[Tuple[str, str, str, str], ...] = (
    ("pm2_5", "pm25", "PM2.5", "μg/m³"),
    ("pm10", "pm10", "PM10", "μg/m³"),
    ("ozone", "o3", "O3", "μg/m³"),
    ("nitrogen_dioxide", "no2", "NO2", "μg/m³"),
    ("sulphur_dioxide", "so2", "SO2", "μg/m³"),
    ("carbon_monoxide", "co", "CO", "mg/m³"),
)

# 降级时占位指标的槽位（顺序即响应里的顺序）。
SLOTS: Tuple[Tuple[str, str, str], ...] = (
    ("aqi", "空气质量", "AQI"),
) + tuple((key, label, unit) for _var, key, label, unit in POLLUTANTS)

# 上游 ``current`` 里额外要的两个官方指数。
EXTRA_CURRENT_FIELDS = ("european_aqi", "us_aqi")

# 窗口内至少要有多少个点才算得出平均值。数据刚开头时窗口不满，
# 少于这个点数说明样本太少 —— 宁可给 None，也不给一个不稳的平均值。
#
# 这个下限是**按 24 小时窗口**定的（24 小时里至少 12 个点）。
# 更短的窗口（O3 的 8 小时）按窗口长度取下限：``min(12, 窗口小时数)`` ——
# 否则 8 小时的窗口永远凑不齐 12 个点，O3 会永远取不到值。
MIN_WINDOW_POINTS = 12

# 逐小时序列保留最近多少个小时（= 24 小时滑动窗口的长度）。
HOURLY_POINTS = 24

# 逐日序列保留最近多少个完整日。
DAILY_POINTS = 7

# CO：上游 μg/m³ → 指标口径 mg/m³。
CO_SCALE = 0.001

SECONDS_PER_HOUR = 3600
SECONDS_PER_DAY = 86400

# 观测时间与当前时间差超过这个秒数，就不再声称「实时」。
REALTIME_MAX_AGE_SECONDS = 3600.0

# 口径说明（写进响应的 extra，别让人把两种口径混着比）。
AQI_BASIS = "GB/T 3095-2012 IAQI 分段换算（24 小时滑动平均，O3 取 8 小时）"
DATA_KIND = "CAMS 模型再分析值（非站点实测）"

# 上游要求的署名（免费档的授权条件）—— 随数据一起发出去，别只写在文档里。
ATTRIBUTION = "CAMS ENSEMBLE 数据提供方 + Open-Meteo"


def now_iso() -> str:
    """当前时间（ISO8601，UTC，秒精度）。"""
    return to_iso(datetime.now(tz=timezone.utc))


def to_iso(moment: datetime) -> str:
    """带时区的 datetime → ISO8601（UTC，Z 结尾）。"""
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def build_url(city: City) -> str:
    """按城市取数点拼出完整请求地址。

    坐标与时区都来自城市表 —— **不写死**任何一座城市的坐标。
    """
    hourly_vars = ",".join(var for var, _key, _label, _unit in POLLUTANTS)
    current_vars = ",".join(
        [var for var, _key, _label, _unit in POLLUTANTS] + list(EXTRA_CURRENT_FIELDS)
    )
    query = urlencode(
        {
            "latitude": city.latitude,
            "longitude": city.longitude,
            "hourly": hourly_vars,
            "current": current_vars,
            "timezone": city.timezone,
            "timeformat": "unixtime",
            "past_days": 7,
            "forecast_days": 1,
        },
        safe=",",
    )
    return BASE_URL + "?" + query


def _to_float(raw: Any) -> Optional[float]:
    """上游数值 → 浮点数；不是有限数就当没有。"""
    if raw is None or isinstance(raw, bool):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _epoch_seconds(raw: Any) -> Optional[int]:
    """Unix epoch 秒 → int；不是数字就当没有。"""
    value = _to_float(raw)
    return None if value is None else int(value)


def parse_payload(payload: Any) -> Dict[str, Any]:
    """把上游响应整理成内部结构。

    返回：``{"records": [...], "offset": int, "timezone": str|None, "current": dict}``。
    每个 record 是 ``{"epoch": int, "values": {指标 key: 数值|None}}``，
    按时间**升序**。

    逐小时数据整体缺失时抛 :class:`SourceUnavailable` ——
    没有它就什么都算不出来。
    """
    if not isinstance(payload, dict):
        raise SourceUnavailable("空气质量响应不是 JSON 对象")

    hourly = payload.get("hourly")
    if not isinstance(hourly, dict):
        raise SourceUnavailable("空气质量响应缺少 hourly")
    times = hourly.get("time")
    if not isinstance(times, list) or not times:
        raise SourceUnavailable("空气质量响应缺少逐小时时间轴")

    columns: Dict[str, Any] = {}
    for var, _key, _label, _unit in POLLUTANTS:
        columns[var] = hourly.get(var)

    records: List[Dict[str, Any]] = []
    for index, raw_time in enumerate(times):
        epoch = _epoch_seconds(raw_time)
        if epoch is None:
            continue
        values: Dict[str, Optional[float]] = {}
        for var, key, _label, _unit in POLLUTANTS:
            column = columns.get(var)
            if isinstance(column, list) and index < len(column):
                values[key] = _to_float(column[index])
            else:
                values[key] = None
        records.append({"epoch": epoch, "values": values})

    records.sort(key=lambda record: record["epoch"])
    if not records:
        raise SourceUnavailable("空气质量响应没有可用的逐小时数据点")

    current = payload.get("current")
    return {
        "records": records,
        "offset": int(_to_float(payload.get("utc_offset_seconds")) or 0),
        "timezone": payload.get("timezone"),
        "current": current if isinstance(current, dict) else {},
    }


def _current_index(records: Sequence[Dict[str, Any]], now_epoch: int) -> int:
    """「当前小时」的下标 —— 最后一个**不晚于**当前时刻的点。

    未来时刻的预报点不算 —— 那是预报，不是已经发生的事。
    """
    index = -1
    for position, record in enumerate(records):
        if record["epoch"] <= now_epoch:
            index = position
        else:
            break
    if index < 0:
        raise SourceUnavailable("逐小时数据里没有不晚于当前时刻的点")
    return index


def _window_average(
    records: Sequence[Dict[str, Any]],
    index: int,
    key: str,
    hours: int,
) -> Optional[float]:
    """截至 ``records[index]`` 的 ``hours`` 小时滑动平均。

    窗口是**时间窗口**（``[end - (hours-1) 小时, end]``），窗口内有值的点
    取算术平均；点太少（数据刚开头）或一个值都没有就返回 ``None``。
    """
    end = records[index]["epoch"]
    lower = end - (hours - 1) * SECONDS_PER_HOUR
    values: List[float] = []
    for record in records[: index + 1]:
        if record["epoch"] < lower:
            continue
        value = record["values"].get(key)
        if value is not None:
            values.append(value)
    if len(values) < min(MIN_WINDOW_POINTS, hours):
        return None
    return sum(values) / len(values)


def _aqi_at(records: Sequence[Dict[str, Any]], index: int) -> Optional[int]:
    """某个小时上的国标 AQI。

    各污染物的平均窗口按 ``aqi.AVERAGING_HOURS`` 走（O3 是 8 小时，
    其余 24 小时）—— 换算本身交给 ``aqi.aqi_from_pollutants``。
    """
    concentrations: Dict[str, Optional[float]] = {}
    for _var, key, _label, _unit in POLLUTANTS:
        concentrations[key] = _window_average(records, index, key, AVERAGING_HOURS[key])
    return aqi_from_pollutants(concentrations)


def _daily_mean(values: Sequence[Optional[float]]) -> Optional[float]:
    """一组逐小时值的日平均；点太少就当没有。"""
    present = [value for value in values if value is not None]
    if len(present) < MIN_WINDOW_POINTS:
        return None
    return sum(present) / len(present)


def _group_by_local_day(
    records: Sequence[Dict[str, Any]],
    offset: int,
) -> Dict[int, List[int]]:
    """按本地日分组（返回每个本地日对应的记录下标列表）。

    本地日编号 = ``(epoch + utc_offset_seconds) // 86400`` —— 与上游自己的
    日边界一致（上游给的偏移在响应里是固定的）。
    """
    groups: Dict[int, List[int]] = {}
    for index, record in enumerate(records):
        day = (record["epoch"] + offset) // SECONDS_PER_DAY
        groups.setdefault(day, []).append(index)
    return groups


def _daily_point(
    records: Sequence[Dict[str, Any]],
    day_indexes: Sequence[int],
) -> Tuple[Optional[int], Dict[str, Optional[float]]]:
    """一个完整本地日 → ``(日 AQI, 各污染物的日统计值)``。

    PM/NO2/SO2/CO 用当日 24 小时平均；O3 用当日 8 小时滑动平均的最大值
    （窗口允许跨过日界 —— 国标的「日最大 8 小时滑动平均」就是这样）。
    """
    means: Dict[str, Optional[float]] = {}
    for _var, key, _label, _unit in POLLUTANTS:
        if key == "o3":
            continue
        means[key] = _daily_mean([records[i]["values"].get(key) for i in day_indexes])

    o3_max: Optional[float] = None
    for index in day_indexes:
        average = _window_average(records, index, "o3", AVERAGING_HOURS["o3"])
        if average is None:
            continue
        if o3_max is None or average > o3_max:
            o3_max = average
    means["o3"] = o3_max

    # AQI 的输入与上面的日统计值一致（CO 传上游单位 μg/m³）。
    aqi = aqi_from_pollutants({key: means.get(key) for key in means})

    # 对外的日统计值：键与指标 key 一致，CO 换算成 mg/m³。
    values: Dict[str, Optional[float]] = {
        key: means.get(key) for key in ("pm25", "pm10", "o3", "no2", "so2")
    }
    values["co"] = None if means.get("co") is None else means["co"] * CO_SCALE
    return aqi, values


def fetch(city: City, timeout: float = http.DEFAULT_TIMEOUT_SECONDS) -> SourceResult:
    """取某个城市的空气质量（7 个指标 + 2 条序列）。

    取不到就抛 :class:`SourceUnavailable`（调用方把它算作降级）。
    """
    fetched_at = now_iso()
    url = build_url(city)
    payload = http.request_json(url, timeout=timeout)
    now = datetime.now(tz=timezone.utc)
    now_epoch = int(now.timestamp())

    parsed = parse_payload(payload)
    records: List[Dict[str, Any]] = parsed["records"]
    index = _current_index(records, now_epoch)
    current = parsed["current"]

    observed_at = datetime.fromtimestamp(records[index]["epoch"], tz=timezone.utc)
    age = (now - observed_at).total_seconds()
    source = SourceInfo(
        name=SOURCE_NAME,
        url=url,
        observed_at=to_iso(observed_at),
        fetched_at=fetched_at,
        realtime=0 <= age <= REALTIME_MAX_AGE_SECONDS,
        # CAMS 是模型再分析值，不是站点实测。
        estimated=True,
    )

    # ---- 指标 ---------------------------------------------------------
    # 指标口径：全部 24 小时滑动平均（CO 换算成 mg/m³）。
    averages: Dict[str, Optional[float]] = {}
    for _var, key, _label, _unit in POLLUTANTS:
        averages[key] = _window_average(records, index, key, 24)

    aqi_value = _aqi_at(records, index)
    level = aqi_level(aqi_value)

    aqi_extra: Dict[str, Any] = {
        "aqi_basis": AQI_BASIS,
        "data_kind": DATA_KIND,
        "attribution": ATTRIBUTION,
        "observed_hour": to_iso(observed_at),
    }
    for field_name in EXTRA_CURRENT_FIELDS:
        value = _to_float(current.get(field_name))
        if value is not None:
            aqi_extra[field_name] = value
    if parsed["timezone"] is not None:
        aqi_extra["timezone"] = parsed["timezone"]
    aqi_extra["utc_offset_seconds"] = parsed["offset"]

    metrics = [
        Metric(
            key="aqi",
            label="空气质量",
            value=aqi_value,
            unit="AQI",
            level=level[0] if level else None,
            level_label=level[1] if level else None,
            extra=aqi_extra,
            source=source,
        )
    ]
    for _var, key, label, unit in POLLUTANTS:
        value = averages.get(key)
        if key == "co" and value is not None:
            value = value * CO_SCALE
        metrics.append(
            Metric(
                key=key,
                label=label,
                value=value,
                unit=unit,
                extra={
                    "basis": "24 小时滑动平均",
                    "data_kind": DATA_KIND,
                    "attribution": ATTRIBUTION,
                    "observed_hour": to_iso(observed_at),
                    "utc_offset_seconds": parsed["offset"],
                },
                source=source,
            )
        )

    # ---- 序列 ---------------------------------------------------------
    # 逐小时：最近 24 个小时，每点的 AQI 以该小时结尾的滑动窗口算出。
    first = max(0, index - HOURLY_POINTS + 1)
    hourly_points = [
        SeriesPoint(
            t=to_iso(datetime.fromtimestamp(records[position]["epoch"], tz=timezone.utc)),
            v=_aqi_at(records, position),
        )
        for position in range(first, index + 1)
    ]
    hourly_series = Series(
        key="aqi_24h",
        label="24 小时 AQI",
        unit="AQI",
        points=hourly_points,
        source=source,
    )

    # 逐日：只取**完整的本地日**（24 个小时都有数据），不含今天与未来。
    groups = _group_by_local_day(records, parsed["offset"])
    today = (now_epoch + parsed["offset"]) // SECONDS_PER_DAY
    complete_days = [
        day
        for day in sorted(groups)
        if day < today and len(groups[day]) == 24
    ][-DAILY_POINTS:]

    daily_points: List[SeriesPoint] = []
    for day in complete_days:
        day_indexes = groups[day]
        day_aqi, day_values = _daily_point(records, day_indexes)
        if all(value is None for value in day_values.values()):
            # 一项都算不出来 → 不产出这个键（序列点序列化时会省略 values）。
            daily_points.append(
                SeriesPoint(
                    t=to_iso(
                        datetime.fromtimestamp(records[day_indexes[0]]["epoch"], tz=timezone.utc)
                    ),
                    v=day_aqi,
                )
            )
            continue
        daily_points.append(
            SeriesPoint(
                t=to_iso(
                    datetime.fromtimestamp(records[day_indexes[0]]["epoch"], tz=timezone.utc)
                ),
                v=day_aqi,
                values=day_values,
            )
        )
    daily_series = Series(
        key="aqi_daily",
        label="逐日 AQI",
        unit="AQI",
        points=daily_points,
        source=source,
    )

    return SourceResult(metrics=metrics, series=[hourly_series, daily_series])
