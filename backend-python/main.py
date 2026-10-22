from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import MutableHeaders
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from collections import OrderedDict
import logging
import math
import os
import time
import uvicorn
import json
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
from data_processor import DataProcessorError, get_data_processor
from city_data import aggregator as city_aggregator
from city_data import city_codes
from city_data.models import CityOverview

logger = logging.getLogger(__name__)

# 数据缺失或损坏时统一返回给调用方的文案。
# 细节（含服务端绝对路径）只写日志，不回显给调用方。
DATA_UNAVAILABLE_DETAIL = "城市数据暂时不可用，请稍后重试"

# bbox 参数非法时的统一文案，追加具体原因后返回。
BBOX_DETAIL = "bbox 必须是 4 个逗号分隔的数字：min_lon,min_lat,max_lon,max_lat"

# cityCode 参数非法时的统一文案。
CITY_CODE_DETAIL = (
    "cityCode 必须是 cnemc 城市/省份代码表里的六位代码，例如 110000（北京）"
)

# 响应压缩参数。必须与 Starlette 的 GZipMiddleware 保持一致：
# 「全量响应缓存」预压缩出来的字节要靠这组参数与中间件自己压的结果对齐。
# minimum_size 让 /health 这类小响应保持不压缩（压几百字节只会更大）。
GZIP_MINIMUM_SIZE = 1000
GZIP_COMPRESSLEVEL = 9

# 安全响应头。集中在这里，方便按部署形态统一调整或整体关掉。
#
# X-Content-Type-Options: nosniff —— 告诉浏览器不要猜响应的 MIME 类型。
#   本服务把 GeoJSON 以 application/json 返回，若被诱导按别的类型解释会有 MIME 混淆风险。
# Referrer-Policy —— 页面里的跨源请求会把 Referer 带给第三方，收紧它。
# X-Frame-Options —— 阻止被 iframe 嵌套（点击劫持）。
#
# 这三个头都没有副作用：不改变响应体、content-type 与 content-length。
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "SAMEORIGIN",
}


def _read_csp_report_only() -> str:
    """读 CSP report-only 开关（环境变量 CSP_REPORT_ONLY）。空串表示关闭。

    CSP 只以 report-only 形式开启：先观测 Cesium 实际需要什么，
    再决定要不要升级成强制策略。report-only 不拦截任何东西，只报告。
    """
    return os.environ.get("CSP_REPORT_ONLY", "").strip()


# 开关的当前值：import 时读一次环境变量。
CSP_REPORT_ONLY = _read_csp_report_only()

# 配置管理
class Settings(BaseSettings):
    app_name: str = "SmartCityBackend"
    debug: bool = False
    host: str = "127.0.0.1"
    port: int = 8000
    allowed_origins: str = "http://localhost:5173"
    # 可选的共享 API key：设了就校验 X-API-Key，没设就不启用（开发零摩擦）。
    api_key: Optional[str] = None
    # 逗号分隔的 Host 白名单；留空表示不限制。
    allowed_hosts: str = ""
    # 是否暴露 /docs /redoc /openapi.json。生产默认关闭。
    expose_docs: bool = False

    # class-based Config 在 pydantic v2 已废弃，改用 model_config。
    model_config = SettingsConfigDict(env_file=".env")

# 数据目录：硬编码到脚本所在目录（backend-python/）下，不再走 .env。
# 任何 CWD 下运行（VSCode 工作区根、容器、其他目录）都能找到数据。
# 如需迁移数据位置，直接改这两个常量。
BACKEND_DIR = Path(__file__).resolve().parent
DATA_DIR = BACKEND_DIR / "data"
GEOJSON_DIR = BACKEND_DIR / "geojson"

# 前端构建产物目录。存在时由本进程直接托管，于是页面与 /api/... 同源，
# 不需要额外的反代——Vite 的 /api 代理只在 dev 生效。
FRONTEND_DIST = BACKEND_DIR.parent / "Data-driven-modeling" / "dist"

# 初始化配置
settings = Settings()


