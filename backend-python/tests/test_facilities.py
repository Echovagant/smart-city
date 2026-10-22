"""设施分类源（`city_data/sources/facilities.py`）的单元测试。

**这些测试一律不打真实网络，也不依赖磁盘上的 OSM 抽取数据**：
建筑数据是在 ``tmp_path`` 里现写的合成 GeoJSON。

覆盖的硬要求：
- **一个建筑只归一类**：按分类表顺序取第一个命中（``medical`` 最先），
  所以环形图能对上账 —— 分类计数之和就是设施总数，不重复计数；
- ``historic=yes`` 这类「布尔型」取值（值是字符串 ``"yes"``）也能命中；
- 每个分类都带**来源**（`source.estimated = false`：这是实测计数）；
- 读不到文件 → 抛异常（上层把它算作降级，端点仍然 200）。
"""
import asyncio
import json

import pytest

from city_data.sources import facilities


def _write_geojson(path, features, timestamp="2026-06-21T11:40:10Z"):
    path.write_text(
        json.dumps(
            {"type": "FeatureCollection", "timestamp": timestamp, "features": features},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return path


def _building(**properties):
    """一栋楼（几何无关紧要，分类只看 properties）。"""
    return {
        "type": "Feature",
        "properties": dict(properties),
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]],
        },
    }


class TestClassify:
    def test_matches_the_documented_tags(self):
        assert facilities.classify({"building": "hospital"}) == "medical"
        assert facilities.classify({"amenity": "police"}) == "public_safety"
        assert facilities.classify({"amenity": "fire_station"}) == "public_safety"
        assert facilities.classify({"building": "guardhouse"}) == "public_safety"
        assert facilities.classify({"amenity": "shelter"}) == "public_safety"
        assert facilities.classify({"building": "school"}) == "education"
        assert facilities.classify({"building": "university"}) == "education"
        assert facilities.classify({"building": "kindergarten"}) == "education"
        assert facilities.classify({"amenity": "college"}) == "education"
        assert facilities.classify({"historic": "city_gate"}) == "heritage"
        assert facilities.classify({"historic": "palace"}) == "heritage"
        assert facilities.classify({"historic": "temple"}) == "heritage"
        assert facilities.classify({"historic": "building"}) == "heritage"
        assert facilities.classify({"historic": "monastery"}) == "heritage"
        assert facilities.classify({"building": "commercial"}) == "commerce"
        assert facilities.classify({"building": "retail"}) == "commerce"
        assert facilities.classify({"building": "office"}) == "commerce"
        assert facilities.classify({"building": "hotel"}) == "commerce"
        assert facilities.classify({"shop": "mall"}) == "commerce"
        assert facilities.classify({"office": "government"}) == "commerce"

    def test_boolean_valued_tags_still_match(self):
        # OSM 里 historic=yes 的值就是字符串 "yes"
        assert facilities.classify({"historic": "yes"}) == "heritage"

    def test_unmatched_buildings_have_no_category(self):
        assert facilities.classify({"building": "yes"}) is None
        assert facilities.classify({"name": "某住宅"}) is None
        assert facilities.classify({}) is None
        assert facilities.classify(None) is None

    def test_first_match_wins_so_a_building_is_counted_once(self):
        # 一栋楼既是医院又是历史建筑 → 只算医疗设施（分类表里 medical 在前）
        assert facilities.classify({"building": "hospital", "historic": "yes"}) == "medical"
        # 公共安全与教育同时命中时，public_safety 在 education 之前
        assert facilities.classify({"amenity": "shelter", "building": "school"}) == "public_safety"
        # 教育与历史建筑同时命中时，education 在 heritage 之前
        assert facilities.classify({"building": "school", "historic": "palace"}) == "education"


class TestCountByCategory:
    def test_counts_are_deduplicated(self):
        features = [
            _building(building="hospital"),
            _building(building="hospital", historic="yes"),  # 仍只算医疗
            _building(building="school"),
            _building(historic="city_gate"),
            _building(name="不归类的住宅"),
        ]
        counts = facilities.count_by_category(features)
        assert counts["medical"] == 2
        assert counts["education"] == 1
        assert counts["heritage"] == 1
        assert counts["public_safety"] == 0
        assert counts["commerce"] == 0
        # 分类计数之和 = 设施总数（不重复计数）
        assert sum(counts.values()) == 4

    def test_broken_features_are_skipped(self):
        # 防御：要素不是 dict 时跳过，不让它把整个统计带崩
        counts = facilities.count_by_category(["not a dict", _building(building="hospital")])
        assert counts["medical"] == 1

    def test_criteria_of_unknown_category_is_empty(self):
        assert facilities.criteria_of("medical") == ["building=hospital"]
        assert facilities.criteria_of("不存在的分类") == []


