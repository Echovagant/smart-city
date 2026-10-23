"""城市运行指标的 Pydantic 契约。

这个文件是**契约**，不是随手写的数据结构：
前端 `Data-driven-modeling/types/city.ts` 里的同名类型必须逐字段对上。
两端没有共享 schema 文件（见 docs/ARCHITECTURE.md「没有共享包、schema 文件或生成的客户端」），
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
from typing import Any, Dict, List, Literal, Optional, Sequence, Tuple, Union

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
    - ``members``：该分类下建筑的 **OSM id**（形如 ``relation/3464247``）。
      场景联动（页签切换时高亮某类建筑）按 id 匹配，**前端不重新实现分类规则**。
      没有成员时是**空数组**（不是 None）。
    - ``source``：**每个分类都要带来源** —— 没有来源的计数不许出现在响应里。
    """

    key: str
    label: str
    count: int
    criteria: List[str] = Field(default_factory=list)
    members: List[str] = Field(default_factory=list)
    source: SourceInfo


class EventLocation(BaseModel):
    """事件发生的位置。

    - ``lng`` / ``lat``：WGS-84 经纬度（与场景里画的 OSM 原始坐标同坐标系）。
    - ``label``：人话位置标签（「城市中心」/「主路段（OSM way/41662973）」）。
    """

    lng: float
    lat: float
    label: str


class CityEvent(BaseModel):
    """一条**派生**事件。

    本项目**没有告警系统**：每一条事件都是从真实指标派生出来的，
    派生不出来就是没有事件（空数组），不许编。

    - ``id``：**稳定**的事件标识。同一条事件重复派生时 id 不变 ——
      前端据此去重，轮询不会把同一条事件插进列表好几次。
    - ``type``：事件类型（空气质量 / 天气 / 路网负载）。
    - ``level``：严重度（提示 / 预警 / 告警）。
    - ``title`` / ``detail``：标题与说明。
    - ``time``：事件发生/判定时刻（ISO8601）。
    - ``location_kind``：**这个事件有没有具体空间位置**。
        - ``"city"``：**全市级**事件（空气质量、天气）—— 没有空间位置，
          前端把它落在**城心**（应用里唯一定义的城心：天安门）。
        - ``"geometry"``：**几何锚定**事件（路网负载）——
          ``location`` 是**真实几何**上的点（最长主干道的弧长中点）。
    - ``location``：位置。``location_kind="geometry"`` 时是事件的真实坐标；
      ``location_kind="city"`` 时是**数据范围中心**（后端自己的参考点），
      前端会改用城心 —— 两种 kind 靠 ``location_kind`` 区分，不靠猜。
    - ``metric_key``：指回它依据的那个指标（可追溯）。
    - ``source``：事件依据的那个源的 ``SourceInfo``（不是新造一个），
      于是「取数时刻 / 观测时刻 / 是否估算」与指标完全一致。
    - ``estimated``：这是**模型估算**派生的吗（路网负载是）。
    """

    id: str
    type: Literal["air_quality", "weather", "road_load"]
    level: Literal["info", "warn", "alert"]
    title: str
    detail: str = ""
    time: str
    location_kind: Literal["city", "geometry"]
    location: EventLocation
    metric_key: str
    source: SourceInfo
    estimated: bool = False


@dataclass
class RoadAnchor:
    """一条真实道路上的锚点（内部结构，不出现在响应里）。

    规则 3（路网负载超阈）的事件位置必须落在**真实几何**上，
    不许用城心假装是路段。这个锚点由本地 OSM 快照算出：
    等级最高且最长的一条线段的中点。
    """

    lng: float
    lat: float
    label: str



class CityOverview(BaseModel):
    """`GET /api/city/overview` 的响应。

    - ``city``：{code, name, latitude, longitude}。取不到时字段为 None。
    - ``generated_at``：本次响应生成的时间（ISO8601，UTC）。
    - ``metrics``：每个指标都带自己的 source。
    - ``series``：时间序列。
    - ``facilities``：设施分类计数（本地 OSM 快照，实测）。
      取不到时是**空数组**，不许编一个数字顶上。
    - ``events``：**派生**事件流。每条都带 source + metric_key + time。
      派生不出来就是**空数组** —— 空事件流是数据现实，不是故障。
    - ``degraded``：**取不到的源的名字**。前端据此显示「数据源暂不可用」。
    """

    city: Dict[str, Any] = Field(default_factory=dict)
    generated_at: str
    metrics: List[Metric] = Field(default_factory=list)
    series: List[Series] = Field(default_factory=list)
    facilities: List[FacilityCategory] = Field(default_factory=list)
    events: List[CityEvent] = Field(default_factory=list)
    degraded: List[str] = Field(default_factory=list)


class AreaStats(BaseModel):
    """`GET /api/city/area` 的响应：一片矩形范围内的空间统计。

    - ``bbox``：回显规范化后的四个数（min_lon, min_lat, max_lon, max_lat）。
    - ``area_km2``：该范围的近似面积（km²）。
    - ``building_count``：范围内的建筑要素数。
    - ``road_count``：范围内的道路要素数（**含**广场、人造地面这类面要素）。
    - ``road_length_km``：路网总长（km）—— **只有线要素计入长度**。
    - ``road_length_by_tier_km``：按等级分解（主干道 / 次干道 / 支路 / 人行道 / 其他）。
    - ``facility_counts``：设施分类计数（键与 ``facilities.FACILITY_CATEGORIES`` 一致）。
    - ``facility_categories``：同一份计数的带标签版本（分类名 + 判定依据 + 各自来源）。
    - ``building_density_per_km2``：建筑密度（栋 / km²）。
    - ``source``：**所有数字的来源**。全部来自本地 OSM 快照，``estimated = false``。
    - ``method``：**算法口径**。路网长度与面积都是几何折算出来的，
      口径写在这里，与 ``city_data/sources/road_network.py`` 保持一致。

    空范围（bbox 里没有任何要素）是**正常结果**：数字是 0，不是故障。
    """

    bbox: List[float] = Field(default_factory=list)
    area_km2: float = 0.0
    building_count: int = 0
    road_count: int = 0
    road_length_km: float = 0.0
    road_length_by_tier_km: Dict[str, float] = Field(default_factory=dict)
    facility_counts: Dict[str, int] = Field(default_factory=dict)
    facility_categories: List[FacilityCategory] = Field(default_factory=list)
    building_density_per_km2: float = 0.0
    source: SourceInfo
    method: Dict[str, Any] = Field(default_factory=dict)


@dataclass
class SourceResult:
    """单个数据源的取数结果（内部结构，不直接出现在响应里）。"""

    metrics: List[Metric] = field(default_factory=list)
    series: List[Series] = field(default_factory=list)
    # 只有部分源能给出城市信息（目前是空气质量源）；取不到时是 None。
    city: Optional[Dict[str, Any]] = None
    # 设施分类计数（目前只有本地 OSM 快照源能给）。取不到时是空列表。
    facilities: List[FacilityCategory] = field(default_factory=list)
    # 场景里的「城市中心」（本地 OSM 快照的围中心）。取不到时是 None。
    scene_center: Optional[EventLocation] = None
    # 最长主干道的中点（规则 3 的事件位置）。取不到时是 None。
    road_anchor: Optional[RoadAnchor] = None


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
