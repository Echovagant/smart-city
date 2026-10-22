# 智慧城市 3D 可视化平台

天安门一带的 OpenStreetMap 建筑与道路数据，在浏览器里以 3D 城市的形式呈现。

界面是**深色 3D 数据可视化大屏**：纯色深底 + 发光网格 + 深色建筑 + 蓝色发光描边 +
分级辉光路网 + 流动光效 + 缓慢环绕的相机。**底座完全自绘，不接任何瓦片服务，也不需要任何地图 key**
（首屏外部请求 0 个）。

控制面板上有一条**带来源标注的城市运行指标带**：空气质量（AQI / 良 / 首要污染物）、
气温、路况负载 —— 每个数字都写着它从哪来、什么时候的、是实测还是模型估算。
数据来自**免凭据的公开源**（中国环境监测总站、中国天气网）与**本地 OSM 抽取**，
**不注册任何 key**；取不到的源显示「数据源暂不可用」，**不拿 0 或旧值冒充**。

前端 Vue 3 + Vite + Cesium + TypeScript（严格模式），后端 FastAPI。两端代码库分离、只通过 REST 通信；
生产形态由后端进程自己托管前端的构建产物，**一个 uvicorn 进程同时提供接口与页面**。

数据是 OpenStreetMap 的公开抽取（ODbL），随应用展示时必须署名 —— 界面里已常驻署名行。

## 快速开始

需要 Python 3.12+、Node 20.19+ 或 22.12+。

```bash
# 1. 后端依赖
python -m venv backend-python/.venv
./backend-python/.venv/Scripts/python.exe -m pip install -r backend-python/requirements.txt -r backend-python/requirements-dev.txt

# 2. 抓数据（输出到 backend-python/geojson/，不入 git）
cd backend-python && ./.venv/Scripts/python.exe scripts/fetch_osm_data.py

# 3. 前端依赖
cd Data-driven-modeling && npm install
```

开发时两端各自独立跑：

```bash
cd backend-python      && ./.venv/Scripts/python.exe main.py     # http://127.0.0.1:8000
cd Data-driven-modeling && npm run dev                          # http://localhost:5173/
```

生产形态（单端口）：

```bash
cd Data-driven-modeling && npm run build        # 产物在 dist/
cd backend-python      && ./.venv/Scripts/python.exe main.py   # http://127.0.0.1:8000/ 就是应用本身
```

## 一条命令验证

```powershell
.\verify.ps1     # 后端 pytest + 前端 vitest
```

Linux / macOS 用 `./verify.sh`。CI（`.github/workflows/verify.yml`）在 Windows 与 Ubuntu
两个 job 上跑同一套验证，外加 eslint、**TypeScript 类型检查**与前端构建。

## 验收指标

下表是计划书《智慧城市3D可视化计划书.docx》「成功标准与验收指标」里可量化的那几条，
2026-10-21 在本机实测（`scripts/measure-acceptance.py` 可复跑）：

| 指标 | 验收线 | 实测 |
|---|---|---|
| API 响应（95 分位，全量 `/api/buildings`） | < 200 ms | **17.9 ms** |
| API 响应（95 分位，全量 `/api/roads`） | < 200 ms | 27.8 ms |
| 首屏（LargestContentfulPaint） | < 3 s | **0.86 s** |
| 3D 渲染帧率（静止 / 相机运动） | ≥ 30 fps | **107.5 / 162.1 fps** |
| 首屏外部请求（地图瓦片） | 0 | **0 个**（底座自绘，不接任何瓦片服务） |
| 打包体积（应用自身产物，不含 Cesium 运行时） | < 5 MB | **3.92 MB** |
| 测试覆盖率（后端 `main.py` + `data_processor.py`） | > 90% | **94.00%** |
| 测试覆盖率（前端 `src/**`，含 `.ts` 与 `.vue`） | > 80% | **94.52%** |

> **帧率与首屏数字是「深色底座」改造后重测的**（改造前：静止 98.8 / 运动 163.7 fps，
> LCP 0.86 s，首屏外部瓦片 **77 个**）。改造后**外部瓦片请求降到 0**，
> 帧率与首屏时间持平或更好。测量期整机 CPU 非空闲 61%–68%（同机改造前那轮 79%–98%）。
> 覆盖率两行是**接入城市运行数据层之后**重测的（后端 130 → 175 个用例，前端 63 → 70 个）。

复跑：

```bash
# 覆盖率
cd backend-python      && ./.venv/Scripts/python.exe -m pytest -q --cov=main --cov=data_processor
cd Data-driven-modeling && npm run test:coverage

# 全部验收指标（需要先产出上面的覆盖率产物）
python scripts/measure-acceptance.py
```

