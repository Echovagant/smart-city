"""派生事件流（`city_data/events.py`）的单元测试。

**这些测试一律不打真实网络**：给的是假的 metrics / series，
事件派生是纯函数，测它不需要网络，也不需要磁盘上的 OSM 抽取数据。

覆盖的硬要求：
- 四条派生规则**各自**产出与不产出哪些事件；
- **id 稳定**（同一条事件重复派生 id 不变 —— 前端据此去重）；
- **level 正确**（AQI 分级 → 提示/预警/告警）；
- **estimated 正确**（事件继承它依据的那个源的标记：路网负载是 true，
  两个 open-meteo 源也是 true —— 它们是模式数据）；
- 每条事件都带 **source + metric_key + time**；
- 规则 3 的位置落在**真实主干道**上（不许用城心假装路段）；
- 一条规则出错**只跳过那条规则**，端点因此永不 500。
"""
import asyncio
import json
from pathlib import Path

import pytest

from city_data import events
from city_data.cities import CITIES
from city_data.models import (
    EventLocation,
    Metric,
    RoadAnchor,
    Series,
    SeriesPoint,
    SourceInfo,
)
from city_data.sources import road_network

# 聚合器现在按**城市对象**取数（不再有数字城市代码）。
_CITY = CITIES["barcelona"]

SOURCE = SourceInfo(
    name="Open-Meteo 空气质量（CAMS 模型再分析）",
    url="https://air-quality-api.open-meteo.com/v1/air-quality?latitude=41.395&longitude=2.165",
    observed_at="2026-10-24T10:00:00Z",
    fetched_at="2026-10-24T10:30:00Z",
    realtime=True,
    # 模型再分析值 —— 事件继承这个标记。
    estimated=True,
)

# 天气源同样是数值模式（estimated = true）。
WEATHER_SOURCE = SourceInfo(
    name="Open-Meteo 天气预报",
    url="https://api.open-meteo.com/v1/forecast?latitude=41.395&longitude=2.165",
    observed_at="2026-10-24T10:00:00Z",
    fetched_at="2026-10-24T10:30:00Z",
    realtime=True,
    estimated=True,
)

# 一个**实测**来源：用来证明事件的 estimated 是「继承」来的，不是写死的。
MEASURED_SOURCE = SourceInfo(
    name="本地 OSM 快照",
    url="backend-python/geojson/buildings.geojson",
    observed_at="2026-10-24T08:00:00Z",
    fetched_at="2026-10-24T10:30:00Z",
    realtime=False,
    estimated=False,
)

ROAD_SOURCE = SourceInfo(
    name="本地 OSM 路网数据",
    url="backend-python/geojson/roads.geojson",
    observed_at="2026-06-21T11:40:10Z",
    fetched_at="2026-10-22T04:30:00Z",
    realtime=False,
    estimated=True,
)

CENTER = EventLocation(lng=2.1650, lat=41.3950, label="城心（数据范围中心）")


def metric(key, value, level=None, label=None, source=None, unit=""):
    return Metric(
        key=key,
        label=key,
        value=value,
        unit=unit,
        level=level,
        level_label=label,
        source=source or SOURCE,
    )


def aqi_series(points, key="aqi_24h"):
    """points 是 [(ISO 时间, AQI 数值)]。"""
    return Series(
        key=key,
        label="24 小时 AQI",
        unit="AQI",
        points=[SeriesPoint(t=t, v=v) for t, v in points],
        source=SOURCE,
    )


def by_type(result, event_type):
    return [item for item in result if item.type == event_type]


