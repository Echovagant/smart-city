# 智慧城市 3D 可视化平台

天安门一带的 OpenStreetMap 建筑与道路数据，在浏览器里以 3D 城市的形式呈现。

界面是**深色 3D 数据可视化大屏**：纯色深底 + 发光网格 + 深色建筑 + 蓝色发光描边 +
分级辉光路网 + 流动光效 + 缓慢环绕的相机。**底座完全自绘，不接任何瓦片服务，也不需要任何地图 key**
（首屏外部请求 0 个）。

界面是 **16:9 大屏骨架**：顶栏（居中标题 + 5 个页签）、左列（核心指标 + 24 小时趋势）、
中心 3D 场景、右列（分类分布 + 实时事件流）、底栏（城市资源概览）。
面板**浮在场景之上**，中心留空让 3D 城市透出来；**图表全部是手写 SVG，
不引任何图表库**（`package.json` 至今零改动）。

大屏上的每个数字都写着它从哪来、什么时候的、是实测还是模型估算。
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
2026-10-22 在本机实测（`scripts/measure-acceptance.py` 可复跑）：

| 指标 | 验收线 | 实测 |
|---|---|---|
| API 响应（95 分位，全量 `/api/buildings`） | < 200 ms | **30.8 ms** |
| API 响应（95 分位，全量 `/api/roads`） | < 200 ms | 30.8 ms |
| 首屏（LargestContentfulPaint） | < 3 s | **1.19 s** |
| 3D 渲染帧率（静止 / 相机运动） | ≥ 30 fps | **76.5 / 160.5 fps** |
| 首屏外部请求（地图瓦片） | 0 | **0 个**（底座自绘，不接任何瓦片服务） |
| 打包体积（应用自身产物，不含 Cesium 运行时） | < 5 MB | **3.96 MB** |
| 测试覆盖率（后端 `main.py` + `data_processor.py`） | > 90% | **94.43%** |
| 测试覆盖率（前端 `src/**`，含 `.ts` 与 `.vue`） | > 80% | **96.66%** |

> **帧率与首屏数字是「16:9 大屏骨架」这一版重测的**（3 轮取中位数，
> 测量期整机 CPU 非空闲 **71%–84%** —— 共享开发机，别把机器忙当成产品慢）。
> 覆盖率两行是**接入设施分类源 + 大屏骨架之后**重测的
> （后端 175 → **186** 个用例，前端 70 → **108** 个用例）。
> `dist/` 相对上一版（`62afc1c`）**只多了 29.6 KB**（8,057,583 → 8,087,229 字节）——
> 大屏是纯 SVG + CSS，没有引入任何图表库。

复跑：

```bash
# 覆盖率
cd backend-python      && ./.venv/Scripts/python.exe -m pytest -q --cov=main --cov=data_processor
cd Data-driven-modeling && npm run test:coverage

# 全部验收指标（需要先产出上面的覆盖率产物）
python scripts/measure-acceptance.py
```

`dist/` 目录总计 **7.71 MB**（104 个文件），其中 **3.73 MB** 是**自托管的 Cesium 运行时**
（98 个文件；厂商运行时，不是应用产物 —— 已按入库的剪枝清单裁掉本应用用不到的部分，
剪枝前是 6.57 MB / 380 个文件）。按「整个 `dist/`」口径仍不满足 5 MB，
按「应用自身产物」口径满足（3.96 MB）。

## 仓库结构

```
backend-python/        FastAPI 后端
  main.py              应用装配、路由、鉴权、响应缓存
  data_processor.py    GeoJSON 加载与 bbox 过滤
  city_data/           城市运行指标数据层（公开数据源 + 聚合 + 降级）
    sources/           空气质量 / 天气 / 路网静态指标 / 设施分类
  scripts/             OSM 数据抓取
  tests/               pytest 套件
Data-driven-modeling/  Vue 3 + Cesium + TypeScript 前端
  src/components/      SmartCity.vue（3D 场景）+ DashboardOverlay.vue（16:9 大屏骨架）
  src/components/dashboard/  大屏面板与 5 个纯 SVG 图表组件
  src/composables/     数据获取 + 页签状态 + 页签→图表的数据模型
  src/api/             fetch 封装
  src/theme/           深色色板（dark.ts）+ 大屏设计 token（dashboard.ts）
  types/               城市类型系统（types/city.ts）
  tsconfig.json        TypeScript 严格模式配置
  vite-plugins/        Cesium 静态资源插件 + 运行时剪枝分析器
  cesium-runtime-manifest.json   入库的 Cesium 运行时剪枝清单
deploy/                nginx 反代配置
scripts/               验收度量脚本（含 Cesium 运行时裁剪回归）
docs/superpowers/      设计文档与实现计划
plans/                 首轮审计报告与计划
```

