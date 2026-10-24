"""AQI 计算 —— 国标 GB/T 3095-2012 的 IAQI 分段与换算。

纯函数模块：不联网、不碰 I/O、不读文件。

为什么自己算
------------
open-meteo 只给**污染物浓度**（μg/m³），不给中国国标口径的 AQI；
中国环境监测总站直接给 AQI，但只覆盖中国的城市。换到欧洲城市之后
「浓度 → AQI」这一步必须自己做，并且必须把口径写清楚：
这是**按国标分段表换算**，不是任何机构**发布**的 AQI。

分段表
------
IAQI 分段固定为 0 / 50 / 100 / 150 / 200 / 300 / 400 / 500，
各污染物的浓度区间与统计口径不同：

=========  ==================  ==============================
污染物     统计口径            浓度区间（μg/m³）
=========  ==================  ==============================
PM2.5      24 小时平均          0 35 75 115 150 250 350 500
PM10       24 小时平均          0 50 150 250 350 420 500 600
O3         8 小时平均           0 100 160 215 265 800
NO2        24 小时平均          0 40 80 180 280 565 750 940
SO2        24 小时平均          0 50 150 475 800 1600 2100 2620
CO         24 小时平均          0 2 4 14 24 36 48 60（**mg/m³**）
=========  ==================  ==============================

CO 在国标里的单位是 mg/m³，上游给的是 μg/m³ —— 模块内部换算
（``UNIT_SCALE_TO_STANDARD``），**调用方一律传 μg/m³**。

换算公式（国标附录 A 的线性内插）::

    IAQI = (IAQI_high - IAQI_low) / (C_high - C_low) × (C - C_low) + IAQI_low

AQI 取各污染物 IAQI 的**最大值**。浓度超出最高一段时按最高一段处理
（IAQI = 500）。所有污染物都取不到时 AQI 是 ``None`` ——
**不许填 0**，0 在国标里是「优」，填 0 等于编数据。
"""
from __future__ import annotations

import math
from typing import Dict, Mapping, Optional, Sequence, Tuple

# IAQI 的分段点（国标固定值）。
IAQI_LEVELS: Tuple[int, ...] = (0, 50, 100, 150, 200, 300, 400, 500)

# O3 只有 6 段（最高到 300）。
IAQI_LEVELS_O3: Tuple[int, ...] = IAQI_LEVELS[:6]

# 污染物 -> (IAQI 分段, 浓度分段上限 μg/m³)
BREAKPOINTS: Dict[str, Tuple[Tuple[int, ...], Tuple[float, ...]]] = {
    "pm25": (IAQI_LEVELS, (0, 35, 75, 115, 150, 250, 350, 500)),
    "pm10": (IAQI_LEVELS, (0, 50, 150, 250, 350, 420, 500, 600)),
    "o3": (IAQI_LEVELS_O3, (0, 100, 160, 215, 265, 800)),
    "no2": (IAQI_LEVELS, (0, 40, 80, 180, 280, 565, 750, 940)),
    "so2": (IAQI_LEVELS, (0, 50, 150, 475, 800, 1600, 2100, 2620)),
    "co": (IAQI_LEVELS, (0, 2, 4, 14, 24, 36, 48, 60)),
}

# 国标用 mg/m³、上游给 μg/m³ 的换算系数（其余污染物都是 1）。
UNIT_SCALE_TO_STANDARD: Dict[str, float] = {"co": 0.001}

# 各污染物的统计口径（小时数）。O3 取 8 小时，其余取 24 小时。
AVERAGING_HOURS: Dict[str, int] = {
    "pm25": 24,
    "pm10": 24,
    "o3": 8,
    "no2": 24,
    "so2": 24,
    "co": 24,
}

# AQI 分级带：(上界, 分级编号, 中文名)。上界含端点。
# 与 HJ 633-2012 的六档一致，也与前端的 ``aqiGradeOf()`` 保持同一套分档。
AQI_LEVEL_BANDS: Tuple[Tuple[float, int, str], ...] = (
    (50.0, 1, "优"),
    (100.0, 2, "良"),
    (150.0, 3, "轻度污染"),
    (200.0, 4, "中度污染"),
    (300.0, 5, "重度污染"),
    (math.inf, 6, "严重污染"),
)


def to_standard_unit(pollutant: str, concentration: float) -> float:
    """把上游单位（μg/m³）换算成国标单位。"""
    return concentration * UNIT_SCALE_TO_STANDARD.get(pollutant, 1.0)


def iaqi(pollutant: str, concentration: Optional[float]) -> Optional[float]:
    """污染物浓度 → IAQI。

    ``concentration`` 一律用**上游单位 μg/m³**（CO 的 mg/m³ 换算在内部做）。
    数字字符串也会被转换（``float()`` 能解析的都算数）；
    污染物不认识、浓度是 ``None`` / 布尔 / 非数字 / 负数 / NaN / 无穷 → 返回 ``None``。
    """
    if pollutant not in BREAKPOINTS:
        return None
    if concentration is None or isinstance(concentration, bool):
        return None
    try:
        raw = float(concentration)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(raw) or raw < 0:
        return None

    levels, limits = BREAKPOINTS[pollutant]
    value = to_standard_unit(pollutant, raw)
    if value <= limits[0]:
        return float(levels[0])

    for index in range(1, len(limits)):
        lower_c = limits[index - 1]
        upper_c = limits[index]
        if value <= upper_c:
            lower_i = levels[index - 1]
            upper_i = levels[index]
            span = upper_c - lower_c
            if span <= 0:
                return float(upper_i)
            ratio = (upper_i - lower_i) / span
            return (value - lower_c) * ratio + lower_i

    # 超出最高一段：按最高一段处理。
    return float(levels[-1])


def aqi_from_pollutants(concentrations: Mapping[str, Optional[float]]) -> Optional[int]:
    """一组污染物浓度 → AQI（各污染物 IAQI 的最大值，取整）。

    ``concentrations`` 的键是 ``pm25`` / ``pm10`` / ``o3`` / ``no2`` /
    ``so2`` / ``co``，值是 μg/m³。全部取不到 → 返回 ``None``。
    """
    best: Optional[float] = None
    for pollutant in BREAKPOINTS:
        value = iaqi(pollutant, concentrations.get(pollutant))
        if value is None:
            continue
        if best is None or value > best:
            best = value
    if best is None:
        return None
    return int(round(min(best, 500.0)))


def aqi_level(value: Optional[float]) -> Optional[Tuple[int, str]]:
    """AQI 数值 → ``(分级编号, 中文名)``。取不到或不是数字时返回 ``None``。

    按国标 HJ 633-2012 换算，与前端 ``aqiGradeOf()`` 的六档一致。
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


def level_bands() -> Sequence[Tuple[float, int, str]]:
    """AQI 分级带（给需要自己遍历的调用方用）。"""
    return AQI_LEVEL_BANDS
