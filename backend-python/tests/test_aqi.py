"""国标 AQI 换算的单元测试（``city_data/aqi.py``）。

这些用例**手算**国标 GB/T 3095-2012 的分段与线性内插公式，
不抄实现里的中间量 —— 抄实现只能证明实现和实现一致，证明不了口径对。

分段表（浓度 μg/m³，CO 在国标里是 mg/m³）::

    IAQI = (IAQI_high - IAQI_low) / (C_high - C_low) × (C - C_low) + IAQI_low
"""
import math

import pytest

from city_data import aqi


class TestSegmentEndpoints:
    """分段点上的归属：闭区间，含上界。"""

    @pytest.mark.parametrize(
        "pollutant,concentration,expected",
        [
            ("pm25", 0, 0.0),
            ("pm25", 35, 50.0),
            ("pm25", 75, 100.0),
            ("pm25", 115, 150.0),
            ("pm25", 150, 200.0),
            ("pm25", 250, 300.0),
            ("pm25", 350, 400.0),
            ("pm25", 500, 500.0),
            ("pm10", 50, 50.0),
            ("pm10", 150, 100.0),
            ("pm10", 250, 150.0),
            ("o3", 100, 50.0),
            ("o3", 160, 100.0),
            ("o3", 215, 150.0),
            ("no2", 40, 50.0),
            ("no2", 80, 100.0),
            ("so2", 50, 50.0),
            ("so2", 150, 100.0),
        ],
    )
    def test_breakpoint_lands_on_the_lower_band(self, pollutant, concentration, expected):
        assert aqi.iaqi(pollutant, concentration) == pytest.approx(expected)

    def test_pm25_just_above_the_first_breakpoint(self):
        # 35 属于第一段（闭区间），35.0001 属于第二段 —— 两者必须不同。
        assert aqi.iaqi("pm25", 35.0) == pytest.approx(50.0)
        above = aqi.iaqi("pm25", 35.0001)
        assert above == pytest.approx(50.0 + 50.0 / 40.0 * 0.0001)
        assert above > 50.0


class TestLinearInterpolation:
    """线性内插的数值：按国标公式手算。"""

    @pytest.mark.parametrize(
        "pollutant,concentration,expected",
        [
            # PM2.5：(100-50)/(75-35) × (55-35) + 50 = 25 + 50 = 75
            ("pm25", 55, 75.0),
            # PM10：(100-50)/(150-50) × (100-50) + 50 = 25 + 50 = 75
            ("pm10", 100, 75.0),
            # O3：(100-50)/(160-100) × (130-100) + 50 = 25 + 50 = 75
            ("o3", 130, 75.0),
            # NO2：(100-50)/(80-40) × (60-40) + 50 = 25 + 50 = 75
            ("no2", 60, 75.0),
            # SO2：(100-50)/(150-50) × (100-50) + 50 = 25 + 50 = 75
            ("so2", 100, 75.0),
            # PM2.5 落在中间：50/35 × 17.5 = 25
            ("pm25", 17.5, 25.0),
        ],
    )
    def test_interpolated_values(self, pollutant, concentration, expected):
        assert aqi.iaqi(pollutant, concentration) == pytest.approx(expected)


class TestCarbonMonoxideUnit:
    """CO 的单位换算：上游 μg/m³，国标 mg/m³。"""

    def test_200_ug_m3_lands_in_the_first_segment(self):
        # 200 μg/m³ = 0.2 mg/m³ → (50-0)/(2-0) × (0.2-0) = 5
        assert aqi.iaqi("co", 200) == pytest.approx(5.0)

    def test_2000_ug_m3_is_the_first_breakpoint(self):
        # 2000 μg/m³ = 2 mg/m³ → 分段点 → 50
        assert aqi.iaqi("co", 2000) == pytest.approx(50.0)

    def test_3000_ug_m3_is_the_second_segment(self):
        # 3000 μg/m³ = 3 mg/m³ → (100-50)/(4-2) × (3-2) + 50 = 75
        assert aqi.iaqi("co", 3000) == pytest.approx(75.0)

    def test_co_uses_the_standard_unit_not_the_raw_value(self):
        # 传 mg/m³ 的数字（2 μg/m³ = 0.002 mg/m³）会落在完全不同的一段 ——
        # 说明换算确实做了（0.002 × 50/2 = 0.05）。
        assert aqi.iaqi("co", 2) == pytest.approx(0.05)


class TestOutOfRange:
    """超出最高一段：按最高一段处理。"""

    @pytest.mark.parametrize(
        "pollutant,concentration,expected",
        [
            ("pm25", 1000, 500.0),
            ("pm10", 1200, 500.0),
            ("no2", 2000, 500.0),
            ("so2", 5000, 500.0),
            ("co", 61000, 500.0),
            # O3 的最高一段到 300（只有 6 段）。
            ("o3", 1000, 300.0),
        ],
    )
    def test_capped_at_the_top_band(self, pollutant, concentration, expected):
        assert aqi.iaqi(pollutant, concentration) == pytest.approx(expected)


