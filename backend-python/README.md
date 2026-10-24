# 智慧城市后端服务

智慧城市可视化平台的后端服务，基于 FastAPI 构建，对外提供 OSM 建筑/道路 GeoJSON
数据接口。空间数据处理只用 Shapely 这一个第三方库。

当前仓库里那份 OSM 抽取实测 3854 个建筑要素、2260 个道路要素。

## 项目结构

```
backend-python/
├── main.py            # FastAPI 应用主入口（路由、bbox 校验、缓存、安全响应头）
├── data_processor.py  # GeoJSON 加载 / 空间过滤 / 建筑统计
├── city_data/         # 城市运行指标数据层（公开数据源 + 聚合 + 降级）
│   ├── models.py      #   Pydantic 契约（每个指标都必须带 source）
│   ├── http.py        #   只用标准库的 JSON 取数封装
│   ├── cities.py     #   城市表静态快照（含取数点与时区，参数校验用）
│   ├── aqi.py        #   国标 GB/T 3095-2012 的 IAQI 分段与换算（纯函数）
│   ├── aggregator.py  #   并发取数 + 缓存 + 降级
│   ├── events.py      #   纯函数：从真实指标派生事件流
│   └── sources/       #   一个源一个模块（空气质量 / 天气 / 本地路网 / 设施 / 区域统计）
├── scripts/
│   ├── fetch_osm_data.py  # 从 Overpass API 抓 OSM 数据转 GeoJSON
│   └── README.md          # 抓取脚本的用法与注意事项
├── tests/             # pytest 测试（17 个 `test_*.py` 用例文件 + `conftest.py`）
├── pyproject.toml     # pytest 配置
├── requirements.txt   # 运行时依赖
├── requirements-dev.txt # 测试依赖（pytest、httpx、pytest-cov）
├── .env.example       # 环境变量模板
├── .env               # 本地配置（不入 git）
├── data/              # 运行时数据目录（不入 git）
└── geojson/           # OSM 抽取数据（不入 git，见「必需的数据文件」）
```

## 功能特性

- 提供建筑、道路、交通状态三个数据接口，外加**城市运行指标聚合**接口
- 支持按 `bbox` 空间过滤，参数非法一律返回 400 并附中文原因
- **三级缓存**：解析后的原始 GeoJSON → 按 bbox 的过滤结果（容量上限 8 的 LRU）→ **不带 bbox 的全量响应序列化结果**（明文字节 + 预压缩的 gzip 字节），全部模块级、全部由 `main._clear_caches()` 清空
- 全量 `/api/buildings` 的 **P95 从 342.9 ms 降到 17.1 ms**（gzip 客户端；identity 客户端 234.8 ms → 20.4 ms），线缆字节数前后完全一致
- CORS 跨域支持，白名单来自 `.env` 的 `ALLOWED_ORIGINS`（拒绝通配符 `*`）
- 可选的共享 API key（`API_KEY`）：设了之后两个数据接口校验 `X-API-Key` 头，没设则完全不校验
- 生产形态默认关闭 `/docs` `/redoc` `/openapi.json`（`EXPOSE_DOCS=False`），可用 `ALLOWED_HOSTS` 收窄 Host 头
- 数据缺失或损坏时统一返回 503，服务端绝对路径只写日志、不回显给调用方
- 响应开启 gzip 压缩（Starlette 自带的 `GZipMiddleware`，`minimum_size=1000`，零新增依赖）：`/api/buildings` 从 1341 KB 压到 219 KB，`/api/roads` 从 687 KB 压到 110 KB
- 每个响应都带三个安全响应头（`X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options`）；CSP **只做 report-only 观测，默认关闭**
- `/api/traffic-status` 返回**随时间变化的真实读数**（不再是写死的占位值），前端每 5 秒轮询一次
- `/api/city/overview` 接入**免凭据的公开数据源**（中国环境监测总站 / 中国天气网）与本地 OSM 数据，
  **每个指标都带来源标注与时间戳**，模型估算项标 `estimated: true`，
  取不到的源进 `degraded`（**端点永不 500**），零新增依赖；
  另有一段 `facilities`（设施分类计数，同样带来源标注），既有字段零改动。
  指标带之外还产出**两条序列**：24 小时逐小时 AQI 与 **14 天逐日 AQI**
  （逐日带各项污染物的日均值），单指标序列的点形状**一个字节都没变**
- `/api/city/area` 按**矩形范围**聚合空间统计（`bbox` 必填）：面积、建筑数、道路数、
  路网总长与分级长度、设施分类计数、建筑密度。口径全部复用现成实现，
  每个数字都配一段 `method` 说明算法、精度与各数据文件的观测时间；
  只读本地 OSM 快照，数据缺失返回 503（**绝不返回编出来的 0**）

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