def _normalize_origins(raw: str) -> List[str]:
    """解析 CORS 允许来源列表。

    - 去掉每项首尾空白，丢弃空项
    - 去重且保持原有顺序
    - 拒绝 "*"：本 API 开启了 allow_credentials=True，通配符会让 Starlette 回显任意 Origin
    - 结果为空时直接失败

    配置写错时在这里直接抛错（启动即失败），好过静默放行任意来源。
    """
    origins: List[str] = []
    for item in raw.split(","):
        origin = item.strip()
        if not origin:
            continue
        if origin == "*":
            raise ValueError(
                "allowed_origins 不允许使用 '*'：本 API 开启了 allow_credentials=True，"
                "通配符会让任意来源都能带凭据读取响应"
            )
        if origin not in origins:
            origins.append(origin)
    if not origins:
        raise ValueError("allowed_origins 不能为空：请至少配置一个允许的来源")
    return origins


def require_api_key(x_api_key: Optional[str] = Header(default=None)) -> None:
    """可选的共享 API key 校验。

    两个必须遵守的点（都实测过）：
    1. 「未配置即放行」必须是第一行 —— 否则开发环境会被 401 挡住。
    2. Header(default=None) 必须显式写 —— 省略 Header() 时 FastAPI 会把
       x_api_key 当成查询参数，header 永远读不到，带对 key 也一律 401。

    「未配置」包括两种情况：环境里没有 API_KEY，以及 API_KEY=（空值）。
    后者很常见 —— .env.example 里写的就是 `API_KEY=`，照抄成 .env 之后
    pydantic-settings 读出来的是空串而不是 None；只判 None 会让空串被
    当成一个合法（且为空的）密钥，于是每个请求都 401。

    依赖在**调用时**读 settings，这样运行时改配置立即生效。
    """
    if not settings.api_key:
        return
    if x_api_key != settings.api_key:
        raise HTTPException(status_code=401, detail="需要 API key")


def _document_urls(expose: bool) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """决定三个文档相关路由是否注册。

    返回 (openapi_url, docs_url, redoc_url)；不暴露时三个都是 None，
    此时访问 /docs、/redoc、/openapi.json 都会得到 404。
    """
    if expose:
        return "/openapi.json", "/docs", "/redoc"
    return None, None, None


def _allowed_hosts(raw: str) -> List[str]:
    """解析 Host 白名单；空字符串表示不限制。"""
    return [host.strip() for host in raw.split(",") if host.strip()]


def _security_headers() -> Dict[str, str]:
    """当前要附加到响应上的安全头。

    三个基础头固定带上；CSP 只在开关打开时以 report-only 形式附加。
    任何时候都不加强制头 Content-Security-Policy——强制策略要先把
    Cesium 实际需要什么观测清楚，否则会让 worker 加载失败、地图一片空白。
    """
    headers = dict(SECURITY_HEADERS)
    if CSP_REPORT_ONLY:
        headers["Content-Security-Policy-Report-Only"] = CSP_REPORT_ONLY
    return headers