## 大屏骨架

16:9 大屏是**面板浮在 3D 场景之上**（不是左右分栏裁切）：Cesium 容器保持全屏，
中心那一格留空，3D 城市从面板后面透出来。

```
┌────────────────────── 顶栏：标题 + 5 个页签 ──────────────────────┐
│ 左列：核心指标(6)   │                                     │ 右列：分类分布 │
│        24 小时趋势  │        中心 3D 场景（透出来）        │        实时事件流 │
├──────────────────── 底栏：城市资源概览（横向条形）────────────────┤
```

| 页签 | 核心指标卡（6 个） | 分类分布（环形） | 趋势（折线） | 底栏条形 |
|---|---|---|---|---|
| 区域概览 | 建筑总数 / 道路总数 / 路网总长 / 覆盖面积 / AQI / 气温 | 道路等级分布 | AQI 24h | 设施分类计数 |
| 空气质量 | AQI / 首要污染物 / PM2.5 / PM10 / O3 / NO2 | 污染物浓度 | AQI 24h | 6 项污染物浓度 |
| 公共安全 | 医疗 / 公共安全 / 教育设施 / 建筑总数 / AQI / 气温 | 设施分类 | AQI 24h | 设施分类计数 |
| 城市文旅 | 历史建筑 / 设施分类总数 / 建筑总数 / 路网总长 / AQI / 气温 | 设施分类 | AQI 24h | 设施分类计数 |
| 路网运行 | 路网总长 / 覆盖面积 / 路网负载 / 主干道 / 支路 / 道路总数 | 道路等级分布 | AQI 24h | 道路分级条数 |

- **页签切换 = 换「看哪一组指标」，不是换图表类型**；每个数字都来自
  `GET /api/city/overview` 的真实字段（取数在后端 `city_data/`，前端只渲染）。
- **图表全部是手写 SVG**（指标卡 / 折线 / 环形 / 条形 / 事件流）——
  **不引任何图表库**，`package.json` 与 `package-lock.json` 零改动。
- **面板不吃 Cesium 的鼠标事件**：overlay 容器 `pointer-events: none`，只有面板 `auto`，
  否则中心的拖拽 / 滚轮会被整块吃掉。
- **事件流本轮是诚实的空态**：本项目没有告警系统，线框稿里的事件是占位符，不编。

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
| 设施分类（医疗 / 公共安全 / 教育 / 历史建筑 / 商业办公） | 上面那份本地建筑数据**按 OSM 标签统计** | 无 | 静态快照 | 文件读不到 → 「数据源暂不可用」（`facilities` 为空数组，不编数字） |

- **不注册任何 key**，不引入新依赖（`package.json` 与 `requirements.txt` 零改动）。
- **实测 ≠ 估算**：只有路网负载指数是模型估算（静态几何折算的供给紧张度，
  **不是**实测路况），其余全是实测值。
- **端点永不 500**：任一上游挂了只是把它放进 `degraded`，其余指标照常返回。
- 天气源**只有北京可用**（`101010100`），别的城市直接降级 —— 这是上游的限制，
  不是没试。
- **设施分类的判定规则只写在后端**（`backend-python/city_data/sources/facilities.py`）：
  一个建筑只归一类（按 medical → public_safety → education → heritage → commerce
  的顺序取第一个命中），前端只渲染。
  2026-10-22 实测（3854 栋建筑，**去重后**）：医疗 **24**、公共安全 **18**、
  教育 **19**、历史建筑 **87**、商业与办公 **55**，合计 **203** 处。

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