**依赖版本**（`requirements.txt`）：

| 包 | 版本 | 备注 |
|---|---|---|
| fastapi | 0.153.0 | 不是 `fastapi[standard]`；`fastapi dev` 这条 CLI 命令**不可用**，项目用 `python main.py` 启动 |
| uvicorn | 0.30.1 | |
| pydantic | 2.14.1 | v2；`model_config = SettingsConfigDict(...)` 是唯一写法 |
| pydantic-settings | 2.1.0 | 从 `.env` 读配置 |
| python-dotenv | 1.0.1 | |
| shapely | 2.0.4 | 空间计算 |
| `numpy<2` | 实装 1.26.4 | **不是直接依赖**，是 shapely 的传递依赖；这行是承重钉子，见「注意事项」 |

开发期（`requirements-dev.txt`）：pytest 8.3.0、httpx 0.27.0、pytest-cov 7.1.0。

> **venv 体积**：按文件字节总量约 **106 MB**（3,863 个文件，其中 25.7 MB 是跑测试生成的 `__pycache__`）。重建前是 **284.91 MB** —— 省下的 179.49 MB 来自已从 requirements 移除的 geopandas / pandas / fiona / pyproj 链条与旧 venv 里残留的 `fastapi[standard]` extras。

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

# 可选的 CSP report-only 观测策略（留空 = 关闭，见「安全与生产配置」）
CSP_REPORT_ONLY=
```

> **数据目录不在这里配**：`DATA_DIR` 与 `GEOJSON_DIR` 是 `main.py` 里的硬编码模块常量
> （`main.py:95-97`），指向 `backend-python/data` 与 `backend-python/geojson`，
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

脚本默认抓取巴塞罗那 Eixample 街区与圣家堂一带
`41.385,2.145,41.405,2.185`（south,west,north,east）的范围，多端点轮询 + 重试；
**空结果会被当成失败**，不会把空文件覆盖到现有数据上。
完整参数表和注意事项见 `scripts/README.md`。

**文件缺失或损坏的后果**：`/api/buildings` 与 `/api/roads` 会返回 **503**
（统一文案「城市数据暂时不可用，请稍后重试」），而不是空集合 —— 详见
`main.py:551-554` 与 `main.py:566-568`。

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
| `CSP_REPORT_ONLY` | 空 | CSP 的 **report-only** 策略。留空 = 关闭（默认） |

`API_KEY` 是**可选**的：没配就完全不校验，开发环境零摩擦。
注意前端**不携带**这个 key（避免把它打进浏览器包）——它适用于
「后端独立对外暴露」的部署形态；前后端同源时用 `HOST=127.0.0.1` + 反代即可。

`API_KEY=`（**空值**）等同于「没配」，不启用校验。
（`.env.example` 里就是 `API_KEY=`，照抄成 `.env` 不会把接口锁死。）

`ALLOWED_HOSTS` 生效时，Host 头不在白名单里的请求会被直接拒绝：
**400**，body 为纯文本 `Invalid host header`。

> 边界：`EXPOSE_DOCS=`（**空值**）会让服务**启动即失败**——pydantic 的布尔校验拒绝空串
> （`Input should be a valid boolean`）。照抄 `.env.example`（写的是 `EXPOSE_DOCS=False`）不会遇到。

### 安全响应头（默认开启）

每个响应都自动带上三个头（`main.SECURITY_HEADERS`，`main.py:56-60`）：

| 响应头 | 值 | 作用 |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | 不要猜响应的 MIME 类型（本服务把 GeoJSON 以 `application/json` 返回） |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | 页面里的跨源请求会把 Referer 带给第三方，收紧它 |
| `X-Frame-Options` | `SAMEORIGIN` | 阻止被 iframe 嵌套（点击劫持） |

实现在 `main.SecurityHeadersMiddleware`（`main.py:184-210`）——**纯 ASGI 中间件**，
不是 `BaseHTTPMiddleware`（后者会把响应体包成流，改变字节层面的行为）。
中间件注册在 `GZipMiddleware` 之后（`main.py:253`），所以它看到的是已经压缩完的
最终响应。实测 6 个端点 × gzip/identity：加头**不改变**响应体、content-type、
content-length 与 gzip 行为（逐字节相同）。

### CSP：只做 report-only 观测，默认关闭

**代码里只有 `CSP_REPORT_ONLY` 这一个开关（缺省关闭）。任何时候都不会出现强制头
`Content-Security-Policy`。**

设了 `CSP_REPORT_ONLY=<策略>` 之后，每个响应会多带一个
`Content-Security-Policy-Report-Only` 头（`main.py:73`、`:171-181`）。
report-only **不拦截**任何东西，只让浏览器把违规报出来 —— 这是先看清 Cesium
实际需要什么、再决定要不要升级成强制策略的观测手段。

**底座是自绘的**：应用不请求任何瓦片服务，首屏外部请求是 **0 个**，
所以策略里不需要给任何第三方主机开口子。Cesium 自己需要的是：

```
default-src 'self';
script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:;
worker-src 'self' blob:;
img-src 'self' data: blob:;
connect-src 'self';
style-src 'self' 'unsafe-inline';
font-src 'self' data:
```

- `script-src` 的 `'unsafe-eval'` 是**实测结论**：Cesium 需要求值（`eval` / `new Function`）
  与编译 WebAssembly。**不要为了「策略好看」去掉它 —— 去掉就是白屏。**
- `style-src` 的 `'unsafe-inline'` 同理：Cesium 的 widget 会注入内联样式。
- `worker-src ... blob:` 建议保留：构建产物里确实存在 `new Blob` + `createObjectURL`
  的代码路径，观测没走到那条路径，但去掉 `blob:` 等于「赌它永远不被触发」。

**是否升级成强制头由维护者决定**；目前**没有**强制启用。

## 主要 API 接口

### 基础接口

- `GET /` —— 根路径；有前端构建产物（`../Data-driven-modeling/dist/index.html`）时返回页面，否则返回服务信息
- `GET /health` —— 健康检查

### 数据接口

- `GET /api/buildings` —— 获取建筑数据
- `GET /api/roads` —— 获取道路数据
- `GET /api/traffic-status` —— 获取交通状态（**值由时间确定性推导，随时间变化**，不再是写死的固定值）
- `GET /api/city/overview?city=barcelona` —— **城市运行指标聚合**（空气质量 / 天气 / 路网静态指标 / 设施分类），每个指标都带来源标注与时间戳
- `GET /api/city/area?bbox=min_lon,min_lat,max_lon,max_lat` —— **矩形范围的空间统计**（`bbox` 必填）

`/api/traffic-status` 不校验 API key（前端不携带 key，这个端点必须始终可访问）。
响应体 5 个键，120 字节左右：

| 键 | 类型 | 含义 |
|---|---|---|
| `status` | str | 粗粒度状态：`normal` / `slow` / `congested` |
| `congestion_level` | float | 拥堵指数，0..1，越大越堵 |
| `congestion` | str | 拥堵指数的中文标签：`畅通` / `轻微拥堵` / `拥堵` / `严重拥堵` |
| `flow` | float | 路网车流量指数，0..1，越大车越多（**是指数，不是车辆数**） |
| `update_time` | str | 本次读数的时刻，ISO8601 UTC、毫秒精度、`Z` 结尾 |

实测取值样例：

```json
{
  "status": "slow",
  "congestion_level": 0.5826,
  "congestion": "轻微拥堵",
  "flow": 0.7633,
  "update_time": "2026-10-21T05:06:32.080Z"
}
```

值由 `_traffic_status_payload(now)` 这个**纯函数**推导（`main.py:646-661`）：三个周期
互不成整数倍的正弦分量（86400 s / 900 s / 20 s）叠加，权重和为 1，结果天然落在 0..1，
**不使用随机量**。时间源是模块级的 `main._now()`（`main.py:600-607`），测试可以把它
换掉，因此「同一端点、两个不同时刻」可以被确定性地断言，不需要 `time.sleep`。

> 它是**按时间推出来的合成读数**，不是真实采集的车流数据。要真正的实时流需要
> WebSocket + 数据源，那是另一笔预算。

### `GET /api/city/overview` —— 城市运行指标

把**真实公开数据**聚合成一份带来源标注与时间戳的统一契约。实现在 `city_data/` 包里
（`models.py` 契约 / `http.py` 取数 / `cities.py` 城市表 / `aqi.py` AQI 换算 /
`sources/*` 一个源一个模块 / `aggregator.py` 并发 + 缓存 + 降级）。

- `city` 默认 `barcelona`（巴塞罗那），**只接受本地城市表 `city_data/cities.py` 里的 id**，
  否则 400（城市表是静态快照，校验**不依赖网络** —— 上游挂了也不会把端点变成 400）。
- **端点永不 500**：任何一个上游失败或超时都只是把它放进 `degraded`，
  其余指标照常返回；聚合器整体出意外也返回一份「全部降级」的 200。
- 响应带 `Cache-Control: public, max-age=30` 与 `X-Data-Generated-At`。
- 不校验 API key（前端不携带 key，这个端点必须始终可访问）。

响应结构：

| 键 | 类型 | 含义 |
|---|---|---|
| `city` | object | `{id, name, latitude, longitude, timezone}` |
| `generated_at` | str | 本次响应生成的时间，ISO8601 UTC |
| `metrics` | array | 指标列表，**每个都带 `source`** |
| `series` | array | 时间序列（24 小时 AQI + 逐日 AQI） |
| `facilities` | array | **设施分类计数**（本地 OSM 快照；取不到时是**空数组**，不编数字） |
| `degraded` | array | **取不到的源的名字**（前端据此显示「数据源暂不可用」） |

每个指标：

| 键 | 类型 | 含义 |
|---|---|---|
| `key` | str | 指标标识（`aqi` / `weather_temp` / `road_load_index` …） |
| `label` | str | 中文标签 |
| `value` | number \| str \| null | 指标值；**取不到时是 `null`**（不许拿 0 冒充） |
| `unit` | str | 单位 |
| `level` / `level_label` | number \| null / str \| null | 分级与分级标签（如 AQI 的 2 / 良） |
| `extra` | object | 该指标特有的补充字段（质量等级、算法口径 …） |
| `source` | object | **来源标注**（见下） |

`source`：

| 键 | 类型 | 含义 |
|---|---|---|
| `name` | str | 来源名（「Open-Meteo 天气预报」…） |
| `url` | str | 真实取数地址（本地文件用仓库相对路径） |
| `observed_at` | str \| null | 上游**数据自身**的时间戳；取不到时是 `null` |
| `fetched_at` | str | 我们**取到**它的时间；缓存命中时仍是**首次**取数的时间 |
| `realtime` | bool | 这份数据此刻还成立吗 |
| `estimated` | bool | **模型估算**吗（模型估算必须是 `true`） |

#### 数据源

| 源 | 地址 | 凭据 | 实时性 | 降级 |
|---|---|---|---|---|
| 气温 / 湿度 / 体感温度 / 风速 / 降水 | `https://api.open-meteo.com/v1/forecast?…&current=…&timezone=<tz>&timeformat=unixtime` | 免凭据 | 小时级（**数值模式**，不是站点实测） | 取不到 → 进 `degraded`，指标值 `null` |
| AQI / 六项污染物浓度 + 24 小时序列 + 逐日序列 | `https://air-quality-api.open-meteo.com/v1/air-quality?…&hourly=…&timezone=<tz>&timeformat=unixtime` | 免凭据 | 小时级（**CAMS 模型再分析**，11 km 网格） | 同上 |
| 建筑 / 道路数量、路网总长、覆盖面积、各等级道路条数 | 本地 `geojson/*.geojson` | 无 | 静态快照 | 文件读不到 → 进 `degraded` |
| 路网负载指数 | 上面那份本地数据**自己算** | 无 | —— | **模型估算**（`estimated: true`） |
| 设施分类（医疗 / 公共安全 / 教育 / 历史建筑 / 商业办公） | 本地 `geojson/buildings.geojson` **按 OSM 标签统计** | 无 | 静态快照 | 文件读不到 → 进 `degraded`，`facilities` 是**空数组** |

**两个远程源都是模式数据**（数值天气预报 / CAMS 再分析），所以它们的
`estimated` 是 `true` —— 界面会显示「（模型估算）」。本地 OSM 快照是实测，
`estimated` 是 `false`。

#### AQI 的口径（**自己算的，不是谁发布的**）

open-meteo 只给**污染物浓度**（μg/m³），不给中国国标口径的 AQI。
本项目按 **GB/T 3095-2012** 的 IAQI 分段表自己换算（`city_data/aqi.py`）：

- 分段点：`0 / 50 / 100 / 150 / 200 / 300 / 400 / 500`，
  各污染物的浓度区间与线性内插公式见 `city_data/aqi.py` 的模块 docstring。
- 统计口径：PM2.5 / PM10 / NO2 / SO2 / CO 取 **24 小时滑动平均**，O3 取 **8 小时滑动平均**。
- `AQI = max(各污染物的 IAQI)`；全部取不到时是 `null`（**不许填 0** —— 0 在国标里是「优」）。
- CO 的国标单位是 mg/m³，上游给的是 μg/m³，换算在模块内部做。

**这是「按国标分段表换算出来的 AQI」，不是任何机构发布的 AQI。**
界面与文档都按这个口径表述，不含糊。

设施分类的规则**只写在 `city_data/sources/facilities.py`**（前端只渲染）：
医疗 `building=hospital`；公共安全 `amenity=police` / `amenity=fire_station` /
`building=guardhouse` / `amenity=shelter`；教育 `building=school` /
`building=university` / `building=kindergarten` / `amenity=college`；
历史建筑 `historic=city_gate|palace|temple|building|yes|monastery`；
商业与办公 `building=commercial|retail|office|hotel` / `shop=mall` / `office=government`。

**一个建筑只归一类**（按上面顺序取第一个命中）—— 环形图要能对上账，所以不许重复计数。
`estimated = false`（实测计数，不是模型估算）。

实测（2026-10-24，本机，巴塞罗那取景范围 4366 栋建筑，**去重后**）：
医疗 **2**、公共安全 **2**、教育 **24**、历史建筑 **86**、商业与办公 **339**，
合计 **453** 处。比例悬殊是**数据事实**：Eixample 一带 72% 的建筑是
`building=apartments`（住宅），不命中任何设施分类；而 `building=hospital`
在这个范围里**一栋都没有**（医疗的 2 处是 `amenity=clinic` / `healthcare=clinic`）。

#### 许可与署名

| 数据 | 许可 | 本项目需要做什么 |
|---|---|---|
| Open-Meteo 天气 / 空气质量 | **CC BY 4.0** | **必须署名**：Open-Meteo + CAMS ENSEMBLE 数据提供方 |
| Open-Meteo 免费档 | —— | **仅限非商业用途**；商业用途需要付费档与 API key |
| OpenStreetMap | **ODbL** | 展示数据时必须标注「© OpenStreetMap contributors」 |

界面里已经有 OSM 署名行（删掉它等于违反许可证）。open-meteo 的署名写在
README 的「数据来源」小节与 `source.name` 里（源名自带「（CAMS 模型再分析）」）。

#### 缓存与超时

- 四个源**并发**取数（`asyncio.gather` + `asyncio.wait_for`），
  **每个源独立 5 秒预算**：慢源只拖慢自己。
- 缓存：空气质量 30 分钟、天气 10 分钟、静态路网指标进程内常驻。
- **缓存命中时 `fetched_at` 仍是首次取数的时间** —— 那才是真实的数据年龄。
- 取数失败**不写缓存**（否则坏数据会被缓存住 30 分钟）。

#### 逐日序列

`aqi_daily` 序列由**同一个**空气质量源产出：**最近 7 个完整的本地日**
（本地日按响应里的 `utc_offset_seconds` 切分，open-meteo 的日边界也是这么算的）。
序列点的结构是 `{t, v, values}`：`v` 是当天的 AQI，`values` 是六项污染物的日均值。

**向后兼容**：单指标序列（`aqi_24h`）的点仍然是 `{"t": …, "v": …}` ——
空的 `values` 键被 `SeriesPoint` 上的 `@model_serializer(mode="wrap")` **整个省掉**，
所以既有序列的点形状**一个字节都没变**。

### `GET /api/city/area` —— 矩形范围的空间统计

回答一个问题：**「这一片范围里有多少栋楼？路网有多长？有哪些设施？」**

```
GET /api/city/area?bbox=116.390,39.905,116.405,39.915
```

- `bbox` **必填**，格式 `min_lon,min_lat,max_lon,max_lat`（经度在前）。
  非法输入一律 **400**，原因文案与 `/api/buildings` 的同类错误**逐字相同**
  （复用同一个 `_parse_bbox`）。
- 只读**本地 OSM 快照**：不走 `/api/city/overview` 那套「多源并发 + 降级」的聚合器。
  数据文件读不到时返回 **503**，**绝不返回编出来的 0**。
- 范围里一个要素都没有是**正常结果**：200 + 数字 0（空范围，不是故障）。
- 不校验 API key（前端不携带 key，这个端点必须始终可访问）。
- 响应带 `Cache-Control: public, max-age=30` 与 `X-Data-Generated-At`。

契约 `AreaStats`（`city_data/models.py`）：

| 键 | 类型 | 含义 |
|---|---|---|
| `bbox` | array | 回显规范化后的四个数 |
| `area_km2` | float | 该范围的近似面积（km²） |
| `building_count` | int | 范围内的建筑要素数 |
| `road_count` | int | 道路要素数（**含**广场、人造地面这类面要素） |
| `road_length_km` | float | 路网总长（km）—— **只有线要素计入长度** |
| `road_length_by_tier_km` | object | 按等级分解：`main` / `secondary` / `local` / `footway` / `other` |
| `facility_counts` | object | 设施分类计数（医疗 / 公共安全 / 教育 / 历史建筑 / 商业与办公） |
| `facility_categories` | array | 同一份计数的带标签版本（分类名 + 判定依据 + 来源） |
| `building_density_per_km2` | float | 建筑密度（栋 / km²） |
| `source` | object | **来源标注**：本地快照、`estimated: false`、各文件的观测时间 |
| `method` | object | **算法口径**：每条数怎么算出来的（见下） |

**算法全部复用现成实现**，一个项目里不出现两套口径：
面积 → `road_network.area_km2`；路网长度 → `road_network.polyline_length_m`；
分级 → `road_network.tier_of` + `ROAD_TIERS`；设施分类 → `facilities.count_by_category`
（分类规则仍然只有 `facilities.py` 一处）。实现在 `city_data/sources/area.py`，
**纯函数、不联网**。

实测（`bbox=116.390,39.905,116.405,39.915`）：

| 项 | 值 |
|---|---|
| 面积 | 1.4226 km² |
| 建筑 | 1039 栋 |
| 道路 | 661 条（含面要素） |
| 路网总长 | 54.4386 km |
| 分级长度 | 主干道 3.0294 / 次干道 6.5506 / 支路 17.3231 / 人行道 27.3563 / 其他 0.1792（km） |
| 设施 | 医疗 0 / 公共安全 6 / 教育 2 / 历史建筑 9 / 商业与办公 4 |
| 建筑密度 | 730.353 栋 / km² |

**`method` 字段是「每个数字都能追到来源」那条铁律的落地**：路网长度与面积的算法说明
（等距圆柱近似）、保留精度、范围内线要素与面要素各多少、以及**建筑与道路两份文件
各自的观测时间**都写在里面。总额由各分解项四舍五入后相加得到，所以前端画分解图时
各段之和与总额必然对得上账。

缓存：范围过滤复用按 `bbox` 的过滤结果 LRU（上限 8），聚合结果**另加一层 LRU-8**。
本机实测（**共享开发机**）：进程刚起的第一次请求 **349 ms**（含 GeoJSON 解析），
缓存命中**中位 2.8 ms**、**最小 1.9 ms**、P95 16 ms —— 共享机器上 `min` 更能说明
「应用本身有多快」，P95 里那几毫秒是机器上别的进程抢 CPU。

> **这个端点的前端入口**：大屏右列第一块「区域统计」——在场景里单击地面，
> 以命中点为中心取一个固定半径的矩形范围来查（半径 200 / 300 / 500 m 可切）。
> 面板上的数字与本端点的返回逐字一致。
> 另外 `facility_categories[].members` **恒为空数组**（只给计数，不给成员 id）。

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

校验逻辑在 `main.py:426-451`（BBox 模型的越界与顺序约束）和 `main.py:479-507`（`_parse_bbox` 的个数 / 类型 / 有限性校验），倒置的框会被显式拒绝（否则会静默返回全部要素）。

### 错误码约定

| 状态码 | 含义 |
|---|---|
| 400 | `bbox` 参数不合法 —— 调用方的问题 |
| 400 | Host 头不在 `ALLOWED_HOSTS` 白名单里（仅在配置了白名单时） |
| 401 | 设了 `API_KEY` 但没带 `X-API-Key` 头，或头里的值不对（`detail` 固定为「需要 API key」） |
| 503 | 数据文件缺失或损坏 —— 服务端的问题，细节只写日志 |

### 响应压缩与全量响应缓存

客户端带 `Accept-Encoding: gzip` 时，响应会被 gzip 压缩（Starlette 自带的
`GZipMiddleware`，零新增依赖）。实测（真实 OSM 抽取数据，真实 uvicorn +
`urllib.request` 取原始字节）：

| 接口 | 未压缩 | gzip 后 | 节省 |
|---|---|---|---|
| `GET /api/buildings` | 1,373,431 B（1341 KB） | 224,125 B（219 KB） | 83.7% |
| `GET /api/roads` | 703,348 B（687 KB） | 112,917 B（110 KB） | 83.9% |

小于 1000 字节的响应（如 `/health`）不压缩 —— 压缩 20 字节只会变大。
压缩只发生在传输层，解压后的 JSON 与未压缩时逐字节相同。

**不带 `bbox` 的全量响应走自己的缓存路径**（`main._full_response()`，`main.py:402-423`）：
序列化后的字节与预压缩好的 gzip 字节一起缓存起来，命中时直接返回。实测
（真实 uvicorn + 真实 OSM 数据，每次新建连接，预热 2 次后采样 30 次，最近秩法取分位数）：

| 客户端 | before（缓存引入前）P95 | after（当前代码）P95 | 线缆字节（前后一致） |
|---|---|---|---|
| `Accept-Encoding: gzip` | 342.9 ms | **17.1 ms** | 224,125 B |
| `Accept-Encoding: identity` | 234.8 ms | **20.4 ms** | 1,373,431 B |

- 线缆字节数前后完全一致 → 压缩结果与中间件自己压的**逐字节相同**，没有「压两遍」或「没压」。
- `GZipMiddleware` 见到已带 `Content-Encoding: gzip` 的响应会**原样透传**，所以这里必须按请求头自己判分支：**不支持 gzip 的客户端要拿到明文**（`tests/test_gzip.py` 有这条契约）。
- **带 `bbox` 的路径一律不缓存** —— 参数组合无界，缓存多少都救不了。

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

**当前 282 passed**（17 个 `test_*.py` 用例文件 + `conftest.py`）。

测试配置在 `pyproject.toml`（`testpaths = ["tests"]`），用例在 `tests/` 下。
需要真实 OSM 数据的用例在没有数据文件时会自动跳过，不会伪装成通过。
（`tests/test_gzip.py` 里 3 个数据接口用例同样带 `requires_osm_data` 标记；
`/health` 那条不依赖数据，任何环境都跑。）

**单元测试一律不打真实网络**：`city_data/` 的上游响应全部是写死的假数据
（`city_data.http.request_json` 被替换掉）—— CI 上没有外网也能跑，
而且真实网络会让测试变慢又 flaky。要手测真实上游，起服务后 curl
`/api/city/overview`。

CI 上由 `.github/workflows/verify.yml` 自动跑这一段（Windows 与 Ubuntu 两个 job）。
GitHub Actions 的 runner 上没有现成的虚拟环境，所以工作流会先 `python -m venv .venv`
再把依赖装进这个 venv —— `verify.ps1` 找的正是 `.venv\Scripts\python.exe`，
`verify.sh` 找的是 `.venv/bin/python`。CI 上 `backend-python/geojson/` 不在 git 里，
需要真实 OSM 数据的用例会自动跳过，其余全部照跑；CI 不下载 OSM 数据。

## 验收指标怎么自己跑

仓库根有两个**只用标准库**的度量脚本（任何 Python 3.8+ 都能跑，CI 里不必先进 venv）：

| 脚本 | 作用 |
|---|---|
| `scripts/measure-acceptance.py` | 汇总表：延迟、覆盖率、产物体积、（有浏览器产物时）首屏与帧率 |
| `scripts/measure-browser-performance.mjs` | 浏览器端度量：生产构建 + 真实 headless Chrome 的首屏 / 帧率 |

完整流程（**产物全部落在仓库根的 `.acceptance/`，已 gitignore**）：

```powershell
# 1) 后端覆盖率
cd backend-python
$env:COVERAGE_FILE = "$PWD\..\.acceptance\.coverage-backend"
.\.venv\Scripts\python.exe -m pytest -q --cov=main --cov=data_processor `
  --cov-report=term-missing `
  --cov-report=json:"$PWD\..\.acceptance\backend-coverage.json" `
  --cov-report=html:"$PWD\..\.acceptance\backend-htmlcov"

# 2) 前端覆盖率
cd ../Data-driven-modeling
$env:COVERAGE_DIR = "$PWD\..\.acceptance\frontend-coverage"
npm run test:coverage

# 3) 汇总表（覆盖率不现算，读上面两份 JSON）
cd ..
.\backend-python\.venv\Scripts\python.exe scripts\measure-acceptance.py

# 4) 浏览器端指标（生产构建 + 真实 Chrome，默认 3 轮）
node scripts\measure-browser-performance.mjs
```

要点：

- `--cov=main --cov=data_processor` **只算产品代码**。加 `--cov=.` 会把 `tests/` 也
  算进分母（数字好看但没有意义 —— 测试文件自己覆盖了 100%）。
- `measure-acceptance.py` **不现算覆盖率**（跑一遍要几十秒），它读第 1、2 步产出的
  JSON。产物缺失时对应指标显示「未提供」，**不猜数字**，其余指标照常测。
- 产物目录可用 `--artifacts` / `--backend-coverage` / `--frontend-coverage` 覆盖，
  也可以整个放到仓库外。
- 退出码**恒为 0** —— 这一步是「报告」不是「门禁」，未达标的项在输出里逐条列出。
  CI 里对应的那一步带 `continue-on-error: true`。
- 延迟是**起一个真实 uvicorn 进程**用 `urllib` 发真实请求测的（不是 `TestClient`），
  第一个请求单独标成「冷启动」不计入 P95，并额外给一列 `min` —— 共享开发机上跑时，
  `min` 比 `P95` 更能说明「应用本身有多快」。

**实测基线**（覆盖率 2026-10-23 复测，延迟 2026-10-22 测；16 核 i7-13620H；
延迟用真实 uvicorn 进程 + `urllib` 打 30 次取 P95，
覆盖率是 `--cov=main --cov=data_processor --cov=city_data` 的结果）：

| 指标 | 验收线 | 实测 | 判定 |
|---|---|---|---|
| 后端覆盖率（`main.py` + `data_processor.py` + `city_data/`） | > 90% | **95%**（1372 条语句 / 73 条未覆盖；`main.py` 97%、`data_processor.py` 89%） | 达标 |
| 前端覆盖率（`src/**` 全口径） | > 80% | **98.03%** 语句、96.44% 函数、**89.6%** 分支 | 达标 |
| `/api/buildings`（全量）P95 | < 200 ms | **25.4 ms**（gzip 24.6 ms；中位数 4.3 ms） | 达标 |
| `/api/roads`（全量）P95 | < 200 ms | **27.8 ms**（gzip 21.2 ms；中位数 3.4 ms） | 达标 |
| 带 bbox 的路径 P95 | < 200 ms | **132.1 ms**（gzip 162.7 ms） | 达标 |
| `/api/city/overview`（缓存命中）P95 | 参考 | **17.5 ms** | 参考 |
| `/api/city/overview`（冷启动，含外部源往返） | 参考 | **约 1150 ms** | 参考 |
| `/api/city/area`（缓存命中） | 参考 | 中位 **2.8 ms**（min 1.9 ms、P95 16 ms；进程冷启动首请求 349 ms） | 参考 |
| Vite 产物体积（不含 Cesium 运行时） | < 5 MB | **3.97 MB**（5 个文件） | 达标 |
| `dist/` 总体积 | < 5 MB（含 3.75 MB 自托管 Cesium 运行时） | **7.72 MB**（104 个文件） | **口径差异**（不判达标/不达标） |
| 首屏外部请求 | 0 | **0 个** | 达标 |

> 延迟这条验收线**只有在口径固定时才可比** —— 压缩与否、走什么网络、并发度、
> 宿主机负载都会改数。共享开发机上跑时，`min` 比 `P95` 更能说明「应用本身有多快」。

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

## 已知限制

- 区域统计的 `facility_categories[].members` **恒为空数组**（只给分类计数，不给成员 id）——
  「点某个分类、高亮该范围内的建筑」还做不到，目前只回答「范围内有多少」
- **两个远程源都是模式数据**：天气是数值天气预报，空气质量是 CAMS 模型再分析
  （11 km 网格）。所以它们的 `source.estimated` 是 `true`，界面上会标「（模型估算）」。
  AQI 也是**按国标分段表自己换算**的，不是任何机构发布的 AQI
- 空气质量 API **只有 `hourly` 与 `current`，没有 `daily`**：逐日序列由逐小时数据
  自己按本地日聚合（本地日用响应里的 `utc_offset_seconds` 切分）
- 城市表是**静态快照**（手工维护），表里没有的城市 id 会被判为未知（保守的假阴性）
- Open-Meteo 的免费档**仅限非商业用途**；商业用途需要付费档与 API key
- `Dockerfile` / `docker-compose.yml` / `deploy/nginx.conf` **未经过 `docker build` /
  `nginx -t` 验证**（本机没有 Docker 与 nginx）

## 注意事项

1. Python 版本 >= 3.9（开发环境是 3.12.4）—— `main.py` 用了 `tuple[...]` 形式的类型注解（PEP 585，3.9 才有）
2. 生产环境中请设置 `DEBUG=False`
3. 实际部署时请收紧 CORS 白名单：`*` 会被拒绝，`allow_credentials=True` 与通配符不兼容
4. 数据目录是 `main.py` 里的硬编码常量，不走 `.env`
5. `requirements.txt` 里的 `numpy<2` **不能删**：它是 `shapely==2.0.4` 的版本上限护栏。
   numpy 虽然没有被业务代码直接 import，但它是 shapely 的传递依赖；放开成 numpy 2.x
   会让 shapely 2.0.4 报 `TypeError: ufunc 'create_collection' not supported for the
   input types`，`tests/test_bbox_filter.py` 的 4 个用例会失败。
   （`geopandas` / `pandas` 早就不在依赖里了。）
6. `fastapi dev` 这条 CLI **不可用**：requirements 写的是 `fastapi==0.153.0` 而不是
   `fastapi[standard]`，`fastapi-cli` / `typer` / `rich` 都没装。项目用
   `.\.venv\Scripts\python.exe main.py` 启动，不受影响。
