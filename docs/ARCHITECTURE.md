# 架构说明

面向要改这个仓库的人：代码怎么组织、命令怎么跑、哪些约定不能破。

## 全局结构

两层式 monorepo，**两端代码库分离，只通过 REST 通信**：

| | 目录 | 技术栈 |
|---|---|---|
| 后端 | `backend-python/` | Python 3.12 · FastAPI · Uvicorn · Pydantic v2 · Shapely |
| 前端 | `Data-driven-modeling/` | Vue 3 · Vite 7 · Cesium 1.134 · TypeScript 5.9（严格模式） |

**没有共享包、没有 schema 文件、没有生成的客户端** —— 后端改契约就要同时改前端。
契约的唯一事实来源是后端的 `backend-python/city_data/models.py`，
前端的对应类型在 `Data-driven-modeling/types/city.ts`（两边**同名**，改一处就要改另一处）。

开发时两端各自独立跑（Vite dev server + FastAPI）；生产形态由后端进程托管前端构建产物，
于是**一个 uvicorn 进程同时提供接口与页面**。

## 常用命令

```bash
# 后端（在 backend-python/ 下）
./.venv/Scripts/python.exe -m pytest -q          # 测试
./.venv/Scripts/python.exe main.py               # 启动（DEBUG=True 时自动 reload）

# 前端（在 Data-driven-modeling/ 下）
npm run dev          # 开发服务器
npm run typecheck    # vue-tsc --noEmit（类型检查是独立的一步，build 不会查类型）
npm run lint         # eslint --no-fix
npm test -- --run    # vitest 单次跑完（直接 npm test 是 watch 模式）
npm run build        # 产物在 dist/
```

仓库根有一条命令跑完两端测试：

```bash
.\verify.ps1     # Windows
./verify.sh      # Linux / macOS
```

CI（`.github/workflows/verify.yml`）在 Windows 与 Ubuntu 两个 job 上跑同一套验证，
外加 lint、类型检查与前端构建。

## 后端

### 端点

| 路径 | 说明 |
|---|---|
| `GET /` | 有前端构建产物时返回页面本身，否则返回服务信息 JSON |
| `GET /health` | 健康检查 |
| `GET /api/buildings` | 建筑 GeoJSON，可选 `bbox=min_lon,min_lat,max_lon,max_lat` |
| `GET /api/roads` | 道路 GeoJSON，同样支持 `bbox` |
| `GET /api/traffic-status` | 按时间推导的交通状态（合成读数，不是实测路况） |
| `GET /api/city/overview` | 城市运行指标聚合（见下） |
| `GET /api/city/area` | 一片矩形范围内的空间统计（`bbox` **必填**） |

`bbox` 参数任何不合法输入都返回 **400** 并附中文原因（个数不对 / 非数字 / `nan` / `inf` / 倒置 / 越界）。
参数问题与数据是否可用**无关** —— 先校验再读数据。

### 数据层 `backend-python/city_data/`

| 模块 | 职责 |
|---|---|
| `models.py` | Pydantic 契约：`SourceInfo` / `Metric` / `Series` / `SeriesPoint` / `FacilityCategory` / `CityEvent` / `EventLocation` / `CityOverview` / `AreaStats` |
| `aggregator.py` | 六个源**并发**取数（`asyncio.gather`），每个源独立 5 秒预算，按 TTL 缓存 |
| `http.py` | 只用标准库的 JSON 取数封装，所有失败统一收敛成 `SourceUnavailable` |
| `city_codes.py` | 城市代码表的静态快照（**只有代码，没有名称**；只用于参数校验，不联网） |
| `events.py` | **纯函数**模块：从真实指标派生事件流 |
| `sources/air_quality.py` | 空气质量（AQI / 分级 / 首要污染物 / 24 小时逐小时序列 / 14 天逐日序列） |
| `sources/weather.py` | 气温与湿度 |
| `sources/road_network.py` | 路网静态指标（建筑数、道路数、路网总长、覆盖面积、各等级条数）+ 路网负载指数 |
| `sources/facilities.py` | 设施分类（按 OSM 标签统计，一栋建筑只归一类） |
| `sources/area.py` | **纯函数**模块：按矩形范围聚合空间统计（不联网） |

