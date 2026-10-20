from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from pydantic_settings import BaseSettings
from collections import OrderedDict
import logging
import math
import os
import uvicorn
import json
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
from data_processor import DataProcessorError, get_data_processor

logger = logging.getLogger(__name__)

# 数据缺失或损坏时统一返回给调用方的文案。
# 细节（含服务端绝对路径）只写日志，不回显给调用方。
DATA_UNAVAILABLE_DETAIL = "城市数据暂时不可用，请稍后重试"

# bbox 参数非法时的统一文案，追加具体原因后返回。
BBOX_DETAIL = "bbox 必须是 4 个逗号分隔的数字：min_lon,min_lat,max_lon,max_lat"

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

    class Config:
        env_file = ".env"

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
# minimum_size=1000 让 /health 这类小响应保持不压缩。
app.add_middleware(GZipMiddleware, minimum_size=1000)

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


def _clear_caches() -> None:
    """清空全部模块级缓存：原始 GeoJSON + 按 bbox 的过滤结果。"""
    global _buildings_cache, _roads_cache
    _buildings_cache = None
    _roads_cache = None
    _buildings_bbox_cache.clear()
    _roads_bbox_cache.clear()


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
async def get_buildings(bbox: Optional[str] = None):
    """获取建筑数据。

    可选 query 参数 bbox=min_lon,min_lat,max_lon,max_lat 用来按范围过滤。
    """
    # 参数不合法是调用方的问题（400），先校验再动数据。
    parsed = _parse_bbox(bbox) if bbox is not None else None
    try:
        data = _load_buildings()
        if parsed is not None:
            return _filtered_collection(_buildings_bbox_cache, data, parsed)
        return _as_feature_collection(data)
    except DataProcessorError:
        # 数据缺失或损坏是我们的问题（503）：细节只写日志，不回显给调用方。
        logger.exception("建筑数据不可用")
        raise HTTPException(status_code=503, detail=DATA_UNAVAILABLE_DETAIL)


@app.get("/api/roads", dependencies=[Depends(require_api_key)])
async def get_roads(bbox: Optional[str] = None):
    """获取道路数据。可选 bbox query 参数。"""
    parsed = _parse_bbox(bbox) if bbox is not None else None
    try:
        data = _load_roads()
        if parsed is not None:
            return _filtered_collection(_roads_bbox_cache, data, parsed)
        return _as_feature_collection(data)
    except DataProcessorError:
        logger.exception("道路数据不可用")
        raise HTTPException(status_code=503, detail=DATA_UNAVAILABLE_DETAIL)


@app.get("/api/traffic-status")
async def get_traffic_status():
    """获取交通状态（占位实现：返回固定值；后续接入实时数据时改造）。"""
    # OSM 不带实时流量；这里保留一个稳定的占位响应，前端 plan 007 会调用它。
    return {
        "status": "normal",
        "congestion_level": 0.3,
        "update_time": "2024-04-24T10:00:00Z",
    }

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