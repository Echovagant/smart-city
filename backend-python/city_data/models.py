"""城市运行指标的 Pydantic 契约。

这个文件是**契约**，不是随手写的数据结构：
前端 `Data-driven-modeling/types/city.ts` 里的同名类型必须逐字段对上。
两端没有共享 schema 文件（见 CLAUDE.md「没有共享包、schema 文件或生成的客户端」），
所以改契约要同时改两边。

四条不可让步的规则
------------------
1. **每个 Metric 都带 source** —— 没有来源标注的数字不许出现在响应里。
2. **模型估算必须 source.estimated = true** —— 实测与估算必须可区分。
3. **取不到就写 null 并进 degraded** —— 不许用 0 或旧值冒充。
4. **observed_at 与 fetched_at 不许混用** —— 前者是上游数据自身的时间戳，
   后者是我们取到它的时间；缓存命中时 fetched_at 仍是**首次**取数的时间。
"""
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

from pydantic import BaseModel, Field

# 指标值可以是数字（AQI、路网长度、指数），也可以是字符串（质量等级文本）。
MetricValue = Union[int, float, str, None]


class SourceInfo(BaseModel):
    """一个指标的数据来源。

    四个标记字段各有明确分工：

    - ``name``：来源名（前端直接显示在指标带上，例如「中国环境监测总站」）。
    - ``url``：真实取数地址。本地文件用仓库相对路径。
    - ``observed_at``：上游**数据自身**的时间戳。上游没取到时是 ``None`` ——
      不知道就是不知道，不填假时间。
    - ``fetched_at``：我们**取到**它的时间。缓存命中时它仍是首次取数的时间，
      这样「数据有多旧」才看得出来。
    - ``realtime``：这份数据此刻还成立吗。上游时间戳与当前时间差太大时是 false。
    - ``estimated``：这是**模型估算**吗。模型估算必须为 true。
    """

    name: str
    url: str
    observed_at: Optional[str] = None
    fetched_at: str
    realtime: bool = False
    estimated: bool = False


class Metric(BaseModel):
    """一个指标。

    ``value`` 为 ``None`` 表示「这个源没取到」——
    前端据此显示「数据源暂不可用」，**不会**拿 0 冒充。
    """

    key: str
    label: str
    value: MetricValue = None
    unit: str = ""
    level: Optional[int] = None
    level_label: Optional[str] = None
    extra: Dict[str, Any] = Field(default_factory=dict)
    source: SourceInfo


class SeriesPoint(BaseModel):
    """时间序列上的一个点。``v`` 为 None 表示那一刻没有值。"""

    t: str
    v: Optional[float] = None


class Series(BaseModel):
    """一条时间序列（例如 24 小时 AQI）。"""

    key: str
    label: str
    unit: str = ""
    points: List[SeriesPoint] = Field(default_factory=list)
    source: SourceInfo


class FacilityCategory(BaseModel):
    """一个设施分类的计数。

    分类规则**只写在后端**（``city_data/sources/facilities.py``）：后端返回
    分类定义 + 计数，前端只渲染。将来要「哪些建筑属于某分类」时，
    在同一处追加成员 id 列表即可，前端按 id 匹配。

    - ``key``：分类标识（``medical`` / ``public_safety`` / …）。
    - ``label``：中文名。
    - ``count``：命中该分类的建筑数。
    - ``criteria``：依据的 OSM 标签（例如 ``["building=hospital"]``）。
    - ``source``：**每个分类都要带来源** —— 没有来源的计数不许出现在响应里。
    """

    key: str
    label: str
    count: int
    criteria: List[str] = Field(default_factory=list)
    source: SourceInfo


class CityOverview(BaseModel):
    """`GET /api/city/overview` 的响应。

    - ``city``：{code, name, latitude, longitude}。取不到时字段为 None。
    - ``generated_at``：本次响应生成的时间（ISO8601，UTC）。
    - ``metrics``：每个指标都带自己的 source。
    - ``series``：时间序列。
    - ``facilities``：设施分类计数（本地 OSM 快照，实测）。
      取不到时是**空数组**，不许编一个数字顶上。
    - ``degraded``：**取不到的源的名字**。前端据此显示「数据源暂不可用」。
    """

    city: Dict[str, Any] = Field(default_factory=dict)
    generated_at: str
    metrics: List[Metric] = Field(default_factory=list)
    series: List[Series] = Field(default_factory=list)
    facilities: List[FacilityCategory] = Field(default_factory=list)
    degraded: List[str] = Field(default_factory=list)


@dataclass
class SourceResult:
    """单个数据源的取数结果（内部结构，不直接出现在响应里）。"""

    metrics: List[Metric] = field(default_factory=list)
    series: List[Series] = field(default_factory=list)
    # 只有部分源能给出城市信息（目前是空气质量源）；取不到时是 None。
    city: Optional[Dict[str, Any]] = None
    # 设施分类计数（目前只有本地 OSM 快照源能给）。取不到时是空列表。
    facilities: List[FacilityCategory] = field(default_factory=list)


def unavailable_metrics(
    slots: Sequence[Tuple[str, str, str]],
    source_name: str,
    url: str,
    fetched_at: str,
    estimated: bool = False,
) -> List[Metric]:
    """为**降级**的数据源生成占位指标。

    占位指标的 ``value`` 是 ``None``（**不是 0**）：
    前端看到 null 就显示「数据源暂不可用」，
    不会拿一个 0 或者上一次的旧值冒充这次的真实读数。

    ``slots`` 是 ``(key, label, unit)`` 三元组 —— 声明这个源正常情况下
    会提供哪几个指标，降级时就在同样的位置放占位。

    ``estimated`` 描述这个源**本来**提供的指标是什么性质
    （路网负载本来就是模型估算，它的占位也要标 estimated）。
    """
    source = SourceInfo(
        name=source_name,
        url=url,
        observed_at=None,
        fetched_at=fetched_at,
        realtime=False,
        estimated=estimated,
    )
    return [
        Metric(key=key, label=label, value=None, unit=unit, source=source)
        for key, label, unit in slots
    ]
