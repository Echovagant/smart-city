"""天气数据源 —— open-meteo Forecast API（免 key，数值模式预报）。

接口（2026-10-24 实测）
----------------------
``GET https://api.open-meteo.com/v1/forecast`` → 200 JSON::

    {"latitude": 41.43923, "longitude": 2.168546,
     "utc_offset_seconds": 7200, "timezone": "Europe/Madrid",
     "elevation": 47.0,
     "current_units": {"time": "unixtime", "temperature_2m": "°C",
                       "relative_humidity_2m": "%", "wind_speed_10m": "km/h",
                       "precipitation": "mm"},
     "current": {"time": 1792806300, "interval": 900,
                 "temperature_2m": 15.8, "relative_humidity_2m": 86,
                 "apparent_temperature": 16.0, "weather_code": 80,
                 "wind_speed_10m": 6.2, "precipitation": 0.10}}

为什么用 Unix epoch 秒
----------------------
请求带 ``timeformat=unixtime``，上游所有时间都是 **Unix 秒**。本机没有 IANA
时区库（``zoneinfo`` 在 Windows 上要额外装 ``tzdata``，而本项目不新增任何
依赖），所以**一律用 epoch 秒**，需要本地时刻时用响应里的
``utc_offset_seconds`` 换算 —— 不去解析 ``Europe/Madrid`` 的本地时间。

已知限制
--------
1. **这是数值模式预报，不是站点实测** → ``source.estimated = True``。
2. ``current.time`` 是**当前小时的整点**（预报步长 15 分钟，``current`` 给的
   却是整点），所以观测时刻最多比现在早 1 小时；超过 1 小时就如实标成
   「不是实时」，不假装是实时读数。
3. ``weather_code`` 是 WMO 天气现象代码（上游按 WMO 表给出），本模块只透传
   数字，不自己翻译 —— 免得翻译错。
4. 上游要求署名（免费档的授权条件）—— 署名写在响应的 ``extra.attribution``
   里，随数据一起发出去，不只写在文档里。
5. 免费档仅限非商业用途。
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Dict, Optional
from urllib.parse import urlencode

from .. import http
from ..cities import City
from ..http import SourceUnavailable
from ..models import Metric, SourceInfo, SourceResult

BASE_URL = "https://api.open-meteo.com/v1/forecast"

# 源的名字（前端会直接显示在指标带上）。
SOURCE_NAME = "Open-Meteo 天气预报"

# 请求 ``current`` 时要的变量。顺序固定，方便比对与排查。
CURRENT_FIELDS = (
    "temperature_2m",
    "relative_humidity_2m",
    "apparent_temperature",
    "weather_code",
    "wind_speed_10m",
    "precipitation",
)

# 降级时占位指标的槽位。
SLOTS = (
    ("weather_temp", "气温", "℃"),
    ("weather_humidity", "相对湿度", "%"),
)

# 观测时间与当前时间差超过这个秒数，就不再声称「实时」。
REALTIME_MAX_AGE_SECONDS = 3600.0

# 上游要求的署名（免费档的授权条件）—— 随数据一起发出去，别只写在文档里。
ATTRIBUTION = "Weather data by open-meteo.com"


def now_iso() -> str:
    """当前时间（ISO8601，UTC，秒精度）。"""
    return to_iso(datetime.now(tz=timezone.utc))


def to_iso(moment: datetime) -> str:
    """带时区的 datetime → ISO8601（UTC，Z 结尾）。"""
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def build_url(city: City) -> str:
    """按城市取数点拼出完整请求地址。

    坐标与时区都来自城市表 —— **不写死**任何一座城市的坐标。
    参数顺序固定，方便在日志里肉眼比对两次请求。
    """
    query = urlencode(
        {
            "latitude": city.latitude,
            "longitude": city.longitude,
            "current": ",".join(CURRENT_FIELDS),
            "timezone": city.timezone,
            "timeformat": "unixtime",
        },
        safe=",",
    )
    return BASE_URL + "?" + query


def _to_float(raw: Any) -> Optional[float]:
    """上游数值 → 浮点数；不是有限数就当没有。"""
    if raw is None or isinstance(raw, bool):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _epoch_seconds(raw: Any) -> Optional[int]:
    """Unix epoch 秒 → int；不是数字就当没有。"""
    value = _to_float(raw)
    return None if value is None else int(value)


def parse_current(payload: Any, now: datetime) -> Dict[str, Any]:
    """把 ``current`` 段落整理成一份规整的字典。

    取不到 ``current``、关键字段（气温 / 湿度 / 观测时刻）不是数字，
    一律抛 :class:`SourceUnavailable` —— 这个源整体降级，
    而不是悄悄交出半个指标。
    """
    if not isinstance(payload, dict):
        raise SourceUnavailable("天气响应不是 JSON 对象")
    current = payload.get("current")
    if not isinstance(current, dict):
        raise SourceUnavailable("天气响应缺少 current")

    temperature = _to_float(current.get("temperature_2m"))
    if temperature is None:
        raise SourceUnavailable("天气响应缺少可用的 temperature_2m")
    humidity = _to_float(current.get("relative_humidity_2m"))
    if humidity is None:
        raise SourceUnavailable("天气响应缺少可用的 relative_humidity_2m")

    observed_epoch = _epoch_seconds(current.get("time"))
    if observed_epoch is None:
        raise SourceUnavailable("天气响应缺少 current.time")
    observed_at = datetime.fromtimestamp(observed_epoch, tz=timezone.utc)
    age = (now - observed_at).total_seconds()

    return {
        "temperature": temperature,
        "humidity": humidity,
        "apparent_temperature": _to_float(current.get("apparent_temperature")),
        "wind_speed_10m": _to_float(current.get("wind_speed_10m")),
        "precipitation": _to_float(current.get("precipitation")),
        "weather_code": _to_float(current.get("weather_code")),
        "observed_at": observed_at,
        "age_seconds": age,
        "realtime": 0 <= age <= REALTIME_MAX_AGE_SECONDS,
        "timezone": payload.get("timezone"),
        "utc_offset_seconds": _to_float(payload.get("utc_offset_seconds")),
    }


def fetch(city: City, timeout: float = http.DEFAULT_TIMEOUT_SECONDS) -> SourceResult:
    """取某个城市的实况天气（数值模式预报）。

    取不到就抛 :class:`SourceUnavailable`（调用方把它算作降级）。
    """
    fetched_at = now_iso()
    url = build_url(city)
    payload = http.request_json(url, timeout=timeout)
    now = datetime.now(tz=timezone.utc)
    parsed = parse_current(payload, now)

    source = SourceInfo(
        name=SOURCE_NAME,
        url=url,
        observed_at=to_iso(parsed["observed_at"]),
        fetched_at=fetched_at,
        realtime=bool(parsed["realtime"]),
        # 数值模式预报，不是站点实测。
        estimated=True,
    )

    extra: Dict[str, Any] = {}
    extra["attribution"] = ATTRIBUTION
    for key in ("apparent_temperature", "wind_speed_10m", "precipitation", "weather_code"):
        value = parsed[key]
        # 上游没给就不放这个键 —— 不放没有来源的数字，也不放 0 冒充。
        if value is not None:
            extra[key] = value
    if parsed["timezone"] is not None:
        extra["timezone"] = parsed["timezone"]
    if parsed["utc_offset_seconds"] is not None:
        extra["utc_offset_seconds"] = parsed["utc_offset_seconds"]

    metrics = [
        Metric(
            key="weather_temp",
            label="气温",
            value=parsed["temperature"],
            unit="℃",
            extra=extra,
            source=source,
        ),
        Metric(
            key="weather_humidity",
            label="相对湿度",
            value=parsed["humidity"],
            unit="%",
            extra=extra,
            source=source,
        ),
    ]
    return SourceResult(metrics=metrics, series=[])
