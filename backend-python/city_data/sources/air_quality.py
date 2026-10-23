"""空气质量数据源 —— 中国环境监测总站（cnemc）。

官方、免 key、实时。主力数据源。

接口（2026-10-22 实测）
----------------------
============================================  ======  ==========================================
地址                                            方法    说明
============================================  ======  ==========================================
``/CityData/GetAllCityRealTimeAQIModels``      GET     338 个城市的实时 AQI（含分级、首要污染物、经纬度）
``/HourChangesPublish/GetCityRealTimeAqiHistory``  POST  城市逐小时历史（**空 body**，GET 会 404）
============================================  ======  ==========================================

三个必须记住的坑
----------------
1. **历史接口是 POST**：用 GET 一律 404。
2. **必须带 Referer**（``https://air.cnemc.cn:18007/``），否则可能被拒。
3. **``TimePoint`` 有两种格式**：``"/Date(1792558800000)/"``（MS 时间戳）
   与 ``"2026-10-22T11:00:00"``（不带时区的本地时间）——两种都要能解析。

实时接口只给 AQI 与分级，**不给污染物浓度**；浓度要从逐小时历史里取。
所以本模块分成三个独立的取数函数（``fetch_realtime`` / ``fetch_history`` /
``fetch_daily_history``），聚合器把它们当三个源分别降级 ——
逐小时历史挂了不应该把实时 AQI 一起拖下水。

逐日历史与逐小时历史**不是一回事**
--------------------------------
逐日历史是**日维度**的：一天一条，值是**24 小时均值**（字段名都带 ``_24h``），
O3 的口径是「8 小时最大值的日平均」（字段名 ``O3_8h_24h``）。
它回答的是「这几天怎么样」；逐小时历史回答的是「今天怎么样」。
"""
import math
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from .. import http
from ..http import SourceUnavailable
from ..models import Metric, Series, SeriesPoint, SourceInfo, SourceResult

BASE_URL = "https://air.cnemc.cn:18007"
REALTIME_URL = BASE_URL + "/CityData/GetAllCityRealTimeAQIModels"
HISTORY_URL = BASE_URL + "/HourChangesPublish/GetCityRealTimeAqiHistoryByCondition"
# 逐日历史（14 天）。同样必须 POST + 空 body。
DAILY_HISTORY_URL = BASE_URL + "/HourChangesPublish/GetCityDayAqiHistoryByCondition"

# cnemc 要求带 Referer，否则可能被拒。
HEADERS = {"Referer": BASE_URL + "/"}

# 上游给的时间没有时区信息时，按北京时间理解（上游服务器就在北京）。
CHINA_TZ = timezone(timedelta(hours=8))

# 源的名字（前端会直接显示在指标带上）。
SOURCE_NAME = "中国环境监测总站"
HISTORY_SOURCE_NAME = "中国环境监测总站（逐小时历史）"
DAILY_SOURCE_NAME = "中国环境监测总站（逐日历史）"

# 降级时占位指标的槽位：正常情况下这个源会提供哪几个指标。
REALTIME_SLOTS = (("aqi", "空气质量", "AQI"),)
HISTORY_SLOTS = (
    ("pm25", "PM2.5", "μg/m³"),
    ("pm10", "PM10", "μg/m³"),
    ("o3", "O3", "μg/m³"),
    ("no2", "NO2", "μg/m³"),
    ("so2", "SO2", "μg/m³"),
    ("co", "CO", "mg/m³"),
)

# 逐小时历史里的污染物字段 → (指标 key, 中文名, 单位)。
# CO 的单位是 mg/m³，其余是 μg/m³（cnemc 的口径）。
POLLUTANTS = (
    ("PM2_5", "pm25", "PM2.5", "μg/m³"),
    ("PM10", "pm10", "PM10", "μg/m³"),
    ("O3", "o3", "O3", "μg/m³"),
    ("NO2", "no2", "NO2", "μg/m³"),
    ("SO2", "so2", "SO2", "μg/m³"),
    ("CO", "co", "CO", "mg/m³"),
)

# 逐日历史里的污染物字段 → (指标 key, 中文名, 单位)。
#
# **字段名与逐小时的不一样**：逐日是 24 小时均值，所以都带 ``_24h`` 后缀；
# O3 额外带 ``8h`` —— cnemc 的 O3 口径是「8 小时最大值的日平均」。
# 指标 key 与逐小时**保持一致**（pm25 / pm10 / o3 / …），
# 这样前端的污染物映射表不用分两套。
DAILY_POLLUTANTS = (
    ("PM2_5_24h", "pm25", "PM2.5", "μg/m³"),
    ("PM10_24h", "pm10", "PM10", "μg/m³"),
    ("O3_8h_24h", "o3", "O3", "μg/m³"),
    ("NO2_24h", "no2", "NO2", "μg/m³"),
    ("SO2_24h", "so2", "SO2", "μg/m³"),
    ("CO_24h", "co", "CO", "mg/m³"),
)

