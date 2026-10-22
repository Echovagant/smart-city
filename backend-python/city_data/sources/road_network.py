"""路网静态指标 —— **不联网**，读本地 OSM 抽取数据自己算。

这里产出两类东西，**必须分清楚**：

**实测指标**（``estimated: false``）
    建筑总数、道路总数、路网总长、数据覆盖面积、各等级道路条数。
    全部是对 ``backend-python/geojson/*.geojson`` 的直接统计或几何计算，
    没有猜测成分。

**模型估算指标**（``estimated: true``）
    ``road_load_index``（路网负载指数）。
    它是**静态几何折算**出来的「供给紧张度」，
    **不含任何实时车流或路况观测**，不能当作实时路况读数。
    口径写在指标的 ``extra`` 里，前端会显示「（模型估算）」。

几何换算口径
------------
GeoJSON 的坐标是 WGS-84 经纬度。用等距圆柱近似换算成米：

- 每纬度一度的长度 = ``R * π/180``（R = 6371008.8 m）；
- 每经度一度的长度 = 上面这个值 × ``cos(纬度)``；
- 线段长度 = ``hypot(dx * m_per_deg_lon, dy * m_per_deg_lat)``，
  经度方向按**线段中点纬度**取值。

在本项目的数据范围（天安门一带约 4.5 km × 3.7 km）内，这个近似的
相对误差远小于 1%，足够做路网规模统计。
"""
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from ..models import Metric, SourceInfo, SourceResult

# 数据目录：默认在 backend-python/geojson/。
# 上层（main.py）会把实际使用的文件路径传进来，避免两处路径漂移。
BACKEND_DIR = Path(__file__).resolve().parent.parent.parent
GEOJSON_DIR = BACKEND_DIR / "geojson"
DEFAULT_BUILDINGS_PATH = GEOJSON_DIR / "buildings.geojson"
DEFAULT_ROADS_PATH = GEOJSON_DIR / "roads.geojson"

SOURCE_NAME = "本地 OSM 路网数据"

# 降级时占位指标的槽位（路网负载那一格）。
SLOTS = (("road_load_index", "路网负载（模型估算）", "指数"),)

# 道路分级表 —— **必须与前端 SmartCity.vue 的 roadTiers 保持一致**，
# 否则「画出来的路」与「统计出来的路」会对不上。
ROAD_TIERS: Tuple[Tuple[str, str, Tuple[str, ...]], ...] = (
    ("main", "主干道", ("motorway", "trunk", "primary")),
    ("secondary", "次干道", ("secondary", "tertiary")),
    ("local", "支路", ("residential", "unclassified", "service")),
    ("footway", "人行道/步行区", ("footway", "pedestrian", "steps", "path", "cycleway")),
)
TIER_OTHER = "other"

# 路网负载指数的参考阈值：每公里路网承载 30 栋建筑即视为供给完全饱和（指数封顶 100）。
REFERENCE_BUILDINGS_PER_KM = 30.0

# 球面半径（米）与每度长度。
EARTH_RADIUS_M = 6371008.8
METERS_PER_DEGREE_LAT = EARTH_RADIUS_M * math.pi / 180.0


