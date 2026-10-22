"""天气数据源 —— 中国天气网（免 key，但限制很多）。

接口（2026-10-22 实测）
----------------------
``GET http://www.weather.com.cn/data/sk/{cityid}.html`` → 200 JSON::

    {"weatherinfo":{"city":"北京","cityid":"101010100","temp":"18","WD":"东南风",
                    "WS":"1级","SD":"17%","WSE":"1","time":"17:05","rain":"0"}}

已知限制（**务必保留在文档里**）
--------------------------------
1. **只有 ``101010100``（北京）通**：上海 ``101020100``、深圳 ``101280601``
   都会返回 HTML 错误页（HTTP 200 但不是 JSON）。别的城市直接判为不可用，
   不去瞎试其它 cityid。
2. **时间戳可能不新鲜**：上游只给 ``HH:MM``，没有日期。
   实测上游给的时间比本地时间还晚几个小时（本地 12:00 时上游报 17:05），
   说明这个时间戳**不是**可靠的实时观测时间。
   本模块的处理是：按北京时间补上今天的日期；若补出来的时刻落在未来
   （超过 5 分钟容差），就回退一天，取「最近的那个可能时刻」；
   再用「观测时间与当前时间差是否超过 1 小时」决定 ``realtime`` 是 true 还是 false。
   **不新鲜就说不新鲜** —— 契约里如实标出来，前端照实显示。
3. 响应头是 ``text/html``（没有 charset），按 UTF-8 解码；不是 JSON 就是不可用。
"""
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from .. import http
from ..http import SourceUnavailable
from ..models import Metric, SourceInfo, SourceResult

BASE_URL = "http://www.weather.com.cn/data/sk/"

# 上游给的时间没有时区信息时，按北京时间理解。
CHINA_TZ = timezone(timedelta(hours=8))

SOURCE_NAME = "中国天气网"

# 降级时占位指标的槽位。
SLOTS = (
    ("weather_temp", "气温", "℃"),
    ("weather_humidity", "相对湿度", "%"),
)

# 上游只给 HH:MM：允许的最小时间戳容差（超过就认为落在未来）。
FUTURE_TOLERANCE = timedelta(minutes=5)

# 观测时间与当前时间差超过这个秒数，就不再声称「实时」。
REALTIME_MAX_AGE_SECONDS = 3600.0

_TIME_PATTERN = re.compile(r"^(\d{1,2}):(\d{2})$")


def now_iso() -> str:
    """当前时间（ISO8601，UTC，秒精度）。"""
    return to_iso(datetime.now(tz=timezone.utc))


def to_iso(moment: datetime) -> str:
    """带时区的 datetime → ISO8601（UTC，Z 结尾）。"""
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def resolve_observed_at(hhmm: Any, now: datetime) -> Optional[datetime]:
    """把上游的 ``HH:MM`` 还原成一个 UTC 时刻。

    上游不给日期，所以先按「今天」补；若补出来的时刻落在未来
    （超过 5 分钟容差），回退一天 —— 取「最近的那个可能时刻」。
    返回 None 表示上游的时间戳没法解析。
    """
    if not isinstance(hhmm, str):
        return None
    match = _TIME_PATTERN.match(hhmm.strip())
    if not match:
        return None
    hour, minute = int(match.group(1)), int(match.group(2))
    if hour > 23 or minute > 59:
        return None

    local_now = now.astimezone(CHINA_TZ)
    candidate = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if candidate - now > FUTURE_TOLERANCE:
        candidate -= timedelta(days=1)
    return candidate.astimezone(timezone.utc)


def _to_float(raw: Any) -> Optional[float]:
    if raw is None or isinstance(raw, bool):
        return None
    try:
        value = float(str(raw).strip().rstrip("%"))
    except (TypeError, ValueError):
        return None
    return value


def parse_weather(payload: Any, now: datetime) -> Dict[str, Any]:
    """把 ``sk`` 接口的响应整理成一份规整的字典。"""
    if not isinstance(payload, dict):
        raise SourceUnavailable("天气响应不是 JSON 对象")
    info = payload.get("weatherinfo")
    if not isinstance(info, dict):
        raise SourceUnavailable("天气响应缺少 weatherinfo")

    observed = resolve_observed_at(info.get("time"), now)
    age = None if observed is None else (now - observed).total_seconds()
    return {
        "city": info.get("city"),
        "cityid": info.get("cityid"),
        "temperature": _to_float(info.get("temp")),
        "humidity": _to_float(info.get("SD")),
        "direction": info.get("WD"),
        "wind_level": info.get("WS"),
        "rain": _to_float(info.get("rain")),
        "observed_at": observed,
        "age_seconds": age,
        "realtime": age is not None and 0 <= age <= REALTIME_MAX_AGE_SECONDS,
    }


def fetch(city_code: int, timeout: float = http.DEFAULT_TIMEOUT_SECONDS) -> SourceResult:
    """取某个城市的实况天气。

    只有北京有可用的 cityid；别的城市直接判为不可用（不试别的 cityid）。
    """
    from .. import city_codes

    cityid = city_codes.WEATHER_CITY_IDS.get(city_code)
    if cityid is None:
        raise SourceUnavailable(
            "该城市没有可用的 weather.com.cn cityid（实测只有北京 101010100 可用）"
        )

    fetched_at = now_iso()
    url = BASE_URL + cityid + ".html"
    payload = http.request_json(
        url,
        headers={"Referer": "http://www.weather.com.cn/", "Accept": "application/json, text/plain, */*"},
        timeout=timeout,
    )
    now = datetime.now(tz=timezone.utc)
    parsed = parse_weather(payload, now)

    source = SourceInfo(
        name=SOURCE_NAME,
        url=url,
        observed_at=to_iso(parsed["observed_at"]) if parsed["observed_at"] else None,
        fetched_at=fetched_at,
        realtime=bool(parsed["realtime"]),
        estimated=False,
    )

    extra = {
        "city": parsed["city"],
        "cityid": parsed["cityid"],
        "direction": parsed["direction"],
        "wind_level": parsed["wind_level"],
        "rain": parsed["rain"],
        # 上游只给 HH:MM，日期是推断出来的 —— 说清楚，别让人以为是上游给的。
        "time_precision": "upstream gives HH:MM only; the date is inferred (Asia/Shanghai)",
        "stale": parsed["age_seconds"] is not None and parsed["age_seconds"] > REALTIME_MAX_AGE_SECONDS,
    }

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