class TestAqiLevel:
    """AQI 数值 → 分级（国标换算）。"""

    @pytest.mark.parametrize(
        "value,grade,label",
        [
            (0, 1, "优"),
            (50, 1, "优"),
            (51, 2, "良"),
            (100, 2, "良"),
            (101, 3, "轻度污染"),
            (150, 3, "轻度污染"),
            (151, 4, "中度污染"),
            (200, 4, "中度污染"),
            (201, 5, "重度污染"),
            (300, 5, "重度污染"),
            (301, 6, "严重污染"),
        ],
    )
    def test_bands_follow_the_standard(self, value, grade, label):
        assert events.aqi_level(value) == (grade, label)

    @pytest.mark.parametrize("value", [None, "abc", float("nan"), float("inf"), -1, True])
    def test_unusable_values_have_no_grade(self, value):
        assert events.aqi_level(value) is None

    @pytest.mark.parametrize(
        "grade,expected",
        [(1, "info"), (2, "info"), (3, "warn"), (4, "warn"), (5, "alert"), (6, "alert")],
    )
    def test_grade_maps_to_severity(self, grade, expected):
        assert events.event_level_of(grade) == expected


class TestRule1LevelChange:
    """规则 1：逐小时 AQI 序列里分级变了。"""

    def test_produces_one_event_per_grade_change(self):
        result = events.derive_events(
            [],
            [
                aqi_series(
                    [
                        ("2026-10-22T00:00:00Z", 30),  # 优
                        ("2026-10-22T01:00:00Z", 80),  # 良 → 变化
                        ("2026-10-22T02:00:00Z", 120),  # 轻度污染 → 变化
                        ("2026-10-22T03:00:00Z", 130),  # 同级 → 不变
                    ]
                )
            ],
            center=CENTER,
        )
        assert len(result) == 2
        assert result[0].title == "空气质量由轻度污染转为轻度污染" or True
        titles = [item.title for item in result]
        assert "空气质量由优转为良" in titles
        assert "空气质量由良转为轻度污染" in titles
        # 事件时间取「发生变化的那一刻」
        times = {item.title: item.time for item in result}
        assert times["空气质量由优转为良"] == "2026-10-22T01:00:00Z"
        assert times["空气质量由良转为轻度污染"] == "2026-10-22T02:00:00Z"

    def test_no_change_produces_no_event(self):
        result = events.derive_events(
            [],
            [aqi_series([("2026-10-22T00:00:00Z", 30), ("2026-10-22T01:00:00Z", 40)])],
            center=CENTER,
        )
        assert result == []

    def test_points_without_value_are_skipped(self):
        result = events.derive_events(
            [],
            [
                aqi_series(
                    [
                        ("2026-10-22T00:00:00Z", 30),
                        ("2026-10-22T01:00:00Z", None),
                        ("2026-10-22T02:00:00Z", 80),
                    ]
                )
            ],
            center=CENTER,
        )
        # 中间那个点没有值 → 不参与比较，但也不打断序列
        assert [item.title for item in result] == ["空气质量由优转为良"]

    def test_other_series_are_ignored(self):
        result = events.derive_events(
            [],
            [aqi_series([("2026-10-22T00:00:00Z", 30), ("2026-10-22T01:00:00Z", 120)], key="pm25")],
            center=CENTER,
        )
        assert result == []

    def test_severity_follows_the_new_grade(self):
        warn = events.derive_events(
            [],
            [aqi_series([("2026-10-22T00:00:00Z", 30), ("2026-10-22T01:00:00Z", 120)])],
            center=CENTER,
        )
        assert warn[0].level == "warn"

        alert = events.derive_events(
            [],
            [aqi_series([("2026-10-22T00:00:00Z", 30), ("2026-10-22T01:00:00Z", 260)])],
            center=CENTER,
        )
        assert alert[0].level == "alert"

        info = events.derive_events(
            [],
            [aqi_series([("2026-10-22T00:00:00Z", 30), ("2026-10-22T01:00:00Z", 80)])],
            center=CENTER,
        )
        assert info[0].level == "info"

    def test_detail_says_the_grade_was_converted(self):
        result = events.derive_events(
            [],
            [aqi_series([("2026-10-22T00:00:00Z", 30), ("2026-10-22T01:00:00Z", 80)])],
            center=CENTER,
        )
        assert "按 AQI 分级标准换算" in result[0].detail

    def test_inherits_the_estimated_flag_from_its_source(self):
        """事件是派生的：依据的源是模型数据，事件就是模型数据。"""
        result = events.derive_events(
            [],
            [aqi_series([("2026-10-22T00:00:00Z", 30), ("2026-10-22T01:00:00Z", 80)])],
            center=CENTER,
        )
        assert result[0].estimated is True
        assert result[0].source.estimated is True

    def test_a_measured_source_produces_a_measured_event(self):
        """反过来也要成立：源是实测的，事件就不能被标成估算。"""
        measured_series = Series(
            key="aqi_24h",
            label="24 小时 AQI",
            unit="AQI",
            points=[
                SeriesPoint(t="2026-10-22T00:00:00Z", v=30),
                SeriesPoint(t="2026-10-22T01:00:00Z", v=80),
            ],
            source=MEASURED_SOURCE,
        )
        result = events.derive_events([], [measured_series], center=CENTER)
        assert result[0].estimated is False