def now_iso() -> str:
    """当前时间（ISO8601，UTC，秒精度）。"""
    return (
        datetime.now(tz=timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def tier_of(highway: Any) -> str:
    """按 OSM 的 ``highway`` 标签判定道路等级。

    与前端的 ``resolveRoadTier`` 同口径：不在分级表里的一律落到「其他」。
    """
    if not isinstance(highway, str):
        return TIER_OTHER
    tag = highway.strip().lower()
    for key, _label, tags in ROAD_TIERS:
        if tag in tags:
            return key
    return TIER_OTHER


def _positions(geometry: Dict[str, Any]) -> Iterable[Tuple[float, float]]:
    """遍历一个几何里的全部坐标点。"""
    kind = geometry.get("type")
    coordinates = geometry.get("coordinates") or []
    if kind == "Point":
        yield coordinates[0], coordinates[1]
    elif kind == "LineString":
        for point in coordinates:
            yield point[0], point[1]
    elif kind == "Polygon":
        for ring in coordinates:
            for point in ring:
                yield point[0], point[1]
    elif kind == "MultiPolygon":
        for polygon in coordinates:
            for ring in polygon:
                for point in ring:
                    yield point[0], point[1]


def segment_length_m(
    start: Tuple[float, float], end: Tuple[float, float]
) -> float:
    """两点之间的近似距离（米）。经度方向按中点纬度缩放。"""
    lon1, lat1 = start
    lon2, lat2 = end
    mid_lat = (lat1 + lat2) / 2.0
    meters_per_degree_lon = METERS_PER_DEGREE_LAT * math.cos(mid_lat * math.pi / 180.0)
    dx = (lon2 - lon1) * meters_per_degree_lon
    dy = (lat2 - lat1) * METERS_PER_DEGREE_LAT
    return math.hypot(dx, dy)


def polyline_length_m(coordinates: List[Any]) -> float:
    """折线的近似长度（米）。"""
    points = [(p[0], p[1]) for p in coordinates if isinstance(p, (list, tuple)) and len(p) >= 2]
    return sum(
        segment_length_m(points[index], points[index + 1])
        for index in range(len(points) - 1)
    )


def bbox_of(features: List[Dict[str, Any]]) -> Optional[Tuple[float, float, float, float]]:
    """所有要素的经纬度范围。"""
    west = south = math.inf
    east = north = -math.inf
    for feature in features:
        geometry = feature.get("geometry") or {}
        for lon, lat in _positions(geometry):
            if not (math.isfinite(lon) and math.isfinite(lat)):
                continue
            west = min(west, lon)
            east = max(east, lon)
            south = min(south, lat)
            north = max(north, lat)
    if not (math.isfinite(west) and math.isfinite(south)):
        return None
    return west, south, east, north


def area_km2(bbox: Tuple[float, float, float, float]) -> float:
    """bbox 的近似面积（km²）。"""
    west, south, east, north = bbox
    mid_lat = (south + north) / 2.0
    width_m = (east - west) * METERS_PER_DEGREE_LAT * math.cos(mid_lat * math.pi / 180.0)
    height_m = (north - south) * METERS_PER_DEGREE_LAT
    return width_m * height_m / 1_000_000.0


def load_geojson(path: Path) -> Dict[str, Any]:
    """读一个 GeoJSON 文件。读不了就抛异常（上层会把它算作降级）。"""
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def compute_load_index(building_count: int, road_length_km: float) -> Tuple[float, Dict[str, Any]]:
    """路网负载指数（**模型估算**）。

    口径：``每公里路网承载的建筑数`` = 建筑数 ÷ 路网总长(km)，
    再除以参考阈值 30 栋/km，归一到 0–100。

    它的含义是「静态供给紧张度」：同样多的建筑，摊在更长的路网上，
    指数更低。**它不含任何实时车流/路况观测**，
    也**不是**实测的路况 —— 所以指标上带 ``estimated: true``，
    标签里带「（模型估算）」。

    返回 ``(指数, 口径说明)``。
    """
    if road_length_km <= 0:
        return 0.0, {
            "method": "路网负载指数（模型估算）：建筑数 ÷ 路网总长(km) → 每公里路网承载建筑数，"
            "再除以参考阈值后归一到 0–100。",
            "formula": "index = 100 * min(1, (buildings / road_length_km) / reference)",
            "inputs": {
                "buildings": building_count,
                "road_length_km": round(road_length_km, 4),
                "reference_buildings_per_km": REFERENCE_BUILDINGS_PER_KM,
            },
            "caveat": "静态几何折算的供给紧张度，不含任何实时车流/路况观测，不能当作实时路况读数。",
        }

    per_km = building_count / road_length_km
    index = round(100.0 * min(1.0, per_km / REFERENCE_BUILDINGS_PER_KM), 1)
    return index, {
        "method": "路网负载指数（模型估算）：建筑数 ÷ 路网总长(km) → 每公里路网承载建筑数，"
        "再除以参考阈值后归一到 0–100。",
        "formula": "index = 100 * min(1, (buildings / road_length_km) / reference)",
        "inputs": {
            "buildings": building_count,
            "road_length_km": round(road_length_km, 4),
            "buildings_per_km_road": round(per_km, 4),
            "reference_buildings_per_km": REFERENCE_BUILDINGS_PER_KM,
        },
        "caveat": "静态几何折算的供给紧张度，不含任何实时车流/路况观测，不能当作实时路况读数。",
    }


def fetch(
    buildings_path: Optional[Path] = None,
    roads_path: Optional[Path] = None,
) -> SourceResult:
    """统计本地路网数据，产出静态指标。

    读不到文件就抛异常（上层会把它算作降级，端点仍然 200）。
    """
    buildings_file = Path(buildings_path or DEFAULT_BUILDINGS_PATH)
    roads_file = Path(roads_path or DEFAULT_ROADS_PATH)

    buildings_data = load_geojson(buildings_file)
    roads_data = load_geojson(roads_file)
    building_features = buildings_data.get("features") or []
    road_features = roads_data.get("features") or []

    fetched_at = now_iso()
    observed_at = roads_data.get("timestamp") or buildings_data.get("timestamp")
    # 仓库相对路径：不回显服务端绝对路径。
    roads_ref = "backend-python/geojson/roads.geojson"
    buildings_ref = "backend-python/geojson/buildings.geojson"

    measured = SourceInfo(
        name=SOURCE_NAME,
        url=roads_ref,
        observed_at=observed_at,
        fetched_at=fetched_at,
        realtime=False,
        estimated=False,
    )

    # 道路统计：线要素算长度，面要素（广场、人造地面）只计数不算长度。
    line_features = 0
    area_features = 0
    total_length_m = 0.0
    tier_counts: Dict[str, int] = {key: 0 for key, _label, _tags in ROAD_TIERS}
    tier_counts[TIER_OTHER] = 0
    for feature in road_features:
        geometry = feature.get("geometry") or {}
        properties = feature.get("properties") or {}
        if geometry.get("type") == "LineString":
            line_features += 1
            total_length_m += polyline_length_m(geometry.get("coordinates") or [])
            tier_counts[tier_of(properties.get("highway"))] += 1
        else:
            area_features += 1

    road_length_km = total_length_m / 1000.0
    bbox = bbox_of(building_features + road_features)
    coverage_area = area_km2(bbox) if bbox else None

    metrics: List[Metric] = [
        Metric(
            key="building_count",
            label="建筑总数",
            value=len(building_features),
            unit="栋",
            extra={"file": buildings_ref, "observed_at": buildings_data.get("timestamp")},
            source=measured,
        ),
        Metric(
            key="road_count",
            label="道路总数",
            value=len(road_features),
            unit="条",
            extra={
                "file": roads_ref,
                "line_features": line_features,
                "area_features": area_features,
                "note": "面要素是广场与人工地面，只有线要素计入路网总长。",
            },
            source=measured,
        ),
        Metric(
            key="road_length_km",
            label="路网总长",
            value=round(road_length_km, 3),
            unit="km",
            extra={
                "method": "等距圆柱近似：经度方向按线段中点纬度缩放（米/度 = R·π/180·cos φ）。",
                "line_features": line_features,
            },
            source=measured,
        ),
    ]

    if coverage_area is not None:
        metrics.append(
            Metric(
                key="coverage_area_km2",
                label="数据覆盖面积",
                value=round(coverage_area, 4),
                unit="km²",
                extra={"bbox": list(bbox) if bbox else None},
                source=measured,
            )
        )

    tier_labels = {key: label for key, label, _tags in ROAD_TIERS}
    tier_labels[TIER_OTHER] = "其他道路"
    for key, _label, _tags in ROAD_TIERS:
        metrics.append(
            Metric(
                key="road_count_" + key,
                label="道路数 · " + tier_labels[key],
                value=tier_counts[key],
                unit="条",
                extra={"tier": key},
                source=measured,
            )
        )
    metrics.append(
        Metric(
            key="road_count_other",
            label="道路数 · 其他道路",
            value=tier_counts[TIER_OTHER],
            unit="条",
            extra={"tier": TIER_OTHER},
            source=measured,
        )
    )

    load_index, load_extra = compute_load_index(len(building_features), road_length_km)
    estimated_source = measured.model_copy(update={"estimated": True, "url": roads_ref})
    metrics.append(
        Metric(
            key="road_load_index",
            label="路网负载（模型估算）",
            value=load_index,
            unit="指数",
            extra=load_extra,
            source=estimated_source,
        )
    )

    return SourceResult(metrics=metrics, series=[])
