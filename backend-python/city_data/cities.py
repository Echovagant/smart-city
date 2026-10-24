"""城市表 —— 本地静态快照（参数校验不依赖网络）。

为什么需要这张静态表
--------------------
``GET /api/city/overview`` 要求 ``city`` 必须是**表里存在的城市 id**，
否则返回 400。这张表是**静态快照**，不联网就能校验 ——
否则「上游挂了」会变成「端点 400」，与「端点永不 500」的硬要求冲突。

表里存什么
----------
- ``id``：城市标识（URL 里的 ``?city=`` 取这个）。
- ``latitude`` / ``longitude``：**取数点**。指标源按它取数；
  同时它就是场景的城心参考点（前端 ``cityConfig.center`` 用同一组坐标）。
- ``timezone``：给指标源用（open-meteo 的 ``timezone`` 参数），
  让「本地日」边界与当地日历一致。

**不存什么**：不存任何指标数值。数值由各个源自己取，
取不到就是 ``value = null`` + ``degraded``，不许在这里预置一个占位数字。

已知边界
--------
- 这是一张**手工维护**的表。表里没有的城市 id 会被判为未知（保守的假阴性）。
- 坐标是**取数点**，不是城市行政中心，也不是数据范围中心。
  两者在本项目里刻意分开（见 ``city_data/events.py`` 的说明）。
"""
from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass(frozen=True)
class City:
    """一个城市。字段全部是只读的事实，不含任何指标数值。"""

    id: str
    name: str
    latitude: float
    longitude: float
    timezone: str

    def as_payload(self) -> Dict[str, Any]:
        """响应里 ``city`` 字段的形状。

        ``id`` 是稳定的字符串标识（不是数字代码）——
        数字代码表已经被换掉，现在的身份就是这张表里的 slug。
        """
        return {
            "id": self.id,
            "name": self.name,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "timezone": self.timezone,
        }


# 本项目当前支持的城市。取数点落在 Eixample 街区腹地，
# 圣家堂（41.4036, 2.1744）落在取景范围的北侧。
#
# 这个坐标同时是三件事，**刻意取同一个值**：
# - 指标源的取数点（open-meteo 按它取数）；
# - 前端 ``cityConfig.center``（相机绕行中心）；
# - 全市级事件光柱的落点。
#
# 选它的原因不是「好看」，而是**实测**：这个点在 Eixample 的一处开口，
# 离最近的建筑边界 24.6 m（站在露天，不是站在某栋楼的屋顶上）。
# 之前取的那个点落在两栋楼的里面 —— 光柱会有一截插在建筑里。
CITIES: Dict[str, City] = {
    "barcelona": City(
        id="barcelona",
        name="巴塞罗那",
        latitude=41.39585,
        longitude=2.1652,
        timezone="Europe/Madrid",
    ),
    # 米兰：取数点落在大教堂与老城之间。建筑密度只有巴塞罗那的 1/4
    # （那一带的建筑是一整个街区的体量，不是逐栋），街区形态完全不同。
    # ⚠️ 米兰的经度是 **9.19**（不是 2.19 —— 那是巴塞罗那的）。
    "milano": City(
        id="milano",
        name="米兰",
        latitude=45.4642,
        longitude=9.1919,
        timezone="Europe/Rome",
    ),
}

# 不传 city 参数时用它。
DEFAULT_CITY_ID = "barcelona"


def get_city(city_id: str) -> Optional[City]:
    """按 id 取城市。未知 id 返回 ``None``（不是抛异常）。"""
    if not isinstance(city_id, str):
        return None
    return CITIES.get(city_id.strip().lower())


def is_known_city(city_id: str) -> bool:
    """城市 id 是否在表里。"""
    return get_city(city_id) is not None


def known_city_ids() -> list:
    """表里所有城市 id（排序后）。给错误文案用。"""
    return sorted(CITIES)