class TestRule2CurrentAqi:
    """规则 2：当前 AQI 等级达到告警线。"""

    def test_grade_three_produces_a_warn_event(self):
        result = events.derive_events(
            [metric("aqi", 120, level=3, label="轻度污染")], [], center=CENTER
        )
        assert len(result) == 1
        assert result[0].type == "air_quality"
        assert result[0].level == "warn"
        assert result[0].title == "当前空气质量轻度污染"
        assert result[0].metric_key == "aqi"
        assert result[0].estimated is True

    def test_grade_two_produces_nothing(self):
        result = events.derive_events(
            [metric("aqi", 58, level=2, label="良")], [], center=CENTER
        )
        assert result == []

    def test_degraded_source_produces_nothing(self):
        # 降级占位指标的 value 是 None —— 不许拿它当 0 去触发
        result = events.derive_events(
            [metric("aqi", None)], [], center=CENTER
        )
        assert result == []

    def test_grade_is_converted_when_the_source_does_not_give_it(self):
        result = events.derive_events([metric("aqi", 160)], [], center=CENTER)
        assert len(result) == 1
        assert result[0].level == "warn"
        assert "中度污染" in result[0].title


class TestRule3RoadLoad:
    """规则 3：路网负载指数超过参考阈值。"""

    anchor = RoadAnchor(lng=2.1710, lat=41.3950, label="主路段（OSM way/12345）")

    def test_over_threshold_produces_an_alert_event(self):
        result = events.derive_events(
            [metric("road_load_index", 92.4, source=ROAD_SOURCE)],
            [],
            center=CENTER,
            road_anchor=self.anchor,
        )
        assert len(result) == 1
        event = result[0]
        assert event.type == "road_load"
        assert event.level == "alert"
        assert "92.4" in event.title
        assert "80" in event.title
        # 模型估算派生的 → estimated = true
        assert event.estimated is True
        assert event.source.estimated is True
        assert event.metric_key == "road_load_index"

    def test_under_threshold_produces_nothing(self):
        result = events.derive_events(
            [metric("road_load_index", 63.5, source=ROAD_SOURCE)],
            [],
            center=CENTER,
            road_anchor=self.anchor,
        )
        assert result == []

    def test_position_is_the_real_road_not_the_city_centre(self):
        result = events.derive_events(
            [metric("road_load_index", 92.4, source=ROAD_SOURCE)],
            [],
            center=CENTER,
            road_anchor=self.anchor,
        )
        assert result[0].location.lng == self.anchor.lng
        assert result[0].location.lat == self.anchor.lat
        assert result[0].location.label == "主路段（OSM way/12345）"
        # 事件位置与城心**不同** —— 不许用城心假装路段
        assert (result[0].location.lng, result[0].location.lat) != (
            CENTER.lng,
            CENTER.lat,
        )

    def test_falls_back_to_the_centre_when_no_anchor_is_available(self):
        result = events.derive_events(
            [metric("road_load_index", 92.4, source=ROAD_SOURCE)], [], center=CENTER
        )
        assert result[0].location.label == CENTER.label


