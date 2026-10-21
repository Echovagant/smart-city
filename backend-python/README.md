# 智慧城市后端服务

智慧城市可视化平台的后端服务，基于 FastAPI 构建，对外提供 OSM 建筑/道路 GeoJSON
数据接口。空间数据处理只用 Shapely 这一个第三方库。

当前仓库里那份 OSM 抽取实测 3854 个建筑要素、2260 个道路要素。

## 项目结构

```
backend-python/
├── main.py            # FastAPI 应用主入口（路由、bbox 校验、缓存、安全响应头）
├── data_processor.py  # GeoJSON 加载 / 空间过滤 / 建筑统计
├── scripts/
│   ├── fetch_osm_data.py  # 从 Overpass API 抓 OSM 数据转 GeoJSON
│   └── README.md          # 抓取脚本的用法与注意事项
├── tests/             # pytest 测试（12 个 `test_*.py` 用例文件 + `conftest.py`）
├── pyproject.toml     # pytest 配置
├── requirements.txt   # 运行时依赖
├── requirements-dev.txt # 测试依赖（pytest、httpx、pytest-cov）
├── .env.example       # 环境变量模板
├── .env               # 本地配置（不入 git）
├── data/              # 运行时数据目录（不入 git）
└── geojson/           # OSM 抽取数据（不入 git，见「必需的数据文件」）
```

## 功能特性

- 提供建筑、道路、交通状态三个数据接口
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
> （`main.py:87-89`），指向 `backend-python/data` 与 `backend-python/geojson`，
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
`main.py:543-546` 与 `main.py:558-560`。

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

每个响应都自动带上三个头（`main.SECURITY_HEADERS`，`main.py:48-52`）：

| 响应头 | 值 | 作用 |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | 不要猜响应的 MIME 类型（本服务把 GeoJSON 以 `application/json` 返回） |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | 页面里的高德瓦片请求会把 Referer 带给第三方，收紧它 |
| `X-Frame-Options` | `SAMEORIGIN` | 阻止被 iframe 嵌套（点击劫持） |

实现在 `main.SecurityHeadersMiddleware`（`main.py:176-202`）——**纯 ASGI 中间件**，
不是 `BaseHTTPMiddleware`（后者会把响应体包成流，改变字节层面的行为）。
中间件注册在 `GZipMiddleware` 之后（`main.py:245`），所以它看到的是已经压缩完的
最终响应。实测 6 个端点 × gzip/identity：加头**不改变**响应体、content-type、
content-length 与 gzip 行为（逐字节相同）。

### CSP：只做 report-only 观测，默认关闭

**代码里只有 `CSP_REPORT_ONLY` 这一个开关（缺省关闭）。任何时候都不会出现强制头
`Content-Security-Policy`。**

设了 `CSP_REPORT_ONLY=<策略>` 之后，每个响应会多带一个
`Content-Security-Policy-Report-Only` 头（`main.py:65`、`:163-173`）。
report-only **不拦截**任何东西，只让浏览器把违规报出来 —— 这是先看清 Cesium
实际需要什么、再决定要不要升级成强制策略的观测手段。

实测（真实 Chrome，2026-10-21）：

- 严格探针 `default-src 'self'`（`default-src` 会作为所有未显式设置的指令的回退）
  触发 **101 条违规 / 4 类**：
  - `connect-src`（经 `default-src` 回退）发起高德瓦片连接 **77** 条
  - `script-src`（经 `default-src` 回退）`eval` / `new Function` **16** 条
  - `script-src`（经 `default-src` 回退）WebAssembly 编译/实例化 **4** 条
  - `style-src`（经 `default-src` 回退）内联样式 **4** 条
- 按上述结果收紧后的候选策略实测 **0 条违规**（netlog 证明 80 次瓦片请求确实发出去了，
  不是「没跑到那段代码」而是真的干净）：

  ```
  default-src 'self';
  script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:;
  worker-src 'self' blob:;
  img-src 'self' data: blob: https://*.is.autonavi.com;
  connect-src 'self' https://*.is.autonavi.com;
  style-src 'self' 'unsafe-inline';
  font-src 'self' data:
  ```

  - 瓦片主机是 `webrd0{1,2,3,4}.is.autonavi.com`（`Data-driven-modeling/src/components/SmartCity.vue:329-330`），
    **不是** `*.amap.com`。
  - `script-src` 的 `'unsafe-eval'`、`style-src` 的 `'unsafe-inline'` 是**实测结论**：
    Cesium 需要求值（`eval` / `new Function`）与编译 WebAssembly，Cesium 的 widget
    也要注入内联样式。**不要为了「策略好看」去掉这两条 —— 去掉就是白屏。**
  - `worker-src ... blob:` 建议保留：构建产物里确实存在 `new Blob` + `createObjectURL`
    的代码路径，本轮观测没走到那条路径，但去掉 `blob:` 等于「赌它永远不被触发」。

