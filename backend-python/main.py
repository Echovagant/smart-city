from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic_settings import BaseSettings
import os
import uvicorn
import json
from pathlib import Path
from typing import List, Dict, Any, Optional
from data_processor import DataProcessorError, get_data_processor

# 配置管理
class Settings(BaseSettings):
    app_name: str = "SmartCityBackend"
    debug: bool = False
    host: str = "127.0.0.1"
    port: int = 8000
    allowed_origins: str = "http://localhost:5173"

    class Config:
        env_file = ".env"

# 数据目录：硬编码到脚本所在目录（backend-python/）下，不再走 .env。
# 任何 CWD 下运行（VSCode 工作区根、容器、其他目录）都能找到数据。
# 如需迁移数据位置，直接改这两个常量。
BACKEND_DIR = Path(__file__).resolve().parent
DATA_DIR = BACKEND_DIR / "data"
GEOJSON_DIR = BACKEND_DIR / "geojson"

# 初始化配置
settings = Settings()

# 创建FastAPI应用
app = FastAPI(
    title=settings.app_name,
    debug=settings.debug,
    description="智慧城市可视化平台后端API",
    version="1.0.0"
)

# 配置CORS
origins = settings.allowed_origins.split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)

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

# 根路由
@app.get("/")
async def root():
    return {
        "message": "智慧城市后端API服务正在运行",
        "version": "1.0.0",
        "docs": "/docs"
    }

# 健康检查
@app.get("/health")
async def health_check():
    return {"status": "healthy"}

# 模拟数据接口
@app.get("/api/buildings")
async def get_buildings(bbox: Optional[str] = None):
    """获取建筑数据。

    可选 query 参数 bbox=min_lon,min_lat,max_lon,max_lat 用来按范围过滤。
    """
    try:
        data = _load_buildings()
        if bbox:
            try:
                parts = [float(x) for x in bbox.split(",")]
                if len(parts) != 4:
                    raise ValueError
                return processor.filter_features_by_bbox(data, parts)
            except ValueError:
                raise HTTPException(
                    status_code=400,
                    detail="bbox 必须是 4 个逗号分隔的数字：min_lon,min_lat,max_lon,max_lat",
                )
        return data
    except DataProcessorError as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.get("/api/roads")
async def get_roads(bbox: Optional[str] = None):
    """获取道路数据。可选 bbox query 参数。"""
    try:
        data = _load_roads()
        if bbox:
            try:
                parts = [float(x) for x in bbox.split(",")]
                if len(parts) != 4:
                    raise ValueError
                return processor.filter_features_by_bbox(data, parts)
            except ValueError:
                raise HTTPException(
                    status_code=400,
                    detail="bbox 必须是 4 个逗号分隔的数字：min_lon,min_lat,max_lon,max_lat",
                )
        return data
    except DataProcessorError as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.get("/api/traffic-status")
async def get_traffic_status():
    """获取交通状态（占位实现：返回固定值；后续接入实时数据时改造）。"""
    # OSM 不带实时流量；这里保留一个稳定的占位响应，前端 plan 007 会调用它。
    return {
        "status": "normal",
        "congestion_level": 0.3,
        "update_time": "2024-04-24T10:00:00Z",
    }

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug
    )