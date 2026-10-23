# 智慧城市 3D 可视化平台

<p align="center">
把 OpenStreetMap 的建筑与道路数据，变成可环视、可查询、可下钻的三维城区
</p>

![大屏总览：中心是三维城市场景，四周是数据面板](docs/images/dashboard-overview.png)

中心城区的一小块 OpenStreetMap 建筑与道路，在浏览器里成了一座可以环视、可以查询、
可以点进去的城市；四周的面板给出这片区域的运行指标与派生事件。

## 它能做什么

**看清整片区域。** 深色三维底座：建筑按真实高度拉伸，道路按等级分级发光，相机缓慢环绕。
底座自绘，打开即是，不加载任何瓦片服务。

**按页签切换关注点。** 顶栏 5 个页签 —— 区域概览、空气质量、公共安全、城市文旅、路网运行。
每个页签给出对应的指标卡、分类构成与趋势图；切页签时场景同步高亮该类别的建筑，其余压暗。

**看趋势，不只看当下。** 左列的趋势面板支持 **24 小时**与**逐日**两个视图：
逐日视图给出最近 14 天的 AQI 与六项污染物日均值，可逐项切换。
时间都是本地时间，取不到数据时显示空态，不画一条假的平线。

**点一下地面，查那片范围。** 在三维场景里单击地面，右列立刻给出这一片的建筑数、路网总长、
道路分级、设施分类与建筑密度。半径可选 200 / 300 / 500 m；点的是哪个位置、范围多大，
面板上都写着，数字与接口返回逐字一致。

**知道每个数字的来路。** 空气质量与气温来自公开数据源，建筑与道路来自本地 OSM 抽取。
每张指标卡标着来源名与观测时间；模型估算项单独标注；某个源取不到时显示「数据源暂不可用」，
不用 0 或旧值顶替。

**追到具体位置。** 事件流里的每条都由真实指标派生 —— 空气质量等级变化、当前空气质量超阈、
路网负载超阈、极端天气。场景里用告警脉冲环与垂直光柱标出位置，点一条就飞过去。
没有告警系统时事件流为空，并说明是哪些条件没触发。

**自己挑一套配色。** 底栏的主题入口切换三套预设 —— 深空蓝（默认）、石墨灰、深海青。
道路主色与建筑本体色可以自己取，辉光强度与路面不透明度可以拖动，改完立刻生效。
换主题只改材质上的颜色值，不重建任何几何 —— 3854 栋楼与 2260 条路的图元原地不动。

**自己跑起来。** 生产形态下后端进程同时提供接口与页面，一个 uvicorn 进程即可。

## 界面预览

### 空气质量

![空气质量页签：首要污染物、六项污染物浓度、浓度构成环形图与 24 小时 AQI 趋势](docs/images/dashboard-air-quality.png)

六项污染物在环形图里统一换算成 μg/m³ 才能相加，底栏的条形图则各自保留原单位。

### 公共安全

![公共安全页签：设施分类指标卡与分类构成环形图，场景中其余建筑压暗、对应分类高亮](docs/images/dashboard-public-safety.png)

切到这个页签，医疗、公共安全与教育设施所在的那几栋楼被点亮，其余建筑的描边压暗 ——
城市还在，注意力收到了该看的地方。

### 区域统计

![区域统计：右列上方的面板给出选中范围的建筑数、路网总长、道路分级与设施分类](docs/images/dashboard-area-stats.png)

在场景里单击地面，面板给出这一片的范围面积、建筑数、路网总长与建筑密度，
外加道路分级和设施分类的分解。半径可选 200 / 300 / 500 m；
面板上标着选中的坐标与数据来源，数字与接口返回逐字一致。

### 主题

![主题选择器：三套预设主题卡片、道路主色与建筑本体色取色器、辉光强度与路面不透明度滑块](docs/images/theme-picker.png)

底栏的主题入口切换三套预设 —— 深空蓝（默认）、石墨灰、深海青。
道路主色与建筑本体色可以自己取，辉光强度与路面不透明度可以拖动。
预警橙与告警红是语义色，跨主题恒定，不在自选范围内。

## 快速开始

需要 Python 3.12+、Node 20.19+ 或 22.12+。**不需要注册任何 key，也不需要 API 凭据。**

