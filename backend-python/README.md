# 智慧城市后端服务

智慧城市可视化平台的后端服务，基于 FastAPI 构建，对外提供 OSM 建筑/道路 GeoJSON
数据接口。空间数据处理只用 Shapely 这一个第三方库。

当前仓库里那份 OSM 抽取实测 3854 个建筑要素、2260 个道路要素。

## 项目结构

```
backend-python/
├── main.py            # FastAPI 应用主入口（路由、bbox 校验、缓存）
├── data_processor.py  # GeoJSON 加载 / 空间过滤 / 建筑统计
├── scripts/
│   ├── fetch_osm_data.py  # 从 Overpass API 抓 OSM 数据转 GeoJSON
│   └── README.md          # 抓取脚本的用法与注意事项
├── tests/             # pytest 测试（5 个 `test_*.py` 用例文件 + `conftest.py`）
├── pyproject.toml     # pytest 配置
├── requirements.txt   # 运行时依赖
├── requirements-dev.txt # 测试依赖（pytest、httpx）
├── .env.example       # 环境变量模板
├── .env               # 本地配置（不入 git）
├── data/              # 运行时数据目录（不入 git）
└── geojson/           # OSM 抽取数据（不入 git，见「必需的数据文件」）
```

## 功能特性

- 提供建筑、道路、交通状态三个数据接口
- 支持按 `bbox` 空间过滤，参数非法一律返回 400 并附中文原因
- 原始 GeoJSON 与过滤结果两级缓存，过滤结果走容量上限 8 的 LRU
- CORS 跨域支持，白名单来自 `.env` 的 `ALLOWED_ORIGINS`（拒绝通配符 `*`）
- 数据缺失或损坏时统一返回 503，服务端绝对路径只写日志、不回显给调用方

## 快速开始

### 1. 安装依赖

虚拟环境目录是 **`backend-python/.venv/`**（不是 `venv/`）。

```bash
# 创建虚拟环境
python -m venv .venv

# 激活虚拟环境
# Windows
.venv\Scripts\activate
# Linux/Mac
source .venv/bin/activate

# 安装依赖（运行时 + 测试）
pip install -r requirements.txt -r requirements-dev.txt
```

### 2. 配置环境变量

`.env` **不入 git**，模板是同目录的 `.env.example`，复制一份再改：

```bash
cp .env.example .env
```

