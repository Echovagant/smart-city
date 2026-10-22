"""聚合器：并发取数 + 缓存 + 降级。

三条硬要求
----------
1. **端点永不 500**：任何一个源失败/超时都只是把它放进 ``degraded``，
   其余指标照常返回。失败永远不冒泡到端点层。
2. **每个源独立超时 5 秒**：慢源只拖慢自己，不拖慢整体。
3. **缓存命中时 ``fetched_at`` 仍是首次取数的时间**：
   缓存里存的就是**第一次取到的那份结果**（连同它当时的 fetched_at），
   所以「数据有多旧」在响应里看得出来。缓存期不刷新时间戳。

并发与超时的实现要点
--------------------
- 取数是**阻塞**的（标准库 urllib），所以丢进线程池（``asyncio.to_thread``），
  不堵事件循环。
- 线程里的函数由 ``_guarded`` 包一层，**永不抛异常**：
  这样 ``wait_for`` 超时取消等待时，后台线程的异常不会被当成
  「Future exception was never retrieved」泄漏到日志里。
"""
import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import city_codes
from .http import SourceUnavailable
from .models import CityOverview, Metric, Series, SourceResult, unavailable_metrics
from .sources import air_quality, road_network, weather

logger = logging.getLogger(__name__)

# 单个源的总预算（秒）。超过就把这个源算作降级。
SOURCE_TIMEOUT_SECONDS = 5.0

# 缓存期。空气质量是小时级数据，30 分钟够；天气 10 分钟；
# 静态路网指标是本地文件，进程内常驻。
AIR_QUALITY_TTL_SECONDS = 1800.0
WEATHER_TTL_SECONDS = 600.0
STATIC_TTL_SECONDS = float("inf")

# 指标在响应里的固定顺序。前端按 key 取值，这个顺序只影响可读性。
METRIC_ORDER: Tuple[str, ...] = (
    "aqi",
    "pm25",
    "pm10",
    "o3",
    "no2",
    "so2",
    "co",
    "weather_temp",
    "weather_humidity",
    "building_count",
    "road_count",
    "road_length_km",
    "coverage_area_km2",
    "road_count_main",
    "road_count_secondary",
    "road_count_local",
    "road_count_footway",
    "road_count_other",
    "road_load_index",
)