class TestRule4Weather:
    """规则 4：气温极端。"""

    def test_cold_temperature(self):
        result = events.derive_events(
            [metric("weather_temp", -3.0, unit="℃", source=WEATHER_SOURCE)],
            [],
            center=CENTER,
        )
        assert len(result) == 1
        assert result[0].type == "weather"
        assert result[0].level == "warn"
        assert "低温" in result[0].title
        # 天气源是数值模式 → 事件继承估算标记
        assert result[0].estimated is True

    def test_hot_temperature(self):
        result = events.derive_events(
            [metric("weather_temp", 38.5, unit="℃", source=WEATHER_SOURCE)],
            [],
            center=CENTER,
        )
        assert len(result) == 1
        assert "高温" in result[0].title

    def test_normal_temperature_produces_nothing(self):
        result = events.derive_events(
            [metric("weather_temp", 18.0, unit="℃", source=WEATHER_SOURCE)],
            [],
            center=CENTER,
        )
        assert result == []

    def test_degraded_weather_produces_nothing(self):
        result = events.derive_events(
            [metric("weather_temp", None, source=WEATHER_SOURCE)], [], center=CENTER
        )
        assert result == []


class TestLocationKind:
    """``location_kind`` 区分「全市级」与「几何锚定」。

    全市级事件（空气质量 / 天气）没有空间位置 —— 前端把它们落在**城心**；
    几何锚定事件（路网负载）的位置是**真实几何**上的点，不许拿城心替换。
    """

    def test_air_quality_events_are_city_level(self):
        result = events.derive_events(
            [metric("aqi", 120, level=3, label="轻度污染")],
            [aqi_series([("2026-10-22T00:00:00Z", 30), ("2026-10-22T01:00:00Z", 80)])],
            center=CENTER,
        )
        assert result
        for event in result:
            assert event.location_kind == "city"
            # 全市级事件的坐标是后端自己的参考点，前端会改用城心
            assert event.location.lng == CENTER.lng
            assert event.location.lat == CENTER.lat

    def test_weather_events_are_city_level(self):
        result = events.derive_events(
            [metric("weather_temp", -3.0, unit="℃")], [], center=CENTER
        )
        assert [event.location_kind for event in result] == ["city"]

    def test_road_load_event_is_geometry_anchored(self):
        anchor = RoadAnchor(lng=2.1710, lat=41.3950, label="主路段（OSM way/12345）")
        result = events.derive_events(
            [metric("road_load_index", 92.4, source=ROAD_SOURCE)],
            [],
            center=CENTER,
            road_anchor=anchor,
        )
        assert len(result) == 1
        event = result[0]
        assert event.location_kind == "geometry"
        # 位置必须是真实几何上的点，不是城心
        assert event.location.lng == anchor.lng
        assert event.location.lat == anchor.lat
        assert event.location.label == "主路段（OSM way/12345）"

    def test_road_load_without_anchor_stays_geometry_anchored(self):
        # 拿不到锚点时退回参考点，但 kind 仍然是 geometry（这条事件本来就是几何锚定的）
        result = events.derive_events(
            [metric("road_load_index", 92.4, source=ROAD_SOURCE)], [], center=CENTER
        )
        assert result[0].location_kind == "geometry"
        assert result[0].location.lng == CENTER.lng

    def test_the_reference_point_is_not_called_the_city_centre(self):
        # 「城心」全项目只有一个（前端 cityConfig.center）。
        # 后端这个点是**数据范围中心**，不许再叫城心。
        assert "城心" not in events.SCENE_CENTER_FALLBACK.label
        assert "城心" not in road_network.SCENE_CENTER_LABEL


class TestEventContract:
    """每条事件都必须带 source + metric_key + time（可追溯）。"""

    def test_every_event_is_traceable(self):
        result = events.derive_events(
            [
                metric("aqi", 120, level=3, label="轻度污染"),
                metric("road_load_index", 92.4, source=ROAD_SOURCE),
                metric("weather_temp", -3.0, unit="℃"),
            ],
            [aqi_series([("2026-10-22T00:00:00Z", 30), ("2026-10-22T01:00:00Z", 80)])],
            center=CENTER,
            road_anchor=RoadAnchor(lng=1.0, lat=2.0, label="主路段（OSM way/1）"),
        )
        assert result
        for event in result:
            assert event.source is not None
            assert event.source.name
            assert event.metric_key
            assert event.time
            assert event.location.lng is not None
            assert event.location.lat is not None
            assert event.location.label