class TestFetch:
    def test_produces_categories_with_criteria_and_source(self, tmp_path):
        path = _write_geojson(
            tmp_path / "buildings.geojson",
            [
                _building(building="hospital"),
                _building(amenity="police"),
                _building(building="school"),
                _building(historic="yes"),
                _building(building="commercial"),
            ],
        )

        result = facilities.fetch(path)

        by_key = {item.key: item for item in result.facilities}
        assert set(by_key) == {
            "medical",
            "public_safety",
            "education",
            "heritage",
            "commerce",
        }
        assert by_key["medical"].count == 1
        assert by_key["public_safety"].count == 1
        assert by_key["education"].count == 1
        assert by_key["heritage"].count == 1
        assert by_key["commerce"].count == 1

        # 分类名与依据标签都要带上（前端显示「依据 OSM 标签统计」）
        assert by_key["medical"].label == "医疗设施"
        assert by_key["medical"].criteria == ["building=hospital"]
        assert by_key["public_safety"].criteria == [
            "amenity=police",
            "amenity=fire_station",
            "building=guardhouse",
            "amenity=shelter",
        ]

        # 每个分类都带来源；这是**实测**计数，不是模型估算
        for item in result.facilities:
            assert item.source.name == facilities.SOURCE_NAME
            assert item.source.url == facilities.BUILDINGS_REF
            assert item.source.estimated is False
            assert item.source.realtime is False
            assert item.source.observed_at == "2026-06-21T11:40:10Z"
            assert item.source.fetched_at

        # 总数指标：分类计数之和
        metric = next(m for m in result.metrics if m.key == "facility_total")
        assert metric.value == 5
        assert metric.unit == "处"
        assert metric.source.estimated is False

    def test_missing_file_raises_so_the_caller_can_degrade(self, tmp_path):
        with pytest.raises(Exception):
            facilities.fetch(tmp_path / "nope.geojson")


class TestAggregatorWiring:
    """聚合器接线：设施分类进 `CityOverview.facilities`。

    **不打真实网络**：上游取数全部替换成「立刻抛不可用」的假实现，
    被测的是本地源与降级路径。
    """

    @pytest.fixture(autouse=True)
    def _no_network(self, monkeypatch):
        from city_data import aggregator, http
        from city_data.http import SourceUnavailable

        def boom(*args, **kwargs):
            raise SourceUnavailable("测试：不允许真实网络")

        monkeypatch.setattr(http, "request_json", boom)
        aggregator.clear_cache()
        yield
        aggregator.clear_cache()

    def test_facilities_reach_the_overview(self, tmp_path):
        from city_data import aggregator

        path = _write_geojson(
            tmp_path / "buildings.geojson",
            [_building(building="hospital"), _building(building="school")],
        )
        overview = asyncio.run(aggregator.build_city_overview(110000, buildings_path=path))

        keys = [item.key for item in overview.facilities]
        assert keys == ["medical", "public_safety", "education", "heritage", "commerce"]
        medical = next(item for item in overview.facilities if item.key == "medical")
        assert medical.count == 1
        assert medical.source.estimated is False
        # 上游全挂 → 那些源降级，但设施分类（本地源）照常返回
        assert facilities.SOURCE_NAME not in overview.degraded

    def test_missing_data_degrades_without_breaking_the_response(self, tmp_path):
        from city_data import aggregator

        overview = asyncio.run(
            aggregator.build_city_overview(
                110000,
                buildings_path=tmp_path / "nope.geojson",
            )
        )

        # 源失败 → 进 degraded，facilities 是空数组（**不编数字**）
        assert facilities.SOURCE_NAME in overview.degraded
        assert overview.facilities == []
        metric = next(m for m in overview.metrics if m.key == "facility_total")
        assert metric.value is None

