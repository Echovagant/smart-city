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
├── tests/             # pytest 测试（9 个 `test_*.py` 用例文件 + `conftest.py`）
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
- 可选的共享 API key（`API_KEY`）：设了之后两个数据接口校验 `X-API-Key` 头，没设则完全不校验
- 生产形态默认关闭 `/docs` `/redoc` `/openapi.json`（`EXPOSE_DOCS=False`），可用 `ALLOWED_HOSTS` 收窄 Host 头
- 数据缺失或损坏时统一返回 503，服务端绝对路径只写日志、不回显给调用方
- 响应开启 gzip 压缩（Starlette 自带的 `GZipMiddleware`，`minimum_size=1000`，零新增依赖）：`/api/buildings` 从 1341 KB 压到 219 KB，`/api/roads` 从 687 KB 压到 110 KB

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

# 可选的共享 API key（留空 = 不校验）
API_KEY=

# Host 头白名单（逗号分隔，留空 = 不限制）
ALLOWED_HOSTS=

# 是否暴露 /docs /redoc /openapi.json（生产保持 False）
EXPOSE_DOCS=False
```

> **数据目录不在这里配**：`DATA_DIR` 与 `GEOJSON_DIR` 是 `main.py` 里的硬编码模块常量
> （`main.py:45-50`），指向 `backend-python/data` 与 `backend-python/geojson`，
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
`main.py:374-377` 与 `main.py:389-391`。

> **署名**：OSM 数据遵循 ODbL，任何展示这份数据的界面或文档都必须署名
> "© OpenStreetMap contributors"（见 `scripts/README.md`）。

### 4. 启动服务

```bash
cd backend-python
./.venv/Scripts/python.exe main.py
```

服务默认在 **http://127.0.0.1:8000** 启动（端口取自 `.env` 的 `PORT`）。
`DEBUG=True` 时 uvicorn 自动 reload。

### 单进程部署（同时提供 API 与页面）

前端构建产物存在时，后端进程会自己把它托管起来：

```bash
cd Data-driven-modeling && npm run build      # 先构建前端，产物在 dist/
cd ../backend-python && ./.venv/Scripts/python.exe main.py
# 打开 http://127.0.0.1:8000/ 就是应用本身
```

- `GET /` 返回 `dist/index.html`（`text/html`）；`/api/...` 仍是接口，页面与接口同源。
- `dist/` 不存在时后端**不会崩**：只记一条 warning（`未找到前端构建产物…`），根路径退回返回服务信息 JSON。
- 静态挂载注册在**所有路由之后**（`mount_frontend` 的调用点在 `main.py` 文件末尾），所以 `/api/*` 优先级更高；`/api/unknown` 落到静态兜底返回 404。
- 实测（真实 `dist/` + 真实 uvicorn）：`/` → 200 `text/html`、`/api/buildings` → 200 `application/json`、`/api/unknown` → 404、`/assets/<某个 js>` → 200。
- 容器 / 反代形态见仓库根的 `Dockerfile` / `docker-compose.yml` / `deploy/nginx.conf`，**未在本机验证过**（没有 Docker / nginx）。

## API 文档

**默认不暴露**。`EXPOSE_DOCS` 缺省为 `False`，此时 `/docs`、`/redoc`、
`/openapi.json` 都不是已注册的路由，访问会落到静态兜底并返回 **404**
（实测 content-type 是 `application/json`，不是 HTML）。

需要在线文档时，在 `.env` 里设 `EXPOSE_DOCS=True` 再重启：

- Swagger UI：http://127.0.0.1:8000/docs
- ReDoc：http://127.0.0.1:8000/redoc
- OpenAPI JSON：http://127.0.0.1:8000/openapi.json

## 安全与生产配置

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `API_KEY` | 空 | 设了之后 `/api/buildings`、`/api/roads` 需要带 `X-API-Key` 头；留空则不启用 |
| `EXPOSE_DOCS` | `False` | 是否暴露 `/docs` `/redoc` `/openapi.json`；生产建议 `False` |
| `ALLOWED_HOSTS` | 空 | Host 头白名单，逗号分隔；留空不限制 |
| `DEBUG` | `False` | 调试模式。**生产必须是 `False`**（`True` 会让未处理异常返回完整堆栈） |
| `HOST` | `127.0.0.1` | 监听地址。**生产建议 `127.0.0.1`**，由反代对外暴露 |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | CORS 允许来源，逗号分隔 |

`API_KEY` 是**可选**的：没配就完全不校验，开发环境零摩擦。
注意前端**不携带**这个 key（避免把它打进浏览器包）——它适用于
「后端独立对外暴露」的部署形态；前后端同源时用 `HOST=127.0.0.1` + 反代即可。

`API_KEY=`（**空值**）等同于「没配」，不启用校验。
（`.env.example` 里就是 `API_KEY=`，照抄成 `.env` 不会把接口锁死。）

`ALLOWED_HOSTS` 生效时，Host 头不在白名单里的请求会被直接拒绝：
**400**，body 为纯文本 `Invalid host header`。

> 边界：`EXPOSE_DOCS=`（**空值**）会让服务**启动即失败**——pydantic 的布尔校验拒绝空串
> （`Input should be a valid boolean`）。照抄 `.env.example`（写的是 `EXPOSE_DOCS=False`）不会遇到。

## 主要 API 接口

### 基础接口

- `GET /` —— 根路径；有前端构建产物（`../Data-driven-modeling/dist/index.html`）时返回页面，否则返回服务信息
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

校验逻辑在 `main.py:250-275`（BBox 模型的越界与顺序约束）和 `main.py:303-331`（`_parse_bbox` 的个数 / 类型 / 有限性校验），倒置的框会被显式拒绝（否则会静默返回全部要素）。

### 错误码约定

| 状态码 | 含义 |
|---|---|
| 400 | `bbox` 参数不合法 —— 调用方的问题 |
| 400 | Host 头不在 `ALLOWED_HOSTS` 白名单里（仅在配置了白名单时） |
| 401 | 设了 `API_KEY` 但没带 `X-API-Key` 头，或头里的值不对（`detail` 固定为「需要 API key」） |
| 503 | 数据文件缺失或损坏 —— 服务端的问题，细节只写日志 |

### 响应压缩

客户端带 `Accept-Encoding: gzip` 时，响应会被 gzip 压缩（Starlette 自带的
`GZipMiddleware`，零新增依赖）。实测（真实 OSM 抽取数据，真实 uvicorn +
`urllib.request` 取原始字节）：

| 接口 | 未压缩 | gzip 后 | 节省 |
|---|---|---|---|
| `GET /api/buildings` | 1,373,431 B（1341 KB） | 224,125 B（219 KB） | 83.7% |
| `GET /api/roads` | 703,348 B（687 KB） | 112,917 B（110 KB） | 83.9% |

小于 1000 字节的响应（如 `/health`）不压缩 —— 压缩 20 字节只会变大。
压缩只发生在传输层，解压后的 JSON 与未压缩时逐字节相同。

数字来源命令：

```powershell
cd backend-python
.\.venv\Scripts\python.exe -c "<起临时 uvicorn，用 urllib.request 分别带 Accept-Encoding: gzip / identity 取 /api/buildings 与 /api/roads，比较两次 len(raw)>"
```

## 运行测试

```bash
cd backend-python
./.venv/Scripts/python.exe -m pytest -q
```

测试配置在 `pyproject.toml`（`testpaths = ["tests"]`），用例在 `tests/` 下。
需要真实 OSM 数据的用例在没有数据文件时会自动跳过，不会伪装成通过。
（`tests/test_gzip.py` 里 3 个数据接口用例同样带 `requires_osm_data` 标记；
`/health` 那条不依赖数据，任何环境都跑。）

CI 上由 `.github/workflows/verify.yml` 自动跑这一段（Windows 与 Ubuntu 两个 job）。
GitHub Actions 的 runner 上没有现成的虚拟环境，所以工作流会先 `python -m venv .venv`
再把依赖装进这个 venv —— `verify.ps1` 找的正是 `.venv\Scripts\python.exe`，
`verify.sh` 找的是 `.venv/bin/python`。CI 上 `backend-python/geojson/` 不在 git 里，
需要真实 OSM 数据的用例会自动跳过，其余全部照跑；CI 不下载 OSM 数据。

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

`DataProcessor` 的方法失败时抛 `DataProcessorError`（`data_processor.py:73`），
上层把它映射成 503，而不是让文件系统 / JSON / GEOS 的原始异常漏成 500。

## 注意事项

1. Python 版本 >= 3.9（开发环境是 3.12.4）—— Plan B3 起 `main.py` 用了 `tuple[...]` 形式的类型注解（PEP 585，3.9 才有）
2. 生产环境中请设置 `DEBUG=False`
3. 实际部署时请收紧 CORS 白名单：`*` 会被拒绝，`allow_credentials=True` 与通配符不兼容
4. 数据目录是 `main.py` 里的硬编码常量，不走 `.env`
5. `requirements.txt` 里的 `numpy<2` **不能删**：它是 `shapely==2.0.4` 的版本上限护栏。
   numpy 虽然没有被业务代码直接 import，但它是 shapely 的传递依赖；放开成 numpy 2.x
   会让 shapely 2.0.4 报 `TypeError: ufunc 'create_collection' not supported for the
   input types`，`tests/test_bbox_filter.py` 的 4 个用例会失败。
   （`geopandas` / `pandas` 已在 Plan A1 移除。）
