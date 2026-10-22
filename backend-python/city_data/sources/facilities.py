"""设施分类 —— **不联网**，读本地 OSM 建筑抽取数据自己分类计数。

分类规则**只写这一处**（计划书 §1.3）：后端返回分类定义 + 计数，前端只渲染。
将来要「哪些建筑属于某分类」时，在同一处追加成员 id 列表即可，前端按 id 匹配。

口径
----
- **一个建筑只归一类**：按 :data:`FACILITY_CATEGORIES` 的顺序取**第一个命中**的分类
  （``medical`` 最先）。环形图要能对上账，所以不许重复计数 ——
  一栋既是 ``building=hospital`` 又是 ``historic=yes`` 的楼，只算医疗设施。
- 标签取自 ``feature.properties``，形如 ``{"building": "hospital"}``；
  ``historic=yes`` 这类「布尔型」取值在 OSM 里也是字符串 ``"yes"``，一样能命中。
- 每个分类都带 ``criteria``（依据的 OSM 标签），前端据此显示「依据 OSM 标签统计」。

**实测，不是估算**：这是对本地 OSM 快照的直接计数，
所以 ``source.estimated = false``；``observed_at`` 取自 geojson 顶层的
``timestamp``（OSM 抽取时间），``realtime`` 为 false（静态快照不会自己变新）。

读不到文件就抛异常（上层会把它算作降级，端点仍然 200，
``facilities`` 是空数组 —— **不许编一个数字顶上**）。
"""
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..models import FacilityCategory, Metric, SourceInfo, SourceResult
from .road_network import DEFAULT_BUILDINGS_PATH, load_geojson, now_iso

SOURCE_NAME = "OpenStreetMap 本地快照"

# 仓库相对路径：不回显服务端绝对路径。
BUILDINGS_REF = "backend-python/geojson/buildings.geojson"

# 降级时占位指标的槽位（设施分类总数那一格）。
SLOTS = (("facility_total", "设施分类总数", "处"),)

# 分类规则表 —— **顺序即优先级**：第一个命中的分类生效（一个建筑只归一类）。
#
# 每条规则是一组 ``(标签名, 标签值)``。注释里写清依据的是哪个 OSM 标签，
# 前端会把这份清单原样显示出来（「依据 OSM 标签统计」）。
FACILITY_CATEGORIES: Tuple[Tuple[str, str, Tuple[Tuple[str, str], ...]], ...] = (
    (
        "medical",
        "医疗设施",
        (
            ("building", "hospital"),
        ),
    ),
    (
        "public_safety",
        "公共安全设施",
        (
            ("amenity", "police"),
            ("amenity", "fire_station"),
            ("building", "guardhouse"),
            ("amenity", "shelter"),
        ),
    ),
    (
        "education",
        "教育设施",
        (
            ("building", "school"),
            ("building", "university"),
            ("building", "kindergarten"),
            ("amenity", "college"),
        ),
    ),
    (
        "heritage",
        "历史建筑",
        (
            ("historic", "city_gate"),
            ("historic", "palace"),
            ("historic", "temple"),
            ("historic", "building"),
            ("historic", "yes"),
            ("historic", "monastery"),
        ),
    ),
    (
        "commerce",
        "商业与办公",
        (
            ("building", "commercial"),
            ("building", "retail"),
            ("building", "office"),
            ("building", "hotel"),
            ("shop", "mall"),
            ("office", "government"),
        ),
    ),
)


def criteria_of(key: str) -> List[str]:
    """某个分类依据的 OSM 标签清单（形如 ``building=hospital``）。"""
    for category_key, _label, rules in FACILITY_CATEGORIES:
        if category_key == key:
            return ["%s=%s" % (tag_key, tag_value) for tag_key, tag_value in rules]
    return []


def _tag_matches(properties: Dict[str, Any], tag_key: str, tag_value: str) -> bool:
    """一个标签是否命中。值按字符串比较（大小写不敏感）。

    OSM 的标签值一律是字符串（``historic=yes`` 的值就是 ``"yes"``），
    这里统一 ``str()`` 之后比较，数值型取值也不会误伤。
    """
    raw = properties.get(tag_key)
    if raw is None:
        return False
    return str(raw).strip().lower() == tag_value


def classify(properties: Optional[Dict[str, Any]]) -> Optional[str]:
    """判定一栋建筑属于哪个分类。不属于任何分类时返回 ``None``。"""
    if not isinstance(properties, dict):
        return None
    for key, _label, rules in FACILITY_CATEGORIES:
        for tag_key, tag_value in rules:
            if _tag_matches(properties, tag_key, tag_value):
                return key
    return None


def count_by_category(features: List[Dict[str, Any]]) -> Dict[str, int]:
    """按分类统计建筑数（**去重后**：一栋楼只进一个分类）。"""
    counts: Dict[str, int] = {key: 0 for key, _label, _rules in FACILITY_CATEGORIES}
    for feature in features:
        if not isinstance(feature, dict):
            continue
        key = classify(feature.get("properties"))
        if key is not None:
            counts[key] += 1
    return counts


def members_by_category(features: List[Dict[str, Any]]) -> Dict[str, List[str]]:
    """每个分类下建筑的 **OSM id** 列表。

    场景联动（页签切换时高亮某类建筑）靠它 —— 前端按 id 匹配，
    **不重新实现分类规则**（规则只写这一处）。

    id 形如 ``relation/3464247``（来自 OSM 要素的 ``id`` 字段）。
    没有 id 的要素进不了列表（前端无从匹配）；分类计数里仍然算数，
    所以 ``count`` 与 ``len(members)`` 可能不等 —— 这是事实，不许凑数。
    """
    members: Dict[str, List[str]] = {
        key: [] for key, _label, _rules in FACILITY_CATEGORIES
    }
    for feature in features:
        if not isinstance(feature, dict):
            continue
        key = classify(feature.get("properties"))
        if key is None:
            continue
        feature_id = feature.get("id")
        if feature_id is None:
            continue
        members[key].append(str(feature_id))
    return members


def fetch(buildings_path: Optional[Path] = None) -> SourceResult:
    """统计本地建筑数据里的设施分类，产出分类计数 + 总数指标。

    读不到文件就抛异常（上层会把它算作降级，端点仍然 200）。
    """
    path = Path(buildings_path or DEFAULT_BUILDINGS_PATH)
    data = load_geojson(path)
    features = data.get("features") or []
    counts = count_by_category(features)
    members = members_by_category(features)

    observed_at = data.get("timestamp")
    source = SourceInfo(
        name=SOURCE_NAME,
        url=BUILDINGS_REF,
        observed_at=observed_at if isinstance(observed_at, str) else None,
        fetched_at=now_iso(),
        realtime=False,
        # 实测计数，不是模型估算。
        estimated=False,
    )

    facilities = [
        FacilityCategory(
            key=key,
            label=label,
            count=counts[key],
            criteria=criteria_of(key),
            members=members.get(key, []),
            source=source,
        )
        for key, label, _rules in FACILITY_CATEGORIES
    ]

    total = sum(counts.values())
    metrics = [
        Metric(
            key="facility_total",
            label="设施分类总数",
            value=total,
            unit="处",
            extra={
                "file": BUILDINGS_REF,
                "observed_at": observed_at,
                "note": "按 OSM 标签统计；一个建筑只归一类（分类规则见 city_data/sources/facilities.py）。",
                "counts": {key: counts[key] for key, _label, _rules in FACILITY_CATEGORIES},
            },
            source=source,
        )
    ]
    return SourceResult(metrics=metrics, series=[], facilities=facilities)
