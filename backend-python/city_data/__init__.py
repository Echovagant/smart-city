"""城市运行指标数据层（Plan S1）。

把**真实公开数据**聚合成一份带来源标注与时间戳的统一契约：

- ``models``      —— Pydantic 契约（每个指标都必须带 source）；
- ``http``        —— 只用标准库的 JSON 取数封装；
- ``city_codes``  —— cnemc 城市/省份代码表快照（静态，用于参数校验）；
- ``sources/*``   —— 一个源一个模块（空气质量 / 天气 / 本地路网）；
- ``aggregator``  —— 并发取数 + 缓存 + 降级。

这里**不**从包顶层导出 aggregator，避免 ``sources`` 反过来 import 包顶层时
形成循环导入。需要聚合器就 ``from city_data import aggregator``。
"""
from .models import (
    CityOverview,
    Metric,
    Series,
    SeriesPoint,
    SourceInfo,
    SourceResult,
)

__all__ = [
    "CityOverview",
    "Metric",
    "Series",
    "SeriesPoint",
    "SourceInfo",
    "SourceResult",
]