class SecurityHeadersMiddleware:
    """给每个响应补上安全响应头（纯 ASGI 中间件）。

    刻意不用 BaseHTTPMiddleware——它会把响应体包成流，改变字节层面的行为，
    而「两次请求响应体逐字节相同」正是全量响应缓存成立的前提。
    这里只在 http.response.start 消息上追加响应头，响应体一个字节都不碰。
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        # lifespan 等非 http 的 scope 原样放行。
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_security_headers(message):
            if message["type"] == "http.response.start":
                # MutableHeaders 直接改的是这条消息上的 header 列表，
                # 不碰 content-type / content-length，也不碰响应体。
                headers = MutableHeaders(scope=message)
                for name, value in _security_headers().items():
                    headers[name] = value
            await send(message)

        await self.app(scope, receive, send_with_security_headers)


# 创建FastAPI应用
_openapi_url, _docs_url, _redoc_url = _document_urls(settings.expose_docs)
app = FastAPI(
    title=settings.app_name,
    debug=settings.debug,
    description="智慧城市可视化平台后端API",
    version="1.0.0",
    openapi_url=_openapi_url,
    docs_url=_docs_url,
    redoc_url=_redoc_url
)

# 配置CORS
origins = _normalize_origins(settings.allowed_origins)
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)

# Host 头白名单：留空不限制；生产建议设成实际域名。
_hosts = _allowed_hosts(settings.allowed_hosts)
if _hosts:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=_hosts)

# 响应压缩：GeoJSON 是高度可压缩的文本，实测能把 /api/buildings 从
# 1341 KB 压到约 225 KB。必须在 app 启动前添加——app 一旦启动，
# add_middleware 会抛 RuntimeError。
app.add_middleware(
    GZipMiddleware,
    minimum_size=GZIP_MINIMUM_SIZE,
    compresslevel=GZIP_COMPRESSLEVEL,
)

# 安全响应头：每个响应都补上 X-Content-Type-Options / Referrer-Policy / X-Frame-Options。
# 放在 GZipMiddleware 之后注册——add_middleware 是「后注册的在最外层」，
# 于是这里看到的是已经压缩完的最终响应，加头不会碰到响应体。
# 必须在 app 启动前添加（与 GZipMiddleware 同样的约束）。
app.add_middleware(SecurityHeadersMiddleware)

# 确保数据目录存在
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(GEOJSON_DIR, exist_ok=True)

# 初始化数据处理器
processor = get_data_processor(str(DATA_DIR))

# GeoJSON 文件路径（user-provided OSM data）。
_buildings_path = GEOJSON_DIR / "buildings.geojson"
_roads_path = GEOJSON_DIR / "roads.geojson"

# 启动时缓存已加载的 GeoJSON；如加载失败则在第一次请求时再试并返回 5xx。
_buildings_cache: Optional[Dict[str, Any]] = None
_roads_cache: Optional[Dict[str, Any]] = None

# 按 bbox 的过滤结果缓存。
# key 是校验过的规范化 bbox 元组（同一个 bbox 无论字符串里有多少空白、多少位小数，
# 都落到同一个条目）；条目同时记下产生它的那份原始数据对象——
# 原始数据重新加载后（换了一个对象）旧条目自动作废，
# 这样过滤结果不会和 _buildings_cache / _roads_cache 不同步。
# 容量有上限：客户端不能靠发一堆不同 bbox 把内存撑爆。
_BBOX_CACHE_MAX_ENTRIES = 8

_buildings_bbox_cache: "OrderedDict[Tuple[float, float, float, float], Tuple[Any, Dict[str, Any]]]" = OrderedDict()
_roads_bbox_cache: "OrderedDict[Tuple[float, float, float, float], Tuple[Any, Dict[str, Any]]]" = OrderedDict()

# 全量响应（不带 bbox）的序列化结果缓存。
#
# 模块级的 GeoJSON 缓存存的是**解析后**的 Python 对象，每次请求仍要重新
# jsonable_encoder + json.dumps 一遍（实测 3854 个要素约 190 ms），
# 再由 GZipMiddleware 压一遍（实测 3.4 MB 在 level 9 下约 110 ms）。
# 源数据不变时全量响应是**逐字节确定**的，所以序列化结果与压缩结果都能缓存。
#
# key 是 "buildings" / "roads"：全量响应只有一个变体（不带 bbox）。
# 带 bbox 的路径**不缓存**——参数组合无界，缓存多少都救不了。
# 值是 (原始数据对象, 未压缩字节, gzip 字节或 None)：
#   - 记下原始数据对象是多一道保险：数据重新加载后（换了对象）旧条目自动作废；
#   - gzip 字节为 None 表示响应体小于 GZIP_MINIMUM_SIZE，不压缩（与中间件规则一致）。
_full_response_cache: Dict[str, Tuple[Any, bytes, Optional[bytes]]] = {}


def _clear_caches() -> None:
    """清空全部模块级缓存：原始 GeoJSON + 按 bbox 的过滤结果 + 全量响应序列化结果。"""
    global _buildings_cache, _roads_cache
    _buildings_cache = None
    _roads_cache = None
    _buildings_bbox_cache.clear()
    _roads_bbox_cache.clear()
    _full_response_cache.clear()


def _load_buildings() -> Dict[str, Any]:
    global _buildings_cache
    if _buildings_cache is None:
        _buildings_cache = processor.load_geojson(str(_buildings_path))
    return _buildings_cache


def _load_roads() -> Dict[str, Any]:
    global _roads_cache
    if _roads_cache is None:
        _roads_cache = processor.load_geojson(str(_roads_path))
    return _roads_cache


def _bbox_cache_key(bbox: "BBox") -> Tuple[float, float, float, float]:
    """规范化缓存 key：同一组边界值总是得到同一个 key。"""
    return (bbox.min_lon, bbox.min_lat, bbox.max_lon, bbox.max_lat)


def _as_feature_collection(data: Dict[str, Any]) -> Dict[str, Any]:
    """把原始集合转成与过滤结果同构的 FeatureCollection（只保留 type + features）。

    原始文件还带 overpass 导出的元信息（generator / copyright / timestamp），
    而过滤后的结果没有。统一成同一种结构后，
    「带 bbox」和「不带 bbox」两种取数方式给前端的负载完全一致，
    换取数方式不会让响应体变大。
    """
    return {"type": "FeatureCollection", "features": data.get("features", [])}


def _filtered_collection(
    cache: "OrderedDict[Tuple[float, float, float, float], Tuple[Any, Dict[str, Any]]]",
    data: Dict[str, Any],
    bbox: "BBox",
) -> Dict[str, Any]:
    """按 bbox 过滤原始集合，并缓存结果。

    同一份数据 + 同一个 bbox 只过滤一次；重复请求直接命中缓存。
    """
    key = _bbox_cache_key(bbox)
    entry = cache.get(key)
    if entry is not None:
        source, result = entry
        if source is data:
            cache.move_to_end(key)  # LRU：刚用过的条目留在最后
            return result
        # 原始数据已经换了对象（重新加载过），旧结果作废。
        del cache[key]

    result = processor.filter_features_by_bbox(data, bbox.as_list())
    cache[key] = (data, result)
    cache.move_to_end(key)
    while len(cache) > _BBOX_CACHE_MAX_ENTRIES:
        cache.popitem(last=False)  # 淘汰最久未用的条目
    return result


def _render_collection_bytes(collection: Dict[str, Any]) -> bytes:
    """把集合渲染成响应体字节。

    刻意复用 FastAPI 自己的两段式序列化（jsonable_encoder → JSONResponse.render），
    这样缓存下来的字节与「不缓存时 FastAPI 返回的字节」逐字节相同，客户端看不出差别。
    """
    return JSONResponse(content=jsonable_encoder(collection)).body


def _gzip_bytes(payload: bytes) -> bytes:
    """按 GZipMiddleware 的参数压缩：level 9、gzip 容器（wbits=16+MAX_WBITS）。

    参数与 Starlette 的 GZipMiddleware 一致，压出来的字节与中间件自己压的逐字节相同。
    """
    compressor = zlib.compressobj(GZIP_COMPRESSLEVEL, zlib.DEFLATED, 16 + zlib.MAX_WBITS)
    return compressor.compress(payload) + compressor.flush()


def _accepts_gzip(request: Request) -> bool:
    """判断客户端是否接受 gzip。

    判定方式与 Starlette 的 GZipMiddleware 一致（子串匹配），
    免得出现「中间件认为该压、这里认为不该压」的分歧。
    """
    return "gzip" in request.headers.get("Accept-Encoding", "")


def _render_full_payload(collection: Dict[str, Any]) -> Tuple[bytes, Optional[bytes]]:
    """渲染全量响应体，并按需预压缩。

    小于 GZIP_MINIMUM_SIZE 的响应不压缩——与 GZipMiddleware 的规则一致，
    压一个几百字节的响应只会更大。
    """
    plain = _render_collection_bytes(collection)
    if len(plain) < GZIP_MINIMUM_SIZE:
        return plain, None
    return plain, _gzip_bytes(plain)


async def _full_response(request: Request, kind: str, data: Dict[str, Any]) -> Response:
    """返回「不带 bbox」的全量响应，序列化结果与压缩结果都走缓存。

    缓存挂在 _clear_caches() 上：源数据换了必须重新序列化，
    否则就是线上返回过期数据（改了数据还是旧城市）。
    """
    entry = _full_response_cache.get(kind)
    if entry is None or entry[0] is not data:
        # 序列化 + 压缩实测约 300 ms，丢到线程池里做，别把事件循环堵住。
        plain, gzipped = await run_in_threadpool(
            _render_full_payload, _as_feature_collection(data)
        )
        entry = (data, plain, gzipped)
        _full_response_cache[kind] = entry

    _, plain, gzipped = entry
    headers = {"Vary": "Accept-Encoding"}
    if gzipped is not None and _accepts_gzip(request):
        # 带上 Content-Encoding: gzip —— GZipMiddleware 见到这个头会原样放行，不会压第二遍。
        headers["Content-Encoding"] = "gzip"
        return Response(content=gzipped, media_type="application/json", headers=headers)
    return Response(content=plain, media_type="application/json", headers=headers)


class BBox(BaseModel):
    """bbox 查询参数：min_lon,min_lat,max_lon,max_lat。

    数值范围与 min < max 的约束由模型自身保证，非法输入统一转成 400。
    """

    # float("nan") / float("inf") 能解析成功，必须显式拒绝。
    model_config = ConfigDict(allow_inf_nan=False)

    min_lon: float = Field(..., ge=-180.0, le=180.0)
    min_lat: float = Field(..., ge=-90.0, le=90.0)
    max_lon: float = Field(..., ge=-180.0, le=180.0)
    max_lat: float = Field(..., ge=-90.0, le=90.0)

    @model_validator(mode="after")
    def _check_order(self) -> "BBox":
        """校验 min < max：倒置的框会静默返回全部要素。"""
        if self.min_lon >= self.max_lon:
            raise ValueError("min_lon 必须小于 max_lon")
        if self.min_lat >= self.max_lat:
            raise ValueError("min_lat 必须小于 max_lat")
        return self

    def as_list(self) -> List[float]:
        """转成 filter_features_by_bbox 需要的 [min_lon, min_lat, max_lon, max_lat]。"""
        return [self.min_lon, self.min_lat, self.max_lon, self.max_lat]


def _bbox_detail(reason: str) -> str:
    """统一的 400 文案：在既有提示语后追加具体的违规原因。"""
    return f"{BBOX_DETAIL}（{reason}）"


def _bbox_reason(exc: ValidationError) -> str:
    """把 pydantic 的校验错误翻译成中文原因。"""
    error = exc.errors()[0]
    error_type = error.get("type")
    if error_type == "value_error":
        # 来自 BBox._check_order 的顺序校验，原始消息已经是中文。
        cause = error.get("ctx", {}).get("error")
        if cause is not None and cause.args:
            return str(cause.args[0])
        return str(error.get("msg", "")).replace("Value error, ", "")
    field = str(error.get("loc", ("",))[0]) if error.get("loc") else ""
    if field in ("min_lon", "max_lon"):
        return "经度必须在 -180 到 180 之间"
    if field in ("min_lat", "max_lat"):
        return "纬度必须在 -90 到 90 之间"
    if error_type == "finite_number":
        return "必须是有限数字，不能是 nan 或 inf"
    return str(error.get("msg", "格式不正确"))


def _parse_bbox(raw: str) -> BBox:
    """把 bbox 查询串解析成 BBox。

    任何不合法的输入都抛 400（调用方的问题），与数据是否可用无关。
    """
    parts = raw.split(",")
    if len(parts) != 4:
        raise HTTPException(status_code=400, detail=_bbox_detail("需要 4 个值"))
    values = []
    for index, part in enumerate(parts, start=1):
        try:
            value = float(part.strip())
        except ValueError:
            raise HTTPException(status_code=400, detail=_bbox_detail(f"第 {index} 个值不是数字"))
        if not math.isfinite(value):
            raise HTTPException(
                status_code=400,
                detail=_bbox_detail(f"第 {index} 个值必须是有限数字，不能是 nan 或 inf"),
            )
        values.append(value)
    try:
        return BBox(
            min_lon=values[0],
            min_lat=values[1],
            max_lon=values[2],
            max_lat=values[3],
        )
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=_bbox_detail(_bbox_reason(e)))


# 根路由
@app.get("/")
async def root():
    # 前端构建产物存在时，根路径直接返回页面——部署形态下打开 http://host:8000/
    # 就是应用本身。静态挂载（mount_frontend）注册在所有路由之后，优先级更低，
    # 抢不到 "/" 这条已注册的路由，所以这里要把 index.html 自己交出去。
    # 没有构建产物时保留原来的服务信息 JSON（纯后端部署形态）。
    index = FRONTEND_DIST / "index.html"
    if index.is_file():
        return FileResponse(index)
    banner = {
        "message": "智慧城市后端API服务正在运行",
        "version": "1.0.0",
    }
    # 文档路由默认不暴露（Settings.expose_docs 默认 False），此时 /docs 是 404。
    # 不能无条件宣称它可用——服务 banner 是运维和探针看的第一手信息。
    # 在调用时读 settings，和 require_api_key 一致：运行时改配置立即生效。
    if settings.expose_docs:
        banner["docs"] = "/docs"
    return banner

# 健康检查
@app.get("/health")
async def health_check():
    return {"status": "healthy"}

# 模拟数据接口
@app.get("/api/buildings", dependencies=[Depends(require_api_key)])
async def get_buildings(request: Request, bbox: Optional[str] = None):
    """获取建筑数据。

    可选 query 参数 bbox=min_lon,min_lat,max_lon,max_lat 用来按范围过滤。
    不带 bbox 走全量响应缓存（序列化结果复用），带 bbox 每次现算。
    """
    # 参数不合法是调用方的问题（400），先校验再动数据。
    parsed = _parse_bbox(bbox) if bbox is not None else None
    try:
        data = _load_buildings()
        if parsed is not None:
            return _filtered_collection(_buildings_bbox_cache, data, parsed)
        return await _full_response(request, "buildings", data)
    except DataProcessorError:
        # 数据缺失或损坏是我们的问题（503）：细节只写日志，不回显给调用方。
        logger.exception("建筑数据不可用")
        raise HTTPException(status_code=503, detail=DATA_UNAVAILABLE_DETAIL)


@app.get("/api/roads", dependencies=[Depends(require_api_key)])
async def get_roads(request: Request, bbox: Optional[str] = None):
    """获取道路数据。可选 bbox query 参数。"""
    parsed = _parse_bbox(bbox) if bbox is not None else None
    try:
        data = _load_roads()
        if parsed is not None:
            return _filtered_collection(_roads_bbox_cache, data, parsed)
        return await _full_response(request, "roads", data)
    except DataProcessorError:
        logger.exception("道路数据不可用")
        raise HTTPException(status_code=503, detail=DATA_UNAVAILABLE_DETAIL)


# 交通状态模型。
#
# 值全部由时间确定性地推导（同一个时间戳永远得到同样的结果），不用随机量：
# 随机值每次刷新都跳变，既不像真实数据，也让测试无法断言。
#
# 三个分量的周期互不成整数倍，叠加后不会同步重复，
# 看起来像真实车流那样「有节律但不可预测」。
_TRAFFIC_PERIOD_DAY = 86400.0        # 一天一个潮汐：白天车多、夜里车少
_TRAFFIC_PERIOD_TIDE = 900.0         # 15 分钟一次中等波动
_TRAFFIC_PERIOD_JITTER = 20.0        # 20 秒一次细节抖动

# 车流量指数的基准值与三个分量的权重。权重之和为 1，
# 加上基准值后结果天然落在 0..1 内，不需要额外裁剪。
_TRAFFIC_FLOW_BASE = 0.55
_TRAFFIC_FLOW_WEIGHT_DAY = 0.30
_TRAFFIC_FLOW_WEIGHT_TIDE = 0.12
_TRAFFIC_FLOW_WEIGHT_JITTER = 0.03

# 拥堵分档：拥堵指数 0..1，越大越堵。
_TRAFFIC_CONGESTION_LEVELS = (
    (0.25, "畅通"),
    (0.50, "轻微拥堵"),
    (0.75, "拥堵"),
)
_TRAFFIC_CONGESTION_SEVERE = "严重拥堵"

_TWO_PI = 2.0 * math.pi


def _now() -> float:
    """当前时间（Unix 时间戳，秒）。

    单独抽成模块级函数是为了让测试能替换成可控时钟：
    于是「同一个端点、两个不同时刻」的结果可以被确定性地断言，
    不必靠 time.sleep 赌时序。
    """
    return time.time()


def _iso_utc(now: float) -> str:
    """Unix 时间戳 → ISO8601（UTC、毫秒精度、Z 结尾）。"""
    moment = datetime.fromtimestamp(now, tz=timezone.utc)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _traffic_flow(now: float) -> float:
    """由时间推导路网车流量指数（0..1，越大车越多）。"""
    daily = math.sin(_TWO_PI * now / _TRAFFIC_PERIOD_DAY + 0.4)
    tide = math.sin(_TWO_PI * now / _TRAFFIC_PERIOD_TIDE + 1.1)
    jitter = math.sin(_TWO_PI * now / _TRAFFIC_PERIOD_JITTER + 2.3)
    return (
        _TRAFFIC_FLOW_BASE
        + _TRAFFIC_FLOW_WEIGHT_DAY * daily
        + _TRAFFIC_FLOW_WEIGHT_TIDE * tide
        + _TRAFFIC_FLOW_WEIGHT_JITTER * jitter
    )


def _traffic_congestion_label(level: float) -> str:
    """拥堵指数 → 中文标签。"""
    for threshold, label in _TRAFFIC_CONGESTION_LEVELS:
        if level < threshold:
            return label
    return _TRAFFIC_CONGESTION_SEVERE


def _traffic_status_code(level: float) -> str:
    """拥堵指数 → 粗粒度状态（机器可读）。"""
    if level < 0.25:
        return "normal"
    if level < 0.75:
        return "slow"
    return "congested"


def _traffic_status_payload(now: float) -> Dict[str, Any]:
    """把时间换算成一份交通状态响应（纯函数）。

    同样的时间戳永远得到同样的结果：既能当「实时读数」用，也能被测试断言。
    """
    flow = round(_traffic_flow(now), 4)
    # 拥堵指数：车流越大越堵，但不是线性关系——
    # 路网容量有限，高车流不会线性地变成高拥堵，所以取流量的平方。
    congestion_level = round(flow * flow, 4)
    return {
        "status": _traffic_status_code(congestion_level),
        "congestion_level": congestion_level,
        "congestion": _traffic_congestion_label(congestion_level),
        "flow": flow,
        "update_time": _iso_utc(now),
    }


@app.get("/api/traffic-status")
async def get_traffic_status():
    """获取交通状态。

    值由当前时间确定性地推导（同样的时间得到同样的值）：
    既没有写死的常量，也不含随机跳变——前端拿到的是一条会动的读数。

    不挂 require_api_key：前端不携带 key，这个端点必须始终可访问。
    """
    return _traffic_status_payload(_now())


@app.get("/api/city/overview")
async def get_city_overview(cityCode: str = "110000"):
    """城市运行指标聚合：空气质量 / 天气 / 路网静态指标。

    - ``cityCode`` 默认 110000（北京），只接受 cnemc 城市/省份代码表里的值，
      否则 400（参数问题与数据是否可用无关，先校验再取数）。
    - **端点永不 500**：任何一个上游源失败或超时都只是把它放进 ``degraded``，
      其余指标照常返回；取不到的指标值是 null，不拿 0 或旧值冒充。
    - 响应带 ``Cache-Control``（前端 30 秒缓存）与 ``X-Data-Generated-At``（排查用）。
    """
    try:
        code = int(cityCode)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=CITY_CODE_DETAIL)
    if not city_codes.is_known_city_code(code):
        raise HTTPException(status_code=400, detail=CITY_CODE_DETAIL)

    try:
        overview = await city_aggregator.build_city_overview(
            code,
            buildings_path=_buildings_path,
            roads_path=_roads_path,
        )
    except Exception:
        # 聚合器已经把「单个源失败」处理成降级了；走到这里说明是聚合器自身的
        # 意外错误。大屏不能因此白屏，所以返回一份「全部降级」的 200，
        # 细节只写日志。
        logger.exception("城市指标聚合失败")
        overview = CityOverview(
            city={
                "code": code,
                "name": city_codes.city_name(code),
                "latitude": None,
                "longitude": None,
            },
            generated_at=city_aggregator.now_iso(),
            metrics=[],
            series=[],
            degraded=city_aggregator.source_names(code),
        )

    return JSONResponse(
        content=jsonable_encoder(overview),
        headers={
            "Cache-Control": "public, max-age=30",
            "X-Data-Generated-At": overview.generated_at,
        },
    )


def mount_frontend(app: FastAPI, dist_dir: Path) -> bool:
    """把前端构建产物挂到根路径。返回是否挂载成功。

    必须在所有路由注册之后调用：挂载点是「兜底」，注册得越晚，
    前面注册的真实路由越优先。实测顺序：/api/* 先注册 → 先匹配；
    mount("/") 后注册 → 只兜底其余路径（未知 /api 路径会落到静态兜底并返回 404）。

    目录不存在时只记一条 warning、不抛错——「还没构建前端」时后端仍要能起来。
    """
    if not dist_dir.is_dir():
        logger.warning(
            "未找到前端构建产物（%s），不挂载静态资源；"
            "构建前端请在 Data-driven-modeling 下执行 npm run build",
            dist_dir,
        )
        return False
    app.mount("/", StaticFiles(directory=str(dist_dir), html=True), name="static")
    logger.info("已挂载前端构建产物：%s", dist_dir)
    return True


# 挂载放在最后：前面的 /api/* 路由先注册，优先级更高。
mount_frontend(app, FRONTEND_DIST)

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug
    )