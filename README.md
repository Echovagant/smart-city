# 智慧城市 3D 可视化平台

<p align="center">
深色自绘的 3D 城市底座 · 真实公开数据 · 纯 SVG 图表 · <strong>不需要任何地图 key</strong>
</p>

![大屏总览：16:9 布局，中心是自绘的 3D 城市，四周是数据面板](docs/images/dashboard-overview.png)

中心城区的一小块 OpenStreetMap 建筑与道路，在浏览器里变成一座可以环视、可以查询、
可以点进去的城市；四周的面板里，每个数字都写着它从哪来、什么时候的、是实测还是估算。

## 功能特性

**自绘的 3D 底座，不依赖任何瓦片服务**
纯色深底 + 200 米间距的发光网格 + 深色建筑 + 蓝色发光描边 + 四级辉光路网 + 沿线流动的光效。
底座完全自绘，**首屏外部请求 0 个**，也不需要注册任何地图 key。

**16:9 大屏布局**
顶栏是标题、5 个页签与一条实时读数带；左列是核心指标与 24 小时趋势；
中心留给 3D 场景；右列是分类分布与实时事件流；底栏是城市资源概览与操作按钮。
面板浮在场景之上，中心留空让城市透出来 —— 拖拽与滚轮依然直接作用在 3D 场景上。

**图表全部是手写 SVG**
指标卡、折线、环形、条形、事件流五个组件都是手写 SVG，**不引入任何图表库**。
断线不补 0、取不到的值画成空槽而不是 0。

**每个数字都带来源**
指标卡上标着来源名、观测时间与取数时间。模型估算项标「（模型估算）」；
上游时间戳不新鲜时标「（非实时）」；取不到的源显示「数据源暂不可用」——
**不拿 0 或上一次的旧值冒充**。

**真实公开数据，零凭据**
空气质量（AQI、分级、首要污染物、24 小时逐小时序列）、气温与湿度来自免 key 的公开源；
建筑数、道路数、路网总长、覆盖面积、设施分类来自本地 OpenStreetMap 抽取。
**不注册任何 key**，不需要 API 凭据。

**派生出来的事件流**
每条事件都从真实指标派生（空气质量等级变化、当前空气质量超阈、路网负载超阈、极端天气），
场景里用**告警脉冲环 + 垂直光柱**标出位置，点一条就飞过去。
**这个项目没有告警系统** —— 派生不出来时事件流就是空的，空态会说明「检查了哪些条件、为什么没触发」，
不编造事件凑数。

**页签联动场景**
切页签时高亮该分类的建筑、其余的描边压暗，相机不动。
高亮只改一个材质 uniform，不重建几何。

**一个进程同时提供接口与页面**
生产形态下后端进程托管前端的构建产物，`uvicorn` 起一个就够。

**跑得快、装得小**
首屏外部请求 **0 个**（底座自绘，不联系任何第三方）；
应用自身产物 **3.97 MB**，自托管的 Cesium 运行时按静态可达性裁到 98 个文件（厂商原包 380 个）。
后端 245 个测试、前端 152 个测试，覆盖率 94% / 96.53%。

**一条命令验证**
`.\verify.ps1`（Windows）/ `./verify.sh`（Linux、macOS）跑完两端测试；
CI 在 Windows 与 Ubuntu 两个 job 上跑同一套验证，外加 lint、类型检查与前端构建。

## 界面预览

### 空气质量

![空气质量页签：首要污染物、六项污染物浓度、浓度构成环形图与 24 小时 AQI 趋势](docs/images/dashboard-air-quality.png)

六项污染物在环形图里统一换算成 μg/m³ 才能相加（CO 上游给的是 mg/m³），
底栏的条形图则各自保留原单位。

### 公共安全 · 页签联动场景

![公共安全页签：设施分类指标卡与分类构成环形图，场景中其余建筑压暗、对应分类高亮](docs/images/dashboard-public-safety.png)

切到这个页签，医疗、公共安全与教育设施所在的那几栋楼被点亮，
其余建筑的描边压暗 —— 城市还在，但注意力被收到了该看的地方。

## 技术栈

| | |
|---|---|
| **后端** | Python 3.12 · FastAPI 0.153.0 · Uvicorn 0.30.1 · Pydantic 2.14.1 · pydantic-settings 2.1.0 · Shapely 2.0.4 · NumPy < 2 |
| **前端** | Vue 3.5.44 · Vite 7 · TypeScript 5.9（严格模式）· Cesium 1.134 |
| **测试** | pytest 8.3 + httpx + pytest-cov · Vitest 2.1 + @vue/test-utils + jsdom |
| **工程** | ESLint 9 · Prettier 3.6 · GitHub Actions（Windows + Ubuntu） |
| **数据** | OpenStreetMap 抽取（ODbL）· 中国环境监测总站 · 中国天气网 |