class TestInvalidInput:
    """取不到就是 None —— 不许拿 0 冒充。"""

    @pytest.mark.parametrize(
        "concentration",
        [None, -1, -0.5, float("nan"), float("inf"), "abc", "", True, False, [1]],
    )
    def test_invalid_concentration_is_none(self, concentration):
        assert aqi.iaqi("pm25", concentration) is None

    def test_unknown_pollutant_is_none(self):
        assert aqi.iaqi("no2_xx", 10) is None
        assert aqi.iaqi("", 10) is None

    def test_numeric_string_is_read_as_a_number(self):
        """契约用 ``float()`` 转换输入，所以「55」这种数字字符串按数字处理。

        这条锁住实现的真实行为 —— 换算层不区分类型，只看能不能转成数字。
        """
        assert aqi.iaqi("pm25", "55") == pytest.approx(75.0)


class TestAqiFromPollutants:
    """AQI 取各污染物 IAQI 的最大值。"""

    def test_takes_the_maximum(self):
        value = aqi.aqi_from_pollutants(
            {"pm25": 55, "pm10": 100, "o3": 130, "no2": 60, "so2": 100, "co": 3000}
        )
        assert value == 75

    def test_pollutants_without_data_are_skipped(self):
        value = aqi.aqi_from_pollutants({"pm25": 55, "pm10": None, "o3": None})
        assert value == 75

    def test_all_none_is_none(self):
        assert aqi.aqi_from_pollutants({}) is None
        assert (
            aqi.aqi_from_pollutants(
                {"pm25": None, "pm10": None, "o3": None, "no2": None, "so2": None, "co": None}
            )
            is None
        )


class TestPrimaryPollutant:
    """首要污染物 = **IAQI 最高的那一项**（国标定义）。"""

    def test_is_the_highest_iaqi_pollutant(self):
        # pm25=55 → IAQI 75；pm10=100 → IAQI 66.7；其余更低
        name = aqi.primary_pollutant(
            {"pm25": 55, "pm10": 100, "o3": 130, "no2": 60, "so2": 100, "co": 3000}
        )
        assert name == "PM2.5"

    def test_switches_with_the_concentrations(self):
        # pm25=55 → IAQI 75；o3=160 → IAQI 100（8 小时口径），更高
        name = aqi.primary_pollutant({"pm25": 55, "o3": 160})
        assert name == "O3"

    def test_all_none_is_none(self):
        assert aqi.primary_pollutant({}) is None
        assert aqi.primary_pollutant({"pm25": None, "pm10": None}) is None

    def test_labels_cover_every_pollutant(self):
        assert set(aqi.POLLUTANT_LABELS) == set(aqi.BREAKPOINTS)

    def test_result_is_an_integer_between_0_and_500(self):
        value = aqi.aqi_from_pollutants({"pm25": 17.5})
        assert isinstance(value, int)
        assert 0 <= value <= 500


class TestAqiLevel:
    """六档分级（HJ 633-2012）。"""

    @pytest.mark.parametrize(
        "value,expected",
        [
            (0, (1, "优")),
            (50, (1, "优")),
            (50.5, (2, "良")),
            (100, (2, "良")),
            (100.5, (3, "轻度污染")),
            (150, (3, "轻度污染")),
            (150.5, (4, "中度污染")),
            (200, (4, "中度污染")),
            (200.5, (5, "重度污染")),
            (300, (5, "重度污染")),
            (300.5, (6, "严重污染")),
            (500, (6, "严重污染")),
        ],
    )
    def test_bands(self, value, expected):
        assert aqi.aqi_level(value) == expected

    def test_invalid_values_are_none(self):
        assert aqi.aqi_level(None) is None
        assert aqi.aqi_level(-1) is None
        assert aqi.aqi_level(float("nan")) is None
        assert aqi.aqi_level("abc") is None
        assert aqi.aqi_level(True) is None


class TestAveragingHours:
    """统计口径：O3 是 8 小时，其余 24 小时。"""

    def test_averaging_hours(self):
        assert aqi.AVERAGING_HOURS["o3"] == 8
        for key in ("pm25", "pm10", "no2", "so2", "co"):
            assert aqi.AVERAGING_HOURS[key] == 24

    def test_breakpoints_cover_every_pollutant(self):
        assert set(aqi.BREAKPOINTS) == set(aqi.AVERAGING_HOURS)

    def test_o3_has_six_segments_only(self):
        assert len(aqi.BREAKPOINTS["o3"][1]) == 6
        assert aqi.BREAKPOINTS["o3"][1][-1] == 800

    def test_unit_scale_table(self):
        assert aqi.UNIT_SCALE_TO_STANDARD["co"] == pytest.approx(0.001)
        assert aqi.to_standard_unit("co", 2000) == pytest.approx(2.0)
        assert aqi.to_standard_unit("pm25", 55) == pytest.approx(55.0)

    def test_level_bands_are_sorted(self):
        ups = [upper for upper, _level, _label in aqi.level_bands()]
        assert ups == sorted(ups)
        assert math.isinf(ups[-1])