# 观测时间与当前时间差超过这个秒数，就不再声称「实时」。
REALTIME_MAX_AGE_SECONDS = 3600.0


def now_iso() -> str:
    """当前时间（ISO8601，UTC，秒精度）。"""
    return to_iso(datetime.now(tz=timezone.utc))


def to_iso(moment: datetime) -> str:
    """带时区的 datetime → ISO8601（UTC，Z 结尾）。"""
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_time_point(raw: Any) -> Optional[datetime]:
    """解析上游的 ``TimePoint``，返回 UTC datetime。

    支持两种格式（实测两种都出现过）：

    - ``"/Date(1792558800000)/"`` —— .NET 的 MS 时间戳；
    - ``"2026-10-22T11:00:00"`` —— 不带时区的本地时间，按北京时间理解。
    """
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text:
        return None

    if text.startswith("/Date("):
        inner = text[len("/Date("):].split(")")[0]
        try:
            millis = int(inner)
        except ValueError:
            return None
        return datetime.fromtimestamp(millis / 1000.0, tz=timezone.utc)

    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=CHINA_TZ)
    return parsed.astimezone(timezone.utc)


def _to_int(raw: Any) -> Optional[int]:
    """上游的数值字段一律是字符串；转成整数，转不了返回 None。"""
    if raw is None or isinstance(raw, bool):
        return None
    try:
        value = float(str(raw).strip())
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value):
        return None
    return int(value) if value.is_integer() else None


def _to_float(raw: Any) -> Optional[float]:
    """上游的数值字段 → 浮点数；转不了返回 None。"""
    if raw is None or isinstance(raw, bool):
        return None
    try:
        value = float(str(raw).strip())
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _is_recent(observed_at: Optional[datetime], now: datetime) -> bool:
    """观测时间离现在不到一小时才算「实时」。"""
    if observed_at is None:
        return False
    age = (now - observed_at).total_seconds()
    return 0 <= age <= REALTIME_MAX_AGE_SECONDS


def find_city(payload: Any, city_code: int) -> Optional[Dict[str, Any]]:
    """在实时城市列表里找出目标城市。找不到返回 None。"""
    if not isinstance(payload, list):
        return None
    for item in payload:
        if not isinstance(item, dict):
            continue
        if _to_int(item.get("CityCode")) == city_code:
            return item
    return None


def fetch_realtime(city_code: int, timeout: float = http.DEFAULT_TIMEOUT_SECONDS) -> SourceResult:
    """取某个城市的实时 AQI。

    取不到就抛 :class:`SourceUnavailable`（调用方把它算作降级）。
    """
    fetched_at = now_iso()
    payload = http.request_json(REALTIME_URL, headers=HEADERS, timeout=timeout)
    city = find_city(payload, city_code)
    if city is None:
        raise SourceUnavailable("上游实时列表里没有城市代码 %s" % city_code)

    observed = parse_time_point(city.get("TimePoint"))
    now = datetime.now(tz=timezone.utc)
    source = SourceInfo(
        name=SOURCE_NAME,
        url=REALTIME_URL,
        observed_at=to_iso(observed) if observed else None,
        fetched_at=fetched_at,
        realtime=_is_recent(observed, now),
        estimated=False,
    )

    aqi = _to_int(city.get("AQI"))
    level = _to_int(city.get("AqiLevel"))
    quality = city.get("Quality") if isinstance(city.get("Quality"), str) else None
    pollutant = city.get("PrimaryPollutant") if isinstance(city.get("PrimaryPollutant"), str) else None
    measure = city.get("Measure") if isinstance(city.get("Measure"), str) else None

    metric = Metric(
        key="aqi",
        label="空气质量",
        value=aqi,
        unit="AQI",
        level=level,
        level_label=quality,
        extra={
            "quality": quality,
            "primary_pollutant": pollutant,
            "health_advice": measure,
            "area": city.get("Area"),
        },
        source=source,
    )

    city_info = {
        "code": city_code,
        "name": city.get("Area"),
        "latitude": _to_float(city.get("Latitude")),
        "longitude": _to_float(city.get("Longitude")),
    }
    return SourceResult(metrics=[metric], series=[], city=city_info)


