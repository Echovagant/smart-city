"""Plan 012 的 OSM 标签处理用例。

覆盖 DataProcessor.calculate_building_statistics：
OSM 的标签值一律是字符串，方法必须在读取边界处把它们转成数字，
否则原来的 `if height > 0` 会直接抛
TypeError: '>' not supported between instances of 'str' and 'int'（已用真实数据复现）。

用例只使用内存里的 FeatureCollection，不依赖磁盘上的 OSM 提取数据
（backend-python/geojson/ 是未纳入版本管理的输入数据）。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from data_processor import DataProcessor  # noqa: E402


def _feature(**props):
    """构造一个只带 properties 的要素（几何对统计方法没有影响）。"""
    return {"type": "Feature", "properties": props}


def _collection(*features):
    return {"type": "FeatureCollection", "features": list(features)}


def _stats(*features):
    """跑一次统计方法，返回结果。"""
    return DataProcessor("./data").calculate_building_statistics(_collection(*features))


def test_numeric_height_is_used_as_is():
    """数值型 height：min/max/average 直接按数值算。"""
    stats = _stats(_feature(height=10), _feature(height=20), _feature(height=30))
    assert stats["total_count"] == 3
    assert stats["height_stats"] == {"min": 10.0, "max": 30.0, "average": 20.0}


def test_string_height_is_counted_instead_of_raising():
    """字符串 height（OSM 的真实形态）：不能抛异常，且要计入统计。

    这是崩溃的回归用例：修复前 `if height > 0` 会抛 TypeError。
    """
    stats = _stats(_feature(height="15"), _feature(height="25"))
    assert stats["height_stats"] == {"min": 15.0, "max": 25.0, "average": 20.0}


def test_non_numeric_height_is_skipped():
    """非数字字符串（'approx'）：跳过，不抛异常，也不污染 min/max。"""
    stats = _stats(_feature(height="approx"), _feature(height="15"))
    assert stats["height_stats"] == {"min": 15.0, "max": 15.0, "average": 15.0}


def test_no_height_at_all_yields_zeroes():
    """所有要素都没有高度：min/max/average 全部为 0（不是 inf）。"""
    stats = _stats(_feature(building="house"), _feature(building="yes"))
    assert stats["total_count"] == 2
    assert stats["height_stats"] == {"min": 0, "max": 0, "average": 0}


def test_type_distribution_uses_the_building_tag():
    """建筑类型按 OSM 的 building 标签分组，没有标签的归入 unknown。"""
    stats = _stats(
        _feature(building="house"),
        _feature(building="house"),
        _feature(building="commercial"),
        _feature(name="无名建筑"),
    )
    assert stats["type_distribution"] == {"house": 2, "commercial": 1, "unknown": 1}


def test_building_levels_is_used_when_height_is_absent():
    """没有 height 时，用 building:levels × 3 估算高度。"""
    stats = _stats(
        _feature(**{"building:levels": "5"}),
        _feature(**{"building:levels": "2"}),
    )
    assert stats["height_stats"] == {"min": 6.0, "max": 15.0, "average": 10.5}


def test_roof_height_is_not_treated_as_total_height():
    """roof:height 是屋顶构件相对建筑顶部的高度，不能当作建筑总高。"""
    stats = _stats(_feature(**{"roof:height": "3"}))
    assert stats["height_stats"] == {"min": 0, "max": 0, "average": 0}


def test_invalid_height_values_are_ignored():
    """0、负数、空串、NaN、布尔值都不算高度，只有合法值参与统计。"""
    stats = _stats(
        _feature(height="0"),
        _feature(height="-5"),
        _feature(height=""),
        _feature(height="NaN"),
        _feature(height=True),
        _feature(height="12"),
    )
    assert stats["height_stats"] == {"min": 12.0, "max": 12.0, "average": 12.0}


def test_feature_without_properties_is_tolerated():
    """没有 properties 字段的要素不能把方法打崩。"""
    stats = DataProcessor("./data").calculate_building_statistics(
        {"type": "FeatureCollection", "features": [{"type": "Feature"}]}
    )
    assert stats["total_count"] == 1
    assert stats["type_distribution"] == {"unknown": 1}
    assert stats["height_stats"] == {"min": 0, "max": 0, "average": 0}