**降级**：任一源失败只是把它放进 `degraded`，其余指标照常返回，**端点永不 500**。
取不到的指标值是 `null`，**不拿 0 或上一次的旧值冒充**。

### 缓存

三级，全在 `main.py`：

1. 解析后的原始 GeoJSON（进程内）
2. 按 `bbox` 的过滤结果，**容量上限 8 的 LRU**
3. **不带 `bbox` 的全量响应** —— 序列化后的字节与预压缩的 gzip 字节一起缓存，
   命中时直接返回，不再重复序列化与压缩

缓存条目记着产生它的那份原始数据对象，数据重新加载后旧条目自动作废。
**带 `bbox` 的响应体不缓存**（参数组合无界）—— 缓存的是第 2 级的过滤结果，不是序列化后的响应。

`GET /api/city/area` 另有一层**聚合结果缓存**（同样是 LRU-8）：范围过滤复用上面第 2 级的
`bbox` 缓存，聚合结果再缓存一份 `AreaStats`。本机实测：进程冷启动首请求 **349 ms**，
缓存命中中位 **2.8 ms**（最小 1.9 ms）。

### 传输与安全

- gzip：`minimum_size=1000`、`compresslevel=9`（`/health` 这类小响应不压缩）
- 每个响应都带 `X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、
  `X-Frame-Options: SAMEORIGIN`
- CSP **只做 report-only 观测**：设环境变量 `CSP_REPORT_ONLY=<策略>` 才带上
  `Content-Security-Policy-Report-Only` 头。**任何时候都没有强制头** ——
  Cesium 需要 `'unsafe-eval'`（求值 + WebAssembly）与 `'unsafe-inline'`（内联样式），
  强制启用前必须先看报告里的违规清单，否则会让 worker 加载失败、地图一片空白
- `/docs` `/redoc` `/openapi.json` **默认不暴露**（`EXPOSE_DOCS` 缺省 `False`）

## 前端

### 大屏骨架

界面是 **16:9 大屏**：顶栏（标题 + 页签 + 读数带）、左列（核心指标 + 趋势面板）、
中心 3D 场景、右列（区域统计 + 分类分布 + 实时事件流）、
通栏底栏（城市资源概览 + 控制按钮 + 署名）。

**面板浮在场景之上，不做左右分栏裁切**：Cesium 容器保持全屏，中心那一格留空，
3D 城市从面板后面透出来。overlay 容器 `pointer-events: none`，只有面板本身 `auto` ——
否则中心的 Cesium 交互（拖拽 / 滚轮）会被整块吃掉。

### 区域统计：点一下地面

右列第一块是**区域统计**（`AreaStats.vue` + `useAreaQuery.ts`）：
在三维场景里单击地面 → 命中点的经纬度 → 以它为中心取一个固定半径的矩形范围 →
`GET /api/city/area?bbox=…` → 面板给出建筑数、路网总长、道路分级、设施分类与建筑密度。
半径分 200 / 300 / 500 m 三档，可随时切换（切换即重查）。

**只挂一个 `LEFT_CLICK` 监听，一行相机代码都不写**：
Cesium 的 `ScreenSpaceEventHandler` 只在「按下与抬起之间没有位移」时才算一次点击，
所以拖拽仍然是拖拽（相机照旧旋转、滚轮照旧缩放），拖完松手也不会误触发一次查询。

**场景底座要显式传下来**：`SmartCity.vue` 用 `:stage="stage"` 把 `useSceneStage()` 的返回值
交给大屏，**不翻组件实例** —— 生产构建里 `<script setup>` 的顶层绑定不会挂到
`setupState` 上（构建必然启用 `inlineTemplate`，setup 直接返回渲染函数），
从实例上取绑定在 dev 能用、在生产取不到。dev 与生产必须是同一套行为。

同理，底座里的 `viewer` 引用要用 `toRaw` 取：底座若经过**深响应式代理**，
Vue 会**解包 ref**，`stage.viewer` 拿回来是 `null` 而不是那个 `Ref` ——
拿它去 `watch` 只会得到一句警告，监听根本装不上。

### 图表

`src/components/dashboard/` 下的图表**全是手写 SVG**：
`MetricCard` / `LineChart` / `DonutChart` / `BarChart` / `EventStream`，
外加趋势面板 `TrendPanel`（24 小时 / 逐日两个视图，复用 `LineChart` 画折线）
与区域统计面板 `AreaStats`。
**不引任何图表库** —— `package.json` 与 `package-lock.json` 至今零改动。

### 场景

场景逻辑拆在 `src/composables/` 下的 5 个 composable 里，
`src/components/SmartCity.vue` 只负责装配与编排（里面已无任何 `Cesium.` 调用）：

| 文件 | 职责 |
|---|---|
| `useSceneStage.ts` | Cesium 初始化、深色场景、发光网格、建筑与道路装配、批量描边 |
| `useCameraRig.ts` | 鸟瞰/平视、环绕自转、交互打断与恢复、相机飞行 |
| `useTrafficFleet.ts` | 车辆与路灯 |
| `useEventMarkers.ts` | 告警光柱 / 体量圆柱 / 脉冲环、点事件飞过去 |
| `useSceneLinkageEffect.ts` | 页签联动在场景里的副作用（高亮焦点、压暗其余） |

**共享可变状态只有一份**：`viewer`、场景级批量图元的引用与材质（`buildingGlow` /
`buildingGlowMaterial` / `flow` / `flowMaterial` / `focusGlow`）、视图状态 `state`
（图层显隐 / 视角模式 / 三组实体列表）都在 `useSceneStage` 里，其余 composable 从这里
**拿引用**，不复制、不另存 —— 两份就是不同步的隐患。相机自转状态同理只有
`useCameraRig` 一份，其余通过 `camera.flyTo()` 请求一次飞行，不直接碰它。

`src/composables/useSceneLinkage.ts` 与 `useSceneLinkageEffect.ts` 是**两回事**：
前者是**纯函数**（`resolveSceneLinkage` / `resolveFocusBuildingIds`），
后者是这些纯函数落到场景里的**副作用**。

- 建筑与道路来自 `Cesium.GeoJsonDataSource`
- 建筑描边是**一个批量 Primitive**（不是每个建筑一个实体）
- 道路按 OSM 的 `highway` 标签分四级，1~2 级额外叠一层流动光效
- 相机缓慢环绕，用户一交互就停，超过 4 秒无交互才恢复

### 主题

`src/theme/dark.ts` 是**视觉的唯一事实来源** —— 组件与样式表都不就地写颜色。
`src/theme/dashboard.ts` 只放**尺寸与排版**（间距、圆角、字号阶梯、列宽）。

## 不能破的约定

### 数据诚信

大屏上的每个数字都要能回答三个问题：**从哪来、什么时候的、是实测还是估算**。

1. 每个指标都必须带 `source`（来源名、取数地址、观测时刻、取数时刻、是否估算）
2. **模型估算必须标 `source.estimated = true`**，界面上要标「（模型估算）」
3. **取不到的源进 `degraded`，指标值写 `null`**，界面显示「数据源暂不可用」——
   **不许**用 0 或上一次的旧值冒充
4. `observed_at`（上游数据自身的时间）与 `fetched_at`（我们取到它的时间）**不许混用**；
   缓存命中时 `fetched_at` 仍是**首次取数**的时间
5. **事件不许编**：事件流的每一条都必须从真实指标派生，派生不出来就是**空数组**。
   空态要说明「检查了哪些条件、为什么没触发」
6. **算出来的数要写清口径**：区域统计端点的每个数字都配一个 `method` 字段 ——
   算法说明、保留精度、线要素与面要素各多少、各数据文件的观测时间。
   「每个数字都能追到来源」不只对指标成立，对几何折算出来的数也成立

### 颜色

**蓝色只做强调与辉光，橙色只做预警，红色只做告警。**

- 分类图表（环形图 / 条形图）用 `DARK_PALETTE.chartSeries`（蓝青系 6 档）。
  普通分类画成橙色，看图的人会读成一条告警 —— 那是语义级错误
- 橙与红只留给 severity：拥堵徽标、事件流的严重度、告警脉冲环
- 6 档是因为空气质量页的环形图有 6 项污染物，5 档会让第 6 段循环回第 1 段

### Cesium

- **`glowPower` 必须包成 `ConstantProperty`**。裸数字会让材质变成「非常量」，
  Cesium 认定这条线是 dynamic → 贴地几何**每帧重建**（2260 条路能把帧率打到 30）。
  用 `createGlowMaterial` / `createPulseGlowMaterial`，它们已经包好了
- **脉冲环必须 `clampToGround: true`**。非贴地的 dynamic polyline 会走 Cesium 的异步
  `Primitive` 路径 → 请求 `Workers/createPolylineGeometry.js` → 那个 worker 被剪枝清单
  剪掉了 → 404 → 页面报 "Rendering has stopped."，整个城市画不出来
- **非贴地的竖直图元要自己建 `Primitive`**（`asynchronous: false`），
  同网格 / 批量描边 / 流动光效那一套
- **改材质 uniform 是最省的一刀**：`Material._uniforms[name]` 是每帧求值的取值函数，
  换掉 `material.uniforms.color` 下一帧就生效 —— 不重建几何、不换 appearance
- **绝不逐个改几千个建筑的 `polygon.material`** —— 会打散 Cesium 的批处理 →
  全量几何重建 → 卡死

### 运行时裁剪

`vite-plugins/cesium-prune.mjs` 是 Cesium 运行时的**静态可达性分析器**，
按四种加载机制（路径字面量 / 模板串 / 目录字面量 / worker 名 + worker 间的相对 import 闭包）
算出本应用真正会用到的文件，裁剪清单入库在 `cesium-runtime-manifest.json`。

- `npm run build` 之后产物里的 `dist/Cesium` 是 **98 个文件**
- `node scripts/verify-cesium-runtime.mjs` 跑一遍交互回归（10 个动作），
  确认被剪的文件确实没被请求
- `node scripts/check-cesium-runtime-manifest.mjs` 校验清单与产物一致 —— 升级 Cesium
  或改了应用功能时它会红

## 数据

- 建筑与道路是 **OpenStreetMap 的公开抽取**（ODbL），**不入 git**，
  用 `backend-python/scripts/fetch_osm_data.py` 重新抓取（用法见
  `backend-python/scripts/README.md`）
- 界面里**常驻署名行**「数据 © OpenStreetMap contributors」—— 展示这份数据必须署名，
  删掉这一行等于违反许可证
- 空气质量与天气走**免凭据的公开源**，不注册任何 key
- 空气质量有两条序列：24 小时逐小时序列与 **14 天逐日序列**（逐日是各项污染物的日均值，
  与逐小时序列分属两个源，逐日挂了不影响 24 小时曲线）
- 天气源**只有北京可用**，别的城市直接降级 —— 这是上游的限制
- 设施分类的判定规则**只写在后端**（`city_data/sources/facilities.py`），
  前端不判定任何标签
- 区域统计端点**只读本地 OSM 快照**（`bbox` 必填），不走「多源并发 + 降级」那套聚合器

## 已知限制

- `Dockerfile` / `docker-compose.yml` / `deploy/nginx.conf` **未经过 `docker build` /
  `nginx -t` 验证**（编写环境里没有 Docker 与 nginx），首次使用请先本地验证
- `dist/` 总体积 **7.72 MB**（104 个文件），其中 3.73 MB 是自托管的 Cesium 运行时。
  按「应用自身产物」口径是 3.97 MB，按「整个 `dist/`」口径不满足 5 MB
- 城市代码表是静态快照（**368 个代码**，只有代码没有名称），上游新增城市后需要重新抓
- 天气源只给 `HH:MM`，时间戳可能落在未来，契约里会标 `realtime: false`；
  且**只有北京可用**
- **区域统计的 `facility_categories[].members` 恒为空数组**（只给分类计数，不给成员 id）——
  所以「点某个分类，高亮该范围内的建筑」还做不到，目前只回答「范围内有多少」