def parse_history(payload: Any) -> List[Dict[str, Any]]:
    """把逐小时历史解析成按时间升序的列表。

    每个元素：``{"t": ISO 时间, "aqi": float|None, "PM2_5": float|None, ...}``。
    """
    if not isinstance(payload, list):
        return []
    rows: List[Dict[str, Any]] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        moment = parse_time_point(item.get("TimePoint"))
        if moment is None:
            continue
        row: Dict[str, Any] = {"t": to_iso(moment), "aqi": _to_float(item.get("AQI"))}
        for field_name, key, _label, _unit in POLLUTANTS:
            row[key] = _to_float(item.get(field_name))
        rows.append(row)
    rows.sort(key=lambda row: row["t"])
    return rows


def fetch_history(city_code: int, timeout: float = http.DEFAULT_TIMEOUT_SECONDS) -> SourceResult:
    """取某个城市的逐小时历史（污染物浓度 + 24 小时 AQI 序列）。

    注意历史接口**必须用 POST 且 body 为空对象**（``{}``）——用 GET 会 404。
    """
    fetched_at = now_iso()
    url = HISTORY_URL + "?citycode=%s" % city_code
    payload = http.request_json(
        url,
        method="POST",
        headers=dict(HEADERS, **{"Content-Type": "application/json;charset=UTF-8"}),
        data=b"{}",
        timeout=timeout,
    )
    rows = parse_history(payload)
    if not rows:
        raise SourceUnavailable("逐小时历史没有可用数据点")

    latest = rows[-1]
    observed = parse_time_point(latest["t"])
    now = datetime.now(tz=timezone.utc)
    source = SourceInfo(
        name=HISTORY_SOURCE_NAME,
        url=url,
        observed_at=latest["t"],
        fetched_at=fetched_at,
        realtime=_is_recent(observed, now),
        estimated=False,
    )

    metrics: List[Metric] = []
    for _field_name, key, label, unit in POLLUTANTS:
        metrics.append(
            Metric(
                key=key,
                label=label,
                value=latest.get(key),
                unit=unit,
                extra={"observed_hour": latest["t"]},
                source=source,
            )
        )

    series = Series(
        key="aqi_24h",
        label="24 小时 AQI",
        unit="AQI",
        points=[SeriesPoint(t=row["t"], v=row["aqi"]) for row in rows],
        source=source,
    )
    return SourceResult(metrics=metrics, series=[series])


def parse_daily_history(payload: Any) -> List[Dict[str, Any]]:
    """把逐日历史解析成按时间升序的列表。

    每个元素：``{"t": ISO 时间, "aqi": float|None, "pm25": float|None, ...}``。

    与逐小时历史的区别：这里的值是**日均值**（上游字段都带 ``_24h``）。
    """
    if not isinstance(payload, list):
        return []
    rows: List[Dict[str, Any]] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        moment = parse_time_point(item.get("TimePoint"))
        if moment is None:
            continue
        row: Dict[str, Any] = {"t": to_iso(moment), "aqi": _to_float(item.get("AQI"))}
        for field_name, key, _label, _unit in DAILY_POLLUTANTS:
            row[key] = _to_float(item.get(field_name))
        rows.append(row)
    rows.sort(key=lambda row: row["t"])
    return rows


def fetch_daily_history(city_code: int, timeout: float = http.DEFAULT_TIMEOUT_SECONDS) -> SourceResult:
    """取某个城市的**逐日**历史（最近 14 天：AQI 日均 + 各项污染物日均）。

    与逐小时历史一样：**必须用 POST 且 body 为空对象**（``{}``）——用 GET 会 404。

    这一条只产出**序列**，不产出指标：指标带已经由逐小时历史提供了，
    重复放一份日均值只会让大屏上出现两个含义不同的「PM2.5」。
    """
    fetched_at = now_iso()
    url = DAILY_HISTORY_URL + "?citycode=%s" % city_code
    payload = http.request_json(
        url,
        method="POST",
        headers=dict(HEADERS, **{"Content-Type": "application/json;charset=UTF-8"}),
        data=b"{}",
        timeout=timeout,
    )
    rows = parse_daily_history(payload)
    if not rows:
        raise SourceUnavailable("逐日历史没有可用数据点")

    latest = rows[-1]
    source = SourceInfo(
        name=DAILY_SOURCE_NAME,
        url=url,
        observed_at=latest["t"],
        fetched_at=fetched_at,
        # 逐日数据按定义就不是实时的（最旧的一条是 14 天前）。
        realtime=False,
        estimated=False,
    )

    series = Series(
        key="aqi_daily",
        label="逐日 AQI",
        unit="AQI",
        points=[
            SeriesPoint(
                t=row["t"],
                # AQI 放在 v 里 —— 折线图组件不用改就能画。
                v=row["aqi"],
                # 各项污染物的日均值放在 values 里（键与指标 key 一致）。
                values={key: row[key] for _f, key, _l, _u in DAILY_POLLUTANTS},
            )
            for row in rows
        ],
        source=source,
    )
    return SourceResult(metrics=[], series=[series])