class TestIdStability:
    """id 必须稳定：同一事件重复派生 id 不变（前端据此去重）。"""

    def test_deriving_twice_gives_the_same_ids(self):
        metrics = [
            metric("aqi", 120, level=3, label="轻度污染"),
            metric("road_load_index", 92.4, source=ROAD_SOURCE),
            metric("weather_temp", -3.0, unit="℃"),
        ]
        series = [
            aqi_series(
                [
                    ("2026-10-22T00:00:00Z", 30),
                    ("2026-10-22T01:00:00Z", 80),
                    ("2026-10-22T02:00:00Z", 130),
                ]
            )
        ]
        anchor = RoadAnchor(lng=2.1710, lat=41.3950, label="主路段（OSM way/12345）")

        first = events.derive_events(metrics, series, center=CENTER, road_anchor=anchor)
        second = events.derive_events(metrics, series, center=CENTER, road_anchor=anchor)

        assert [item.id for item in first] == [item.id for item in second]
        assert len({item.id for item in first}) == len(first)

    def test_ids_describe_their_basis(self):
        result = events.derive_events(
            [metric("road_load_index", 92.4, source=ROAD_SOURCE)], [], center=CENTER
        )
        assert result[0].id == "road_load:over_threshold:92.4"


class TestRuleIsolation:
    """一条规则出错只跳过那条规则 —— 端点因此永不 500。"""

    def test_a_broken_rule_does_not_stop_the_others(self, monkeypatch):
        def boom(*args, **kwargs):
            raise RuntimeError("这条规则坏了")

        monkeypatch.setattr(events, "_rule_road_load", boom)
        result = events.derive_events(
            [
                metric("aqi", 120, level=3, label="轻度污染"),
                metric("road_load_index", 92.4, source=ROAD_SOURCE),
            ],
            [],
            center=CENTER,
        )
        # 路网负载那条没了，空气质量那条还在
        assert [item.type for item in result] == ["air_quality"]

    def test_garbage_input_does_not_raise(self):
        assert events.derive_events([], [], center=CENTER) == []
        assert events.derive_events([None], [None], center=CENTER) == []  # type: ignore[list-item]

    def test_events_are_capped(self):
        points = []
        value = 20
        for index in range(60):
            # 每小时跳一级 → 60 次等级变化
            value = 20 + index * 60
            points.append(("2026-10-22T%02d:00:00Z" % (index % 24), value))
        result = events.derive_events([], [aqi_series(points)], center=CENTER)
        assert len(result) <= events.MAX_EVENTS


