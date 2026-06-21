from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic_settings import BaseSettings
import os
import uvicorn
import json
from typing import List, Dict, Any

# 配置管理
class Settings(BaseSettings):
    app_name: str = "SmartCityBackend"
    debug: bool = True
    host: str = "0.0.0.0"
    port: int = 8000
    allowed_origins: str = "http://localhost:5173"
    data_dir: str = "./data"
    geojson_dir: str = "./geojson"

    class Config:
        env_file = ".env"

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
    allow_methods=["*"],
    allow_headers=["*"],
)

# 确保数据目录存在
os.makedirs(settings.data_dir, exist_ok=True)
os.makedirs(settings.geojson_dir, exist_ok=True)

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
async def get_buildings():
    """获取建筑数据"""
    # 这里将返回模拟数据，实际应用中应该从数据库或文件中读取
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "name": "商业中心",
                    "height": 150,
                    "type": "commercial",
                    "address": "市中心商业区"
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[
                        [116.404, 39.915],
                        [116.406, 39.915],
                        [116.406, 39.917],
                        [116.404, 39.917],
                        [116.404, 39.915]
                    ]]
                }
            }
        ]
    }

@app.get("/api/roads")
async def get_roads():
    """获取道路数据"""
    # 模拟道路数据
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "name": "主干道",
                    "width": 30,
                    "type": "primary"
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [
                        [116.400, 39.915],
                        [116.408, 39.915]
                    ]
                }
            }
        ]
    }

@app.get("/api/traffic-status")
async def get_traffic_status():
    """获取交通状态"""
    return {
        "status": "normal",
        "congestion_level": 0.3,
        "update_time": "2024-04-24T10:00:00Z"
    }

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug
    )