`dist/` 目录总计 **7.67 MB**（104 个文件），其中 **3.75 MB** 是**自托管的 Cesium 运行时**
（98 个文件；厂商运行时，不是应用产物 —— 已按入库的剪枝清单裁掉本应用用不到的部分，
剪枝前是 6.57 MB / 380 个文件）。按「整个 `dist/`」口径仍不满足 5 MB，
按「应用自身产物」口径满足（3.92 MB）。

## 仓库结构

```
backend-python/        FastAPI 后端
  main.py              应用装配、路由、鉴权、响应缓存
  data_processor.py    GeoJSON 加载与 bbox 过滤
  city_data/           城市运行指标数据层（公开数据源 + 聚合 + 降级）
  scripts/             OSM 数据抓取
  tests/               pytest 套件
Data-driven-modeling/  Vue 3 + Cesium + TypeScript 前端
  src/components/      SmartCity.vue —— 3D 场景与控制面板
  src/composables/     数据获取
  src/api/             fetch 封装
  types/               城市类型系统（types/city.ts）
  tsconfig.json        TypeScript 严格模式配置
  vite-plugins/        Cesium 静态资源插件 + 运行时剪枝分析器
  cesium-runtime-manifest.json   入库的 Cesium 运行时剪枝清单
deploy/                nginx 反代配置
scripts/               验收度量脚本（含 Cesium 运行时裁剪回归）
docs/superpowers/      设计文档与实现计划
plans/                 首轮审计报告与计划
```

## 数据来源

面板上的每个数字都能回答「从哪来、什么时候的、是实测还是估算」。契约在后端
`backend-python/city_data/models.py`（`SourceInfo` / `Metric`），前端同名字段在
`Data-driven-modeling/types/city.ts`。

| 源 | 地址 | 凭据 | 实时性 | 降级 |
|---|---|---|---|---|
| 空气质量（AQI / 分级 / 首要污染物 / 24 小时序列） | `https://air.cnemc.cn:18007`（中国环境监测总站） | 免凭据（需带 `Referer`） | 实时（小时级） | 取不到 → 该格显示「数据源暂不可用」 |
| 气温 / 湿度 | `http://www.weather.com.cn/data/sk/101010100.html`（中国天气网） | 免凭据 | **不新鲜**：上游只给 `HH:MM`，实测时间戳会落在未来，契约里标 `realtime: false` | 取不到 → 「数据源暂不可用」 |
| 建筑 / 道路数量、路网总长、覆盖面积 | 本地 `backend-python/geojson/*.geojson`（OSM 抽取） | 无 | 静态快照（抽取于 2026-06-21） | 文件读不到 → 「数据源暂不可用」 |
| 路网负载指数 | 上面那份本地数据**自己算** | 无 | —— | **模型估算**（`estimated: true`，界面标「（模型估算）」） |

- **不注册任何 key**，不引入新依赖（`package.json` 与 `requirements.txt` 零改动）。
- **实测 ≠ 估算**：只有路网负载指数是模型估算（静态几何折算的供给紧张度，
  **不是**实测路况），其余全是实测值。
- **端点永不 500**：任一上游挂了只是把它放进 `degraded`，其余指标照常返回。
- 天气源**只有北京可用**（`101010100`），别的城市直接降级 —— 这是上游的限制，
  不是没试。

## 配置

后端配置读 `backend-python/.env`（不入 git，模板见 `backend-python/.env.example`）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8000` | 监听端口 |
| `DEBUG` | `True` | **生产必须 `False`** |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | CORS 允许来源，逗号分隔 |
| `API_KEY` | 空 | 设了之后 `/api/buildings`、`/api/roads` 需要带 `X-API-Key` 头 |
| `EXPOSE_DOCS` | `False` | 是否暴露 `/docs` `/redoc` `/openapi.json` |
| `ALLOWED_HOSTS` | 空 | Host 头白名单，逗号分隔；留空不限制 |

## 文档

- [`CLAUDE.md`](CLAUDE.md) —— 仓库给 agent 与新人的总说明，每条事实都带 `文件:行号`
- [`backend-python/README.md`](backend-python/README.md) —— 后端说明
- [`Data-driven-modeling/README.md`](Data-driven-modeling/README.md) —— 前端说明

## 部署

仓库根提供 `Dockerfile` / `docker-compose.yml` / `deploy/nginx.conf` 三份配置。
**这三份文件未在编写环境里经过 `docker build` / `nginx -t` 验证**（那台机器没装 Docker 与 nginx），
首次使用请先本地验证。

## License

[Apache License 2.0](LICENSE)

数据来自 [OpenStreetMap](https://www.openstreetmap.org/copyright)，遵循 ODbL。