后端与前端的代码库完全分离，**只通过 REST 通信**：没有共享包、没有 schema 文件、
没有生成的客户端 —— 契约的后端事实在 `backend-python/city_data/models.py`，
前端的对应类型在 `Data-driven-modeling/types/city.ts`，两边同名。

## 快速开始

需要 Python 3.12+、Node 20.19+ 或 22.12+。

### 1. 取数据

建筑与道路是 OpenStreetMap 的公开抽取，**不入 git**，用脚本现场抓：

```bash
cd backend-python
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -r requirements.txt -r requirements-dev.txt
./.venv/Scripts/python.exe scripts/fetch_osm_data.py
```

> Linux / macOS 把 `./.venv/Scripts/python.exe` 换成 `./.venv/bin/python`。
> 脚本只抓建筑与道路两个图层，范围与注意事项见 `backend-python/scripts/README.md`。

### 2. 起前端

```bash
cd Data-driven-modeling
npm install
npm run dev          # http://localhost:5173/
```

### 3. 起后端

```bash
cd backend-python
./.venv/Scripts/python.exe main.py     # http://127.0.0.1:8000
```

两端各自跑起来就能用了。生产形态只要一个进程：

```bash
cd Data-driven-modeling && npm run build     # 产物在 dist/
cd backend-python      && ./.venv/Scripts/python.exe main.py
# http://127.0.0.1:8000/ 就是应用本身
```

### 4. 验证

```bash
.\verify.ps1     # Windows：后端 pytest + 前端 vitest
./verify.sh      # Linux / macOS
```

单独跑覆盖率：

```bash
cd backend-python      && ./.venv/Scripts/python.exe -m pytest -q --cov=main --cov=data_processor --cov=city_data
cd Data-driven-modeling && npm run test:coverage
```

### 配置

后端配置读 `backend-python/.env`（不入 git，模板见 `backend-python/.env.example`）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8000` | 监听端口 |
| `DEBUG` | `True` | **生产必须 `False`** |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | CORS 允许来源，逗号分隔 |
| `API_KEY` | 空 | 设了之后 `/api/buildings`、`/api/roads` 需要带 `X-API-Key` 头 |
| `EXPOSE_DOCS` | `False` | 是否暴露 `/docs` `/redoc` `/openapi.json` |
| `ALLOWED_HOSTS` | 空 | Host 头白名单，逗号分隔；留空不限制 |

## 目录

| 路径 | 内容 |
|---|---|
| `backend-python/main.py` | 应用装配、路由、响应缓存、gzip 与安全响应头 |
| `backend-python/data_processor.py` | GeoJSON 加载与 bbox 过滤 |
| `backend-python/city_data/` | 城市运行指标数据层：契约、聚合、公开数据源、派生事件 |
| `backend-python/scripts/` | OpenStreetMap 数据抓取 |
| `backend-python/tests/` | pytest 套件（245 个用例） |
| `Data-driven-modeling/src/components/SmartCity.vue` | 3D 场景、事件标记、页签联动 |
| `Data-driven-modeling/src/components/DashboardOverlay.vue` | 16:9 大屏骨架 |
| `Data-driven-modeling/src/components/dashboard/` | 大屏面板与 5 个纯 SVG 图表组件 |
| `Data-driven-modeling/src/composables/` | 取数、页签状态、图表数据模型、事件与联动的纯函数 |
| `Data-driven-modeling/src/theme/` | 深色色板与大屏设计 token |
| `Data-driven-modeling/types/city.ts` | 前端类型系统 |
| `Data-driven-modeling/vite-plugins/` | Cesium 静态资源插件与运行时剪枝分析器 |
| `scripts/` | 验收度量与 Cesium 运行时裁剪回归 |
| `docs/ARCHITECTURE.md` | 架构说明与不能破的约定 |

## 数据来源

| 数据 | 地址 | 凭据 | 实时性 |
|---|---|---|---|
| 空气质量（AQI / 分级 / 首要污染物 / 24 小时序列） | `https://air.cnemc.cn:18007`（中国环境监测总站） | 免凭据 | 实时（小时级） |
| 气温 / 湿度 | `http://www.weather.com.cn/data/sk/101010100.html`（中国天气网） | 免凭据 | 上游只给 `HH:MM`，时间戳可能落在未来，契约里标 `realtime: false`；仅北京可用 |
| 建筑 / 道路 / 路网 / 设施分类 | 本地 OpenStreetMap 抽取 | 无 | 静态快照 |

- **实测 ≠ 估算**：路网负载指数是**模型估算**（静态几何折算的供给紧张度，不是实测路况），
  界面上标「（模型估算）」；其余全是实测值。
- **端点永不 500**：任一上游挂了只是把它放进 `degraded`，其余指标照常返回。
- **事件不编**：派生不出来就是空数组。

## License

代码以 [Apache License 2.0](LICENSE) 发布。

数据来自 [OpenStreetMap](https://www.openstreetmap.org/copyright)，遵循 ODbL：
随应用展示这份数据时必须署名，界面里已常驻「数据 © OpenStreetMap contributors」署名行。
