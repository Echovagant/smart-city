"""按 bbox 聚合的空间统计 —— **纯函数模块**（不联网、不碰 I/O）。

这个模块回答一个问题：**「这一片范围里有多少栋楼？路网有多长？有哪些设施？」**

口径全部**复用**现成实现，不另写一套（一个项目里出现两套算法就会算出两个数）：

- 面积：``road_network.area_km2``（等距圆柱近似，按中点纬度换算）；
- 路网长度：``road_network.polyline_length_m``；
- 道路分级：``road_network.tier_of`` + ``road_network.ROAD_TIERS``；
- 设施分类：``facilities.count_by_category``（内部走 ``facilities.classify``，
  **分类规则只写在** ``facilities.py`` **一处**）。

输入是**过滤后**的要素集合 —— 过滤由 ``main.py`` 用
``data_processor.filter_features_by_bbox`` 完成（并复用它的 LRU 缓存），
所以这里只负责统计，不碰数据文件。
"""
from typing import Any, Dict, List, Optional, Sequence, Tuple

from ..models import AreaStats, FacilityCategory, SourceInfo
from .facilities import (
    FACILITY_CATEGORIES,
    SOURCE_NAME,
    criteria_of,
    count_by_category,
)
from .road_network import (
    ROAD_TIERS,
    TIER_OTHER,
    area_km2,
    now_iso,
    polyline_length_m,
    tier_of,
)

# 仓库相对路径：不回显服务端绝对路径。
GEOJSON_REF = "backend-python/geojson/"
BUILDINGS_REF = "backend-python/geojson/buildings.geojson"
ROADS_REF = "backend-python/geojson/roads.geojson"

# 长度与面积保留 4 位小数（km / km²）。
#
# 等距圆柱近似本身在本项目范围内的相对误差在 1% 量级（范围约 12 km → 误差约 120 m），
# 保留到 0.1 m 已经远低于方法本身的误差。
LENGTH_DECIMALS = 4
AREA_DECIMALS = 4
DENSITY_DECIMALS = 3


def _feature_list(collection: Any) -> List[Dict[str, Any]]:
    """把 FeatureCollection（或要素列表）统一成要素列表。

    过滤结果（``{"type": "FeatureCollection", "features": [...]}``）与
    原始要素列表都收下，调用方不必先拆包。
    """
    if isinstance(collection, dict):
        features = collection.get("features") or []
    elif isinstance(collection, (list, tuple)):
        features = collection
    else:
        return []
    return [feature for feature in features if isinstance(feature, dict)]


def _road_lengths(road_features: List[Dict[str, Any]]) -> Tuple[Dict[str, float], int, int]:
    """按等级分解路网长度（米），并数出线要素与面要素。

    只有线要素计入长度；面要素（广场、人造地面）只计数 ——
    与 ``road_network.fetch`` 的口径一致。
    """
    lengths: Dict[str, float] = {key: 0.0 for key, _label, _tags in ROAD_TIERS}
    lengths[TIER_OTHER] = 0.0
    line_features = 0
    area_features = 0
    for feature in road_features:
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "LineString":
            area_features += 1
            continue
        line_features += 1
        properties = feature.get("properties") or {}
        tier = tier_of(properties.get("highway"))
        lengths[tier] += polyline_length_m(geometry.get("coordinates") or [])
    return lengths, line_features, area_features


def aggregate_area(
    buildings: Any,
    roads: Any,
    bbox: Sequence[float],
    observed_at: Optional[str] = None,
    fetched_at: Optional[str] = None,
    observed_at_by_file: Optional[Dict[str, Any]] = None,
) -> AreaStats:
    """把一片范围里的建筑与道路汇总成一份空间统计。

    参数
    ----
    buildings / roads
        **过滤后**的要素集合（FeatureCollection 或要素列表）。
    bbox
        ``(min_lon, min_lat, max_lon, max_lat)`` —— 四个数。
    observed_at
        数据快照自身的观测时间（geojson 顶层的 ``timestamp``）。
    fetched_at
        取到它的时间；不给就用当前时间。
    observed_at_by_file
        各数据文件自己的观测时间，写进 ``method``，
        让「建筑快照」与「道路快照」之间的时间差可见。

    空范围（一个要素都没有）是**正常结果**：数字是 0，不是故障。
    """
    west, south, east, north = (float(value) for value in bbox)
    bounds = (west, south, east, north)

    building_features = _feature_list(buildings)
    road_features = _feature_list(roads)

    area_value = round(area_km2(bounds), AREA_DECIMALS)

    tier_lengths_m, line_features, area_features = _road_lengths(road_features)
    tier_lengths_km = {
        tier: round(length / 1000.0, LENGTH_DECIMALS)
        for tier, length in tier_lengths_m.items()
    }
    # 总额由各分解项四舍五入后相加得到：前端画分解图时，各段之和与总额必然一致。
    road_length_km = round(sum(tier_lengths_km.values()), LENGTH_DECIMALS)

    counts = count_by_category(building_features)
    facility_counts = {
        key: int(counts.get(key, 0)) for key, _label, _rules in FACILITY_CATEGORIES
    }

    source = SourceInfo(
        name=SOURCE_NAME,
        url=GEOJSON_REF,
        observed_at=observed_at if isinstance(observed_at, str) else None,
        fetched_at=fetched_at or now_iso(),
        realtime=False,
        # 全部来自本地 OSM 快照：要么是直接计数，要么是几何折算，不是模型估算。
        estimated=False,
    )
    facility_categories = [
        FacilityCategory(
            key=key,
            label=label,
            count=facility_counts[key],
            criteria=criteria_of(key),
            members=[],
            source=source,
        )
        for key, label, _rules in FACILITY_CATEGORIES
    ]

    building_count = len(building_features)
    building_density = (
        round(building_count / area_value, DENSITY_DECIMALS) if area_value > 0 else 0.0
    )

    method = {
        "road_length": "等距圆柱近似：经度方向按线段中点纬度缩放（米/度 = R·π/180·cos φ）。"
        "与 city_data/sources/road_network.py 的 road_length_km 同一口径。",
        "area": "范围的近似面积：宽 × 高（按中点纬度换算），"
        "与 road_network.area_km2 同一口径。",
        "density": "building_density_per_km2 = building_count ÷ area_km2（算术导出值，不是估算）。",
        "road_count": "计入全部道路要素；面要素（广场、人造地面）只计数，不计入路网长度。",
        "facility_counts": "按 OSM 标签统计，一个建筑只归一类"
        "（分类规则见 city_data/sources/facilities.py）。",
        "files": [BUILDINGS_REF, ROADS_REF],
        "observed_at": observed_at_by_file or {},
        "line_features": line_features,
        "area_features": area_features,
        "precision": "路网长度与面积保留 4 位小数（km / km²）；"
        "总额由各分解项四舍五入后相加得到，分解项与总额始终对得上账。",
    }

    return AreaStats(
        bbox=[west, south, east, north],
        area_km2=area_value,
        building_count=building_count,
        road_count=len(road_features),
        road_length_km=road_length_km,
        road_length_by_tier_km=tier_lengths_km,
        facility_counts=facility_counts,
        facility_categories=facility_categories,
        building_density_per_km2=building_density,
        source=source,
        method=method,
    )