**是否升级成强制头由维护者决定**；本轮**没有**强制启用。

## 主要 API 接口

### 基础接口

- `GET /` —— 根路径；有前端构建产物（`../Data-driven-modeling/dist/index.html`）时返回页面，否则返回服务信息
- `GET /health` —— 健康检查

### 数据接口

- `GET /api/buildings` —— 获取建筑数据
- `GET /api/roads` —— 获取道路数据
- `GET /api/traffic-status` —— 获取交通状态（**值由时间确定性推导，随时间变化**，不再是写死的固定值）

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

值由 `_traffic_status_payload(now)` 这个**纯函数**推导（`main.py:638-653`）：三个周期
互不成整数倍的正弦分量（86400 s / 900 s / 20 s）叠加，权重和为 1，结果天然落在 0..1，
**不使用随机量**。时间源是模块级的 `main._now()`（`main.py:592-599`），测试可以把它
换掉，因此「同一端点、两个不同时刻」可以被确定性地断言，不需要 `time.sleep`。

> 它是**按时间推出来的合成读数**，不是真实采集的车流数据。要真正的实时流需要
> WebSocket + 数据源，那是另一笔预算。

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

校验逻辑在 `main.py:418-443`（BBox 模型的越界与顺序约束）和 `main.py:471-499`（`_parse_bbox` 的个数 / 类型 / 有限性校验），倒置的框会被显式拒绝（否则会静默返回全部要素）。

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

**不带 `bbox` 的全量响应走自己的缓存路径**（`main._full_response()`，`main.py:394-415`）：
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

**当前 130 passed**（12 个 `test_*.py` 用例文件 + `conftest.py`）。

测试配置在 `pyproject.toml`（`testpaths = ["tests"]`），用例在 `tests/` 下。
需要真实 OSM 数据的用例在没有数据文件时会自动跳过，不会伪装成通过。
（`tests/test_gzip.py` 里 3 个数据接口用例同样带 `requires_osm_data` 标记；
`/health` 那条不依赖数据，任何环境都跑。）

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

**本轮实测基线**（2026-10-21，16 核 i7-13620H，测量期整机 CPU 非空闲 69%–73%）：

| 指标 | 验收线 | 实测 | 判定 |
|---|---|---|---|
| 后端覆盖率（`main.py` + `data_processor.py`） | > 90% | **93.76%**（449 条语句 / 28 条未覆盖；`main.py` 95.99%、`data_processor.py` 89.33%） | 达标 |
| 前端覆盖率（`src/**` 全口径） | > 80% | **94.19%** 语句（含 Plan S0 新增的 `src/theme/dark.ts`）、93.84% 函数（50/65）、80.21% 分支（168/216） | 达标 |
| `/api/buildings`（全量）P95 | < 200 ms | **27.0 ms**（gzip 29.1 ms） | 达标 |
| `/api/roads`（全量）P95 | < 200 ms | **15.8 ms** | 达标 |
| 带 bbox 的路径 P95 | < 200 ms | **89.2 ms** | 达标 |
| Vite 产物体积（不含 Cesium 运行时） | < 5 MB | **3.92 MB**（5 个文件） | 达标 |
| `dist/` 总体积 | 计划书写的是 < 5 MB，但含 6.6 MB 自托管 Cesium 运行时 | 10.49 MB（385 个文件） | **口径差异**（不判达标/不达标） |
| 首屏 LCP | < 3 s | **0.78 s** | 达标 |
| 页面 load 事件 | < 3 s | **0.91 s** | 达标 |
| 帧率（静止 / 相机运动） | ≥ 30 fps | **89.0 / 163.1 fps** | 达标 |

> 上一轮唯一的未达标项是 `/api/buildings` 全量 P95（337.3 ms），**已被全量响应缓存修掉**
> （同一条度量现在 27.0 ms）。但这条验收线**只有在口径固定时才可比** —— 压缩与否、
> 走什么网络、并发度、宿主机负载都会改数。

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
6. `fastapi dev` 这条 CLI **不可用**：requirements 写的是 `fastapi==0.153.0` 而不是
   `fastapi[standard]`，`fastapi-cli` / `typer` / `rich` 都没装。项目用
   `.\.venv\Scripts\python.exe main.py` 启动，不受影响。