def now_iso() -> str:
    """当前时间（ISO8601，UTC，秒精度）。"""
    return (
        datetime.now(tz=timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


@dataclass
class SourceSpec:
    """一个数据源的取数计划。"""

    name: str
    url: str
    slots: Tuple[Tuple[str, str, str], ...]
    ttl: float
    cache_key: str
    fetch: Callable[[], SourceResult]
    # 降级占位指标的 estimated 标记（路网负载本身就是估算）。
    estimated: bool = False


@dataclass
class _CacheEntry:
    """一个缓存条目。

    ``stored_at`` 是 None 表示「还没成功取到过」——
    取数失败**不**写缓存（否则坏数据会被缓存住 30 分钟）。
    """

    stored_at: Optional[float] = None
    result: SourceResult = field(default_factory=SourceResult)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


# 进程内缓存。key 见 SourceSpec.cache_key。
_cache: Dict[str, _CacheEntry] = {}


def clear_cache() -> None:
    """清空聚合器的缓存（测试与热更新用）。"""
    _cache.clear()


def _guarded(fn: Callable[[], SourceResult]) -> Any:
    """在线程里跑的包装：**永不抛异常**，失败时把异常对象当返回值。

    这样超时取消等待之后，后台线程也不会产生「未取用的异常」。
    """
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 —— 这里就是要兜住一切
        return exc


async def _call_with_timeout(
    fn: Callable[[], SourceResult], timeout: Optional[float] = None
) -> SourceResult:
    """在线程池里调用 fn，最多等 timeout 秒。

    ``timeout`` 省略时读模块级的 ``SOURCE_TIMEOUT_SECONDS``（**调用时**读，
    这样测试可以把它改小，不必真的等 5 秒）。
    """
    budget = SOURCE_TIMEOUT_SECONDS if timeout is None else timeout
    outcome = await asyncio.wait_for(asyncio.to_thread(_guarded, fn), budget)
    if isinstance(outcome, BaseException):
        raise outcome
    return outcome


async def _fetch_spec(spec: SourceSpec) -> SourceResult:
    """带缓存的取数。"""
    entry = _cache.get(spec.cache_key)
    if entry is None:
        entry = _CacheEntry()
        _cache[spec.cache_key] = entry

    now = time.monotonic()
    if entry.stored_at is not None and (now - entry.stored_at) < spec.ttl:
        return entry.result

    # 同一个 key 并发进来时只让一个线程去取，其余等它（避免惊群）。
    async with entry.lock:
        now = time.monotonic()
        if entry.stored_at is not None and (now - entry.stored_at) < spec.ttl:
            return entry.result
        result = await _call_with_timeout(spec.fetch)
        entry.result = result
        entry.stored_at = time.monotonic()
        return result


def _build_specs(
    city_code: int,
    buildings_path: Optional[Path],
    roads_path: Optional[Path],
) -> List[SourceSpec]:
    """列出本城市要取的四个源。"""
    history_url = air_quality.HISTORY_URL + "?citycode=%s" % city_code
    weather_cityid = city_codes.WEATHER_CITY_IDS.get(city_code)
    weather_url = (
        weather.BASE_URL + weather_cityid + ".html"
        if weather_cityid
        else weather.BASE_URL + "<cityid>"
    )
    roads_key = "roads:%s:%s" % (buildings_path or road_network.DEFAULT_BUILDINGS_PATH,
                                 roads_path or road_network.DEFAULT_ROADS_PATH)

    return [
        SourceSpec(
            name=air_quality.SOURCE_NAME,
            url=air_quality.REALTIME_URL,
            slots=air_quality.REALTIME_SLOTS,
            ttl=AIR_QUALITY_TTL_SECONDS,
            cache_key="aqi:realtime:%s" % city_code,
            fetch=lambda: air_quality.fetch_realtime(city_code),
        ),
        SourceSpec(
            name=air_quality.HISTORY_SOURCE_NAME,
            url=history_url,
            slots=air_quality.HISTORY_SLOTS,
            ttl=AIR_QUALITY_TTL_SECONDS,
            cache_key="aqi:history:%s" % city_code,
            fetch=lambda: air_quality.fetch_history(city_code),
        ),
        SourceSpec(
            name=weather.SOURCE_NAME,
            url=weather_url,
            slots=weather.SLOTS,
            ttl=WEATHER_TTL_SECONDS,
            cache_key="weather:%s" % city_code,
            fetch=lambda: weather.fetch(city_code),
        ),
        SourceSpec(
            name=road_network.SOURCE_NAME,
            url="backend-python/geojson/roads.geojson",
            slots=road_network.SLOTS,
            ttl=STATIC_TTL_SECONDS,
            cache_key=roads_key,
            fetch=lambda: road_network.fetch(buildings_path, roads_path),
            estimated=True,
        ),
    ]


def source_names(city_code: int) -> List[str]:
    """这个城市涉及的**全部**源的名字。

    聚合器整体出意外时用它构造一份「全部降级」的响应。
    """
    return [spec.name for spec in _build_specs(city_code, None, None)]


def _order_metrics(metrics: List[Metric]) -> List[Metric]:
    """按 METRIC_ORDER 排序；表里没有的 key 排在后面（保持原顺序）。"""
    rank = {key: index for index, key in enumerate(METRIC_ORDER)}
    return sorted(
        metrics,
        key=lambda metric: rank.get(metric.key, len(METRIC_ORDER)),
    )


async def build_city_overview(
    city_code: int,
    *,
    buildings_path: Optional[Path] = None,
    roads_path: Optional[Path] = None,
) -> CityOverview:
    """聚合一个城市的运行指标。

    四个源**并发**取数（``asyncio.gather``），每个源独立超时。
    取不到的源进 ``degraded``，并在它的槽位上留下 ``value = null`` 的占位指标
    （前端据此显示「数据源暂不可用」，不会拿 0 或旧值冒充）。
    """
    specs = _build_specs(city_code, buildings_path, roads_path)
    outcomes = await asyncio.gather(
        *[_fetch_spec(spec) for spec in specs],
        return_exceptions=True,
    )

    metrics: List[Metric] = []
    series: List[Series] = []
    degraded: List[str] = []
    city_info: Dict[str, Any] = {
        "code": city_code,
        "name": city_codes.city_name(city_code),
        "latitude": None,
        "longitude": None,
    }

    for spec, outcome in zip(specs, outcomes):
        if isinstance(outcome, BaseException):
            # 取数失败：记日志、进 degraded、留占位指标。**不抛出去**。
            logger.warning("数据源不可用：%s（%s）", spec.name, outcome)
            degraded.append(spec.name)
            metrics.extend(
                unavailable_metrics(
                    spec.slots,
                    spec.name,
                    spec.url,
                    now_iso(),
                    estimated=spec.estimated,
                )
            )
            continue
        metrics.extend(outcome.metrics)
        series.extend(outcome.series)
        if outcome.city:
            city_info = outcome.city

    return CityOverview(
        city=city_info,
        generated_at=now_iso(),
        metrics=_order_metrics(metrics),
        series=series,
        degraded=degraded,
    )
