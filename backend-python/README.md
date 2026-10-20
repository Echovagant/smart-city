# 智慧城市后端服务

这是智慧城市可视化平台的后端服务，基于FastAPI构建，提供GeoJSON数据处理和API接口。

## 项目结构

```
backend-python/
├── main.py           # FastAPI应用主入口
├── data_processor.py # 数据处理工具模块
├── requirements.txt  # 项目依赖
├── .env              # 环境变量配置
├── data/             # 数据存储目录
└── geojson/          # GeoJSON文件目录
```

## 功能特性

- 提供建筑、道路和交通状态的API接口
- 支持GeoJSON数据的加载和处理
- 实现CORS跨域支持，与前端Vue应用集成
- 数据统计和分析功能

## 快速开始

### 1. 安装依赖

```bash
# 创建虚拟环境（可选）
python -m venv venv

# 激活虚拟环境
# Windows
venv\Scripts\activate
# Linux/Mac
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt
```

### 2. 配置环境变量

编辑`.env`文件，根据需要调整配置：

```
# 应用配置
APP_NAME=SmartCityBackend
DEBUG=True

# 服务器配置
HOST=0.0.0.0
PORT=8000

# CORS配置
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173

# 数据配置
DATA_DIR=./data
GEOJSON_DIR=./geojson
```

### 3. 启动服务

```bash
python main.py
```

服务将在 http://localhost:8000 启动（端口取自 `.env` 中的 `PORT`）。

## API文档

启动服务后，可以访问以下地址查看详细的API文档：

- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

## 主要API接口

### 基础接口

- `GET /` - 根路径，返回服务信息
- `GET /health` - 健康检查

### 数据接口

- `GET /api/buildings` - 获取建筑数据
- `GET /api/roads` - 获取道路数据
- `GET /api/traffic-status` - 获取交通状态

## 开发说明

### 添加新的API端点

在`main.py`中添加新的路由和处理函数：

```python
@app.get("/api/new-endpoint")
async def new_endpoint(param: str = None):
    # 实现业务逻辑
    return {"result": "success"}
```

### 使用数据处理器

```python
from data_processor import get_data_processor

# 创建数据处理器实例
processor = get_data_processor("path/to/data")

# 加载GeoJSON数据
data = processor.load_geojson("path/to/file.geojson")

# 处理数据
filtered_data = processor.filter_features_by_bbox(data, [min_lon, min_lat, max_lon, max_lat])

# 计算统计信息
stats = processor.calculate_building_statistics(data)
```

## 注意事项

1. 确保Python版本 >= 3.8
2. 生产环境中请设置`DEBUG=False`
3. 实际部署时建议使用更安全的CORS配置
4. 大数据量时考虑使用数据库存储替代文件存储