```bash
# 1. 取数据（输出到 backend-python/geojson/，不入库）
cd backend-python
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -r requirements.txt -r requirements-dev.txt
./.venv/Scripts/python.exe scripts/fetch_osm_data.py

# 2. 前端依赖
cd ../Data-driven-modeling && npm install
```

开发时两端各自跑：

```bash
cd backend-python      && ./.venv/Scripts/python.exe main.py     # http://127.0.0.1:8000
cd Data-driven-modeling && npm run dev                          # http://localhost:5173/
```

生产形态只要一个进程：

```bash
cd Data-driven-modeling && npm run build     # 产物在 dist/
cd backend-python      && ./.venv/Scripts/python.exe main.py
# http://127.0.0.1:8000/ 就是应用本身
```

> Linux / macOS 把 `./.venv/Scripts/python.exe` 换成 `./.venv/bin/python`。
> 抓取脚本的范围与注意事项见 `backend-python/scripts/README.md`。

### 配置

后端配置读 `backend-python/.env`（不入库，模板见 `backend-python/.env.example`）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8000` | 监听端口 |
| `DEBUG` | `True` | **生产必须 `False`** |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | CORS 允许来源，逗号分隔 |
| `API_KEY` | 空 | 设了之后 `/api/buildings`、`/api/roads` 需要带 `X-API-Key` 头 |
| `EXPOSE_DOCS` | `False` | 是否暴露 `/docs` `/redoc` `/openapi.json` |
| `ALLOWED_HOSTS` | 空 | Host 头白名单，逗号分隔；留空不限制 |

## 数据来源

| 数据 | 地址 | 凭据 | 实时性 |
|---|---|---|---|
| 空气质量（AQI / 分级 / 首要污染物 / 24 小时序列 / 14 天逐日序列） | `https://air.cnemc.cn:18007`（中国环境监测总站） | 免凭据 | 实时（小时级）；逐日序列按定义不是实时 |
| 气温 / 湿度 | `http://www.weather.com.cn/data/sk/101010100.html`（中国天气网） | 免凭据 | 上游只给 `HH:MM`，时间戳可能落在未来，契约里标 `realtime: false`；仅北京可用 |
| 建筑 / 道路 / 路网 / 设施分类 / 区域统计 | 本地 OpenStreetMap 抽取 | 无 | 静态快照 |

- 路网负载指数是**模型估算**（静态几何折算的供给紧张度，不是实测路况），界面上标「（模型估算）」。
- 端点不会因为某个上游挂了而报错 —— 该源降级，其余指标照常返回。

## 技术栈

| | |
|---|---|
| **后端** | Python 3.12 · FastAPI · Uvicorn · Pydantic v2 · Shapely |
| **前端** | Vue 3 · Vite 7 · TypeScript 5.9（严格模式）· Cesium 1.134 |
| **图表** | 手写 SVG（指标卡 / 折线 / 环形 / 条形 / 事件流），无图表库依赖 |
| **测试** | pytest + pytest-cov · Vitest + @vue/test-utils |

两端代码库完全分离，只通过 REST 通信。架构细节见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 目录

| 路径 | 内容 |
|---|---|
| `backend-python/main.py` | 应用装配、路由、响应缓存、gzip 与安全响应头 |
| `backend-python/data_processor.py` | GeoJSON 加载与 bbox 过滤 |
| `backend-python/city_data/` | 运行指标数据层：契约、聚合、公开数据源、派生事件 |
| `backend-python/scripts/` | OpenStreetMap 数据抓取 |
| `Data-driven-modeling/src/components/SmartCity.vue` | 场景装配层：把场景 composable、数据轮询与大屏骨架接起来 |
| `Data-driven-modeling/src/components/DashboardOverlay.vue` | 16:9 大屏骨架 |
| `Data-driven-modeling/src/components/dashboard/` | 大屏面板与图表组件 |
| `Data-driven-modeling/src/composables/` | 场景层（底座 / 相机 / 交通 / 事件标记 / 页签联动 / 区域统计）、取数、页签状态与纯函数 |
| `Data-driven-modeling/src/theme/` | 深色色板与大屏设计 token |
| `docs/ARCHITECTURE.md` | 架构说明与开发约定 |

## License

代码以 [Apache License 2.0](LICENSE) 发布。

数据来自 [OpenStreetMap](https://www.openstreetmap.org/copyright)，遵循 ODbL：
随应用展示这份数据时必须署名，界面里已常驻「数据 © OpenStreetMap contributors」署名行。