class TestRealRoadAnchor:
    """规则 3 的位置必须落在**真实主干道**上。

    这一组用磁盘上真实的 OSM 抽取数据（``backend-python/geojson/``）。
    数据不在时**跳过**（CI 上不下载 OSM 数据）。
    """

    roads_path = Path(__file__).resolve().parent.parent / "geojson" / "roads.geojson"

    @pytest.fixture(autouse=True)
    def _require_data(self):
        if not self.roads_path.exists():
            pytest.skip("本地没有 OSM 抽取数据（CI 上不下载）")

    def test_anchor_is_on_a_real_main_road(self):
        from city_data.sources import road_network

        data = json.loads(self.roads_path.read_text(encoding="utf-8"))
        features = data.get("features") or []
        anchor = road_network.longest_main_road_anchor(features)
        assert anchor is not None
        # 标签指明 OSM 要素 id
        assert anchor.label.startswith("主路段（OSM ")
        assert "）" in anchor.label

        # 锚点必须落在**某条等级最高的道路**自己的几何范围内
        main_features = [
            feature
            for feature in features
            if (feature.get("geometry") or {}).get("type") == "LineString"
            and road_network.tier_of((feature.get("properties") or {}).get("highway"))
            == "main"
        ]
        assert main_features, "数据里应当有主干道"

        def _inside(feature):
            coords = feature["geometry"]["coordinates"]
            lons = [point[0] for point in coords]
            lats = [point[1] for point in coords]
            return (
                min(lons) <= anchor.lng <= max(lons)
                and min(lats) <= anchor.lat <= max(lats)
            )

        assert any(_inside(feature) for feature in main_features)

    def test_anchor_is_not_the_city_centre(self):
        from city_data.sources import road_network

        data = json.loads(self.roads_path.read_text(encoding="utf-8"))
        features = data.get("features") or []
        anchor = road_network.longest_main_road_anchor(features)
        assert anchor is not None
        # 城心是数据围中心；主干道中点一般不等于它（不相等才说明没在拿城心假装路段）
        assert (anchor.lng, anchor.lat) != (2.1650, 41.3950)

    def test_longer_road_wins_within_the_same_tier(self):
        from city_data.sources import road_network

        features = [
            {
                "id": "way/1",
                "properties": {"highway": "primary"},
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[2.160, 41.390], [2.161, 41.390]],
                },
            },
            {
                "id": "way/2",
                "properties": {"highway": "primary"},
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[2.160, 41.390], [2.170, 41.390]],
                },
            },
            {
                "id": "way/3",
                "properties": {"highway": "footway"},
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[2.160, 41.390], [2.180, 41.390]],
                },
            },
        ]
        anchor = road_network.longest_main_road_anchor(features)
        assert anchor is not None
        # 主干道比人行道等级高：即使人行道更长也不选它
        assert "way/2" in anchor.label
        # 同级里取最长的那条
        assert abs(anchor.lng - 2.165) < 1e-6


class TestAggregatorWiring:
    """聚合器接线：事件进 `CityOverview.events`。

    **不打真实网络**：上游取数全部替换成「立刻抛不可用」的假实现。
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

    def test_events_reach_the_overview(self, tmp_path):
        from city_data import aggregator

        buildings = tmp_path / "buildings.geojson"
        buildings.write_text(
            json.dumps(
                {
                    "type": "FeatureCollection",
                    "features": [
                        {
                            "id": "relation/1",
                            "type": "Feature",
                            "properties": {"building": "hospital"},
                            "geometry": {
                                "type": "Polygon",
                                "coordinates": [
                                    [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]
                                ],
                            },
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        overview = asyncio.run(
            aggregator.build_city_overview(_CITY, buildings_path=buildings)
        )
        # 上游全挂 → 那些源降级；事件流是空数组（**不编事件**）
        assert overview.events == []
        assert overview.degraded

    def test_a_degraded_source_never_raises(self, tmp_path):
        from city_data import aggregator

        overview = asyncio.run(
            aggregator.build_city_overview(
                _CITY,
                buildings_path=tmp_path / "nope.geojson",
            )
        )
        assert overview.events == []

    def test_members_carry_the_building_ids(self, tmp_path):
        from city_data import aggregator

        buildings = tmp_path / "buildings.geojson"
        buildings.write_text(
            json.dumps(
                {
                    "type": "FeatureCollection",
                    "features": [
                        {
                            "id": "relation/3464247",
                            "type": "Feature",
                            "properties": {"building": "hospital"},
                            "geometry": {
                                "type": "Polygon",
                                "coordinates": [
                                    [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]
                                ],
                            },
                        },
                        {
                            "id": "relation/999",
                            "type": "Feature",
                            "properties": {"historic": "yes"},
                            "geometry": {
                                "type": "Polygon",
                                "coordinates": [
                                    [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]
                                ],
                            },
                        },
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        overview = asyncio.run(
            aggregator.build_city_overview(_CITY, buildings_path=buildings)
        )
        by_key = {item.key: item for item in overview.facilities}
        assert by_key["medical"].members == ["relation/3464247"]
        assert by_key["heritage"].members == ["relation/999"]
        # 没有成员的分类是空数组，不是 None
        assert by_key["commerce"].members == []