```
# 应用配置
APP_NAME=SmartCityBackend
DEBUG=True

# 服务器配置
HOST=127.0.0.1
PORT=8000

# CORS 配置（逗号分隔的白名单）
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

> **数据目录不在这里配**：`DATA_DIR` 与 `GEOJSON_DIR` 是 `main.py` 里的硬编码模块常量
> （`main.py:35-40`），指向 `backend-python/data` 与 `backend-python/geojson`，
> 在 `.env` 里写这两项**没有任何效果**。要迁移数据位置就改 `main.py` 里的常量。

### 3. 准备必需的数据文件

`backend-python/geojson/` 下的两个文件是**运行时必需输入，不在 git 里**
（`backend-python/.gitignore:28-31` 忽略了 `geojson/`）：

| 文件 | 内容 |
|---|---|
| `geojson/buildings.geojson` | 建筑面（`Polygon` / `MultiPolygon`） |
| `geojson/roads.geojson` | 道路（`LineString` / `Polygon`） |

全新 clone 之后用抓取脚本重新生成（只需要 Python 标准库）：

```bash
cd backend-python
./.venv/Scripts/python.exe scripts/fetch_osm_data.py
```

脚本默认抓取北京天安门周边 `39.905,116.380,39.925,116.420`
（south,west,north,east）的范围，多端点轮询 + 重试；**空结果会被当成失败**，
不会把空文件覆盖到现有数据上。完整参数表和注意事项见 `scripts/README.md`。

**文件缺失或损坏的后果**：`/api/buildings` 与 `/api/roads` 会返回 **503**
（统一文案「城市数据暂时不可用，请稍后重试」），而不是空集合 —— 详见
`main.py:296-299` 与 `main.py:311-313`。

> **署名**：OSM 数据遵循 ODbL，任何展示这份数据的界面或文档都必须署名
> "© OpenStreetMap contributors"（见 `scripts/README.md`）。

### 4. 启动服务

```bash
cd backend-python
./.venv/Scripts/python.exe main.py
```

服务默认在 **http://127.0.0.1:8000** 启动（端口取自 `.env` 的 `PORT`）。
`DEBUG=True` 时 uvicorn 自动 reload。

## API 文档

启动服务后可以访问：

- Swagger UI：http://127.0.0.1:8000/docs
- ReDoc：http://127.0.0.1:8000/redoc

## 主要 API 接口

### 基础接口

- `GET /` —— 根路径，返回服务信息
- `GET /health` —— 健康检查

### 数据接口

- `GET /api/buildings` —— 获取建筑数据
- `GET /api/roads` —— 获取道路数据
- `GET /api/traffic-status` —— 获取交通状态（**目前是固定值的占位响应**）

### `bbox` 查询参数

`/api/buildings` 与 `/api/roads` 接受可选的 `bbox` 参数，格式为
`min_lon,min_lat,max_lon,max_lat`（经度在前）：

```
GET /api/buildings?bbox=116.380,39.905,116.420,39.925
```

不带 `bbox` 时返回完整集合。带 `bbox` 时只返回几何与该范围相交的要素。

**参数非法一律返回 400**，并在 `detail` 里给出中文原因：

| 情况 | 例子 |
|---|---|
| 不是 4 个值 | `?bbox=1,2,3` |
| 有非数字 | `?bbox=1,2,x,4` |
| `nan` / `inf` | `?bbox=nan,39.9,116.4,39.93` |
| 经度越界 | `?bbox=-200,39.9,116.4,39.93` |
| 纬度越界 | `?bbox=116.38,-95,116.42,39.93` |
| min ≥ max（框倒置） | `?bbox=116.42,39.925,116.38,39.905` |

校验逻辑在 `main.py:237-265`，倒置的框会被显式拒绝（否则会静默返回全部要素）。

### 错误码约定

| 状态码 | 含义 |
|---|---|
| 400 | `bbox` 参数不合法 —— 调用方的问题 |
| 503 | 数据文件缺失或损坏 —— 服务端的问题，细节只写日志 |

## 运行测试

```bash
cd backend-python
./.venv/Scripts/python.exe -m pytest -q
```

测试配置在 `pyproject.toml`（`testpaths = ["tests"]`），用例在 `tests/` 下。
需要真实 OSM 数据的用例在没有数据文件时会自动跳过，不会伪装成通过。

## 开发说明

### 添加新的 API 端点

在 `main.py` 中添加新的路由和处理函数：

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

# 加载 GeoJSON 数据
data = processor.load_geojson("path/to/file.geojson")

# 按范围过滤
filtered_data = processor.filter_features_by_bbox(data, [min_lon, min_lat, max_lon, max_lat])

# 计算统计信息
stats = processor.calculate_building_statistics(data)
```

`DataProcessor` 的方法失败时抛 `DataProcessorError`（`data_processor.py:74`），
上层把它映射成 503，而不是让文件系统 / JSON / GEOS 的原始异常漏成 500。

## 注意事项

1. Python 版本 >= 3.8（开发环境是 3.12.4）
2. 生产环境中请设置 `DEBUG=False`
3. 实际部署时请收紧 CORS 白名单：`*` 会被拒绝，`allow_credentials=True` 与通配符不兼容
4. 数据目录是 `main.py` 里的硬编码常量，不走 `.env`
5. `requirements.txt` 里的 `geopandas` / `numpy` / `pandas` 目前没有任何代码 import，
   属于待清理的冗余依赖
