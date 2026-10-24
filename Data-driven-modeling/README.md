# Data-driven-modeling —— 智慧城市 3D 可视化前端

基于 **Vue 3 + Vite + Cesium + TypeScript（严格模式）** 的 3D 城市浏览器，把后端提供的巴塞罗那
Eixample 街区与圣家堂一带的 OSM 建筑/道路 GeoJSON 渲染成可拉伸的三维建筑与分级道路，
并附带一个可开关的交通模拟。

界面是**深色 3D 数据可视化大屏**：纯色深底 + 发光网格 + 深色发光建筑 + 分级辉光路网 + 流动光效 +
缓慢环绕的相机，外加一套 **16:9 大屏骨架**（顶栏 + 左列 + 中心场景 + 右列 + 底栏）。
**底座完全自绘，不接任何瓦片服务，也不需要任何地图 key。**
**图表全部是手写 SVG，不引任何图表库**（`package.json` 至今零改动）。

## 前置条件

**后端必须同时在跑**，否则前端只会看到一个空地球加一条错误横幅。

```bash
# 终端 1 —— 后端（仓库的 backend-python/ 目录下）
cd backend-python
./.venv/Scripts/python.exe main.py      # http://127.0.0.1:8000

# 终端 2 —— 前端（本目录）
npm install
npm run dev                             # http://localhost:5173/
```

前端的请求走的是相对路径 `/api/...`，由 Vite 开发代理转发到后端
（`vite.config.js:50-57`）；目标端口读自 `backend-python/.env` 的 `PORT`，
读不到就回落 8000。所以后端端口改了不用动前端配置。

生产部署时前端产物在 `dist/`，由后端进程（`backend-python/main.py` 的
`mount_frontend`）或 nginx 托管；开发时用 `npm run dev`，
`/api` 走 Vite 代理转到 `127.0.0.1:8000`。

> **数据不在 git 里**：后端的 `backend-python/geojson/*.geojson`（OSM 抽取）是必需
> 的运行时输入，全新 clone 后要用 `backend-python/scripts/fetch_osm_data.py`
> 重新抓一遍。详见 `backend-python/README.md`。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发服务器，http://localhost:5173/ |
| `npm run build` | 生产构建，产物在 `dist/`（Cesium 静态资源在 `dist/Cesium/`，剪枝后实测 **98 个文件**；`dist/` 共 104 个文件、7.72 MB）；**默认不产 sourcemap**，要排障用 `SOURCEMAP=true npm run build` |
| `npm run preview` | 预览构建产物 |
| `npm run lint` | ESLint **只检查不修改**（`eslint . --no-fix`） |
| `npm run lint:fix` | ESLint 修复版（会改文件，按需使用） |
| `npm run typecheck` | `vue-tsc --noEmit` 类型检查（CI 里是**阻塞门禁**） |
| `npm run format` | Prettier 格式化 `src/` |
| `npm test -- --run` | 单次跑完测试（20 个文件 / **279 个用例**，全部是 `.ts`） |
| `npm run test:run` | 同上，等价写法 |
| `npm run test:coverage` | 跑测试并出覆盖率报告（v8 provider）；报告默认落在 `coverage/`（已 gitignore），要放到仓库外设 `COVERAGE_DIR` |
| `npm test` | ⚠️ **watch 模式**，不会自己退出；脚本里不要用 |

Node 版本要求 `^20.19.0 || >=22.12.0`（`package.json:6-8`）。

**依赖版本**：运行时 cesium ^1.134.1、pinia ^3.0.3、vue ^3.5.44、vue-router ^4.6.3；
开发期 vite ^7.1.11（实装 7.3.7）、vitest ^2.1.0（实装 2.1.9）、@vitest/coverage-v8 ^2.1.9、
eslint ^9.37.0、@vue/test-utils ^2.4.6、jsdom ^25.0.0、typescript ^5.9.3（实装 5.9.3）、
vue-tsc ^3.3.13（实装 3.3.13）、typescript-eslint ^8.72.0（实装 8.72.0）。

仓库根目录的 `verify.ps1`（Windows）/ `verify.sh`（POSIX）会一次跑完后端 pytest
与前端 vitest，任一失败即以非零码退出。

### `lint` 与 `typecheck` 各管一半

| 命令 | 管什么 | 当前状态 |
|---|---|---|
| `npm run lint` | 风格与静态规则（ESLint，**不带类型信息**） | 0 problem |
| `npm run typecheck` | 类型（`vue-tsc --noEmit`，`tsconfig.json` 是 `strict: true`） | 0 error |

**类型错误不会让 `npm run build` 失败** —— Vite 用 esbuild 转译、不查类型 ——
所以 `typecheck` 是独立且阻塞的一步，CI 里两个 job 都跑它。两者**不重复**：类型归
`vue-tsc`，风格归 ESLint。

> 覆盖率 `include` 写在 `vite.config.js` 里（`src/**/*.{js,ts,vue}`），**迁到 TypeScript
> 之后要记得复查它** —— 原先只写了 `.{js,vue}`，源码全迁成 `.ts` 之后报告里就只剩 `.vue`
> 了，看着漂亮、实际统计的是子集。当前全口径：语句 **98.03%**、函数 **96.44%**、分支 **89.6%**
> （含 `src/theme/dark.ts` 与 `src/theme/dashboard.ts`）。
>
> 分支率的尾数会轻微浮动：`src/theme/dark.ts` 里 `flowDashLength()` 的那个三元分支
> （`phase < 0.5 ? … : …`）按 `performance.now()` 取相位，测到哪一边取决于测试跑的那一刻，
> 所以那一行有时覆盖到、有时没覆盖到。语句与函数两项是稳定的。

## 关键文件

| 文件 | 作用 |
|---|---|
| `src/components/SmartCity.vue` | **装配层**：把场景 composable、数据轮询与大屏骨架接起来（Cesium 逻辑已全部下沉到 `src/composables/`） |
| `src/components/DashboardOverlay.vue` | **16:9 大屏骨架**：CSS Grid（顶栏 / 左列 / 中心场景 / 右列 / 底栏），面板浮在场景之上；overlay 容器 `pointer-events: none`，只有面板 `auto`；把「点了一条事件」抛给上层；区域统计要用的场景底座由 `stage` prop **显式传进来** |
| `src/components/dashboard/` | 大屏面板与图表（**纯 SVG，无图表库**）：`TopBar.vue` / `PanelCard.vue` / `MetricCard.vue` / `LineChart.vue` / `DonutChart.vue` / `BarChart.vue` / `EventStream.vue` / `TrendPanel.vue` / `AreaStats.vue` |
| `src/composables/useSceneStage.ts` | **场景底座**：Cesium 初始化、深色场景、发光网格、建筑与道路装配、批量描边。**共享可变状态只有这一份**（`viewer` / 场景级批量图元的引用与材质 / 视图状态） |
| `src/composables/useCameraRig.ts` | 相机：鸟瞰↔平视、环绕自转、交互打断与恢复、相机飞行。自转状态只有这一份，其余通过 `camera.flyTo()` 请求飞行 |
| `src/composables/useTrafficFleet.ts` | 交通：车辆与路灯（全部用 Cesium 图元画，不引用任何 `.glb` 模型） |
| `src/composables/useEventMarkers.ts` | 事件标记：告警光柱 / 体量圆柱 / 脉冲环的创建与清理，点事件飞过去 |
| `src/composables/useSceneLinkageEffect.ts` | 页签联动在场景里的**副作用**：高亮焦点建筑、压暗其余、提亮流动光效层 |
| `src/composables/useDashboardData.ts` | 页签 → 图表数据的**纯函数** `resolveTabView(tab, overview)`：不碰 Vue 响应式，好测；取不到的指标输出 `value: null` + `unavailable` |
| `src/composables/useDashboardState.ts` | 页签状态（**模块级单例**）：`activeTabKey` / `setTab`，大屏与场景共用同一份 |
| `src/composables/useEventStream.ts` | 事件流的**纯函数**辅助：`dedupeEvents()`（按 id 去重）、`formatEventTime()`（本地 HH:MM）、`resolveEventLocation()`（**落点解析**：全市级 → 城心，几何锚定 → 真实坐标）、`explainEmptyEvents()`（**空态解释**：为什么没有事件） |
| `src/composables/useSceneLinkage.ts` | 页签 → 场景联动的**纯函数**：`resolveSceneLinkage()` / `resolveFocusBuildingIds()`（焦点建筑来自**后端** `facilities[].members`）。它与 `useSceneLinkageEffect.ts` 是两回事：一个是纯计算，一个是这些计算的副作用 |
| `src/theme/dashboard.ts` | 大屏**设计 token**（尺寸与排版：圆角 / 描边 / 内边距 / 列宽 / 行高 / 字号阶梯 / 间距）+ 图表色序 `CHART_COLORS`（只从 `DARK_PALETTE` 取）；颜色本身仍在 `dark.ts` |
| `src/theme/dark.ts` | **深色大屏的色板与材质工厂**（`DARK_PALETTE` / `ROAD_COLORS` / 辉光材质 / 流动虚线材质 / 拥堵分档色 / CSS 变量注入）——视觉的唯一事实来源 |
| `src/api/client.ts` | 极简 fetch 封装：超时（默认 15 s）、`ApiError` 规范化；请求结束时会摘掉挂在调用方 signal 上的 abort 监听器 |
| `src/composables/useCityData.ts` | 四个接口的调用方；`buildings`/`roads` 用 `shallowRef`（载荷是几 MB 的 GeoJSON，不能深度响应式）；另有只刷新交通状态一个端点的 `refreshTrafficStatus()` 与只刷新城市指标一个端点的 `loadCityOverview()` / `refreshCityOverview()` |
| `src/main.ts` / `src/App.vue` | 引导入口；`App.vue` 只渲染 `<SmartCity />` |
| `types/city.ts` | 城市类型系统（711 行）：GeoJSON 泛型子集、`OSMProperties`、四个端点的响应契约、**设施分类**、**大屏页签与图表数据**、视图状态，以及**补 Cesium 类型缺口**的 `Writable*` 与模块增强 |
| `tsconfig.json` | TypeScript 严格模式配置（22 行）：`strict: true`、`noEmit: true`，`paths` 里的别名必须与 `vite.config.js` 一致 |
| `src/env.d.ts` | `import.meta.env` 的类型（`/// <reference types="vite/client" />`） |
| `vite.config.js` | dev 代理、`@`/`cesium` 别名、Cesium 独立 chunk、Vitest 配置；`build.sourcemap` 由 `SOURCEMAP` 环境变量控制、默认关 |
| `vite-plugins/cesium-assets.js` | 自定义 Vite 插件：dev 提供 `/Cesium/*`，build 拷进 `dist/Cesium/` 并按剪枝清单裁剪 |
| `vite-plugins/cesium-prune.mjs` | Cesium 运行时静态可达性分析器（4 种加载机制 + worker import 闭包）；也是重新生成剪枝清单的 CLI |
| `cesium-runtime-manifest.json` | **入库**的剪枝清单：剪掉什么、留下什么、各自的理由 |
| `src/router/index.ts` | `createWebHistory`，**目前 routes 为空** |

> **别名的两处必须一致**：`vite.config.js` 的 `resolve.alias`（`@` → `./src`、
> `cesium` → `./node_modules/cesium`）与 `tsconfig.json` 的 `paths` 是同一条规则的
> 两份拷贝。**只改一边**，IDE / `vue-tsc` 与实际构建就会对不上 —— 症状是
> 「类型检查说模块不存在，构建却能跑」。新增别名时两边一起改。

> **`types/city.ts` 里的 Cesium 补法是我们自己写的**：Cesium 1.134 的 `.d.ts` 与运行时
> 有出入（实例属性只声明了 `Property` 一侧、`Scene.maximumFrameRate` / `Fog.near` /
> `Fog.far` / `Viewer.ConstructorOptions.errorHandler` 都没声明），`types/city.ts` 用
> `Writable*` 类型 + `declare module 'cesium'` / `declare global` 补上了。
> **将来升级 Cesium 时必须复查这里** —— 升级之后这些补法会变成冗余，而不是错误。

## 控制面板的实时交通状态

控制面板上有一行**实时交通读数**（`src/components/SmartCity.vue:45`）：

```
实时交通 · 流量 71% · 拥堵 · 更新于 13:08:10
```

- 数据来自后端 `GET /api/traffic-status`（**不挂 API key**，前端不携带 key 也能取到）。
- 首次随 `loadAll()` 一起取，之后**每 5 秒轮询一次**（`TRAFFIC_POLL_INTERVAL_MS`）。
  轮询在 `onMounted` 里挂上、`onUnmounted` 里清掉，组件卸载后不再发请求。
- 轮询失败时**保留上一次的读数**，不把「数据加载失败」横幅拉起来。
- 任何字段缺失时**整段略过**，界面上不会出现 `undefined` / `NaN`；没有读数时那一行
  根本不渲染。
- 后端的值由时间**确定性地推导**（三个周期互不成整数倍的正弦分量叠加，不用随机量），
  所以面板上的数字会随时间变化，但同一时刻永远是同一个值。

> 这是「便宜的起步」：**没有 WebSocket**。后端给的是按时间推出来的合成读数，
> 不是真实采集的车流数据；真正的实时流 + 模拟器是另一笔预算。

## 控制面板的城市运行指标带

指标带（`.metric-strip`）是大屏左列里那条**常驻的实时读数带**
（大屏的 6 张指标卡也带来源标注，见「16:9 大屏骨架」一节）：

```
空气质量 51 良      气温 18℃      路网负载 63.5（模型估算）
中国环境监测总站·12:00:00  中国天气网·17:05  本地OSM路网数据·路网总长202.173km
```

三格分别来自三个数据源（后端 `GET /api/city/overview`，**不挂 API key**）：

| 指标 | 来源 | 凭据 | 实时性 | 降级 |
|---|---|---|---|---|
| 空气质量（AQI + 分级 + 六项污染物） | Open-Meteo 空气质量（CAMS 模型再分析） | 免凭据 | 小时级；**模型再分析值**，不是站点实测 | 取不到 → 「数据源暂不可用」 |
| 气温 / 湿度 | Open-Meteo 天气预报 | 免凭据 | 小时级；**数值模式预报**，不是站点实测 | 取不到 → 「数据源暂不可用」 |
| 路网负载（模型估算） | 本地 OSM GeoJSON 自己算 | 无 | 静态快照 | 读不到文件 → 「数据源暂不可用」 |

- **每个指标都带来源标注**：来源名 + 观测时间（小字），悬停出完整信息
  （取数地址、观测时间、取数时间）。
- **模型估算项标「（模型估算）」**：两个远程源都是模式数据（数值预报 / CAMS 再分析），
  路网负载是静态几何折算的**供给紧张度**（建筑数 ÷ 路网总长，再除以参考阈值归一到 0–100），
  **不是**实测路况。
- **取不到的源显示「数据源暂不可用」**，不显示 0、不显示上一次的旧值，
  连分级徽标一起不显示（没取到数据就不知道分级）。
- 首次取数走 `loadCityOverview()`，**不 await**（要走外部上游，最多 5 秒，
  绝不能拖慢 3D 场景装配）；之后**每 60 秒轮询一次**
  （`CITY_OVERVIEW_POLL_INTERVAL_MS`，空气质量是小时级数据）。
- 轮询失败时保留上一次的读数；**它失败不会拉起「数据加载失败」横幅** ——
  3D 城市本身还是好的，不该被一个外部源拖下水。

> 契约在 `types/city.ts`（`SourceInfo` / `Metric` / `Series` / `CityOverview`），
> 后端实现在 `backend-python/city_data/`。**每个 metric 都必须带 source** ——
> 改契约要同时改两边（没有共享 schema 文件）。

## 趋势面板：24 小时与逐日

左列的趋势卡是**趋势面板**（`src/components/dashboard/TrendPanel.vue`），
支持两个视图：

| 视图 | 数据来源 | 回答什么问题 |
|---|---|---|
| **24 小时** | 后端序列 `aqi_24h`（逐小时 AQI） | 今天怎么样 |
| **日** | 后端序列 `aqi_daily`（14 天逐日 AQI + 六项污染物日均值） | 比昨天如何，这几天趋势如何 |

日视图里可切换 **7 个指标**：AQI / PM2.5 / PM10 / O3 / NO2 / SO2 / CO。
污染物键与后端逐日序列的 `values` 键**完全一致**（也与逐小时污染物的指标 key 一致），
前端只把键翻译成能显示的名字，**不重新实现任何分类规则**。

- 折线一律用现成的 `LineChart.vue` 画 —— **它一个字没改**：
  「`v` 为 null 就断线、没有数据就显示诚实的空态」由它自己处理。
- 时间**自己拼**（`getMonth()` / `getDate()` / `getHours()`），
  **不用 `toLocaleTimeString`** —— 后者受运行环境的 ICU 数据影响，输出格式不保证一致。
- **取不到就是空态**：逐日序列缺失时显示诚实的空态文案，
  不画一条假的平线，也不拿 24 小时的数据顶替。
- 面板标题随视图走（「24 小时趋势」/「逐日趋势」），来源标注也是**各视图各的**。

趋势面板在左列，**5 个页签下都在**（每页的左列布局一样）。

## 区域统计：在场景里点一下地面

右列第一块是**区域统计**（`AreaStats.vue` 面板 + `useAreaQuery.ts` 取数与拾取）：

```
在场景里点一下地面 → 命中点的经纬度 → 以它为中心取一个固定半径的矩形范围
                  → GET /api/city/area?bbox=… → 面板出数
```

| 项 | 说明 |
|---|---|
| 半径 | 200 / 300 / 500 m 三档可切，切换即按新半径重查 |
| 面板内容 | 范围面积 / 建筑数 / 路网总长 / 建筑密度，另有道路分级与设施分类的分解 |
| 数据来源 | 后端 `GET /api/city/area`（本地 OSM 快照），面板底部标来源名与观测时间 |

**不抢相机**：只往画布上挂**一个 `LEFT_CLICK` 监听**，一行相机代码都没写。
Cesium 的 `ScreenSpaceEventHandler` 只在「按下与抬起之间没有位移」时才算一次点击 ——
拖拽仍然是拖拽（相机照旧旋转、滚轮照旧缩放），拖完松手也不会误触发一次查询。

**场景底座必须显式传下来**：`SmartCity.vue` 用 `:stage="stage"` 把 `useSceneStage()` 的返回值
交给大屏，**不翻组件实例**。生产构建必然启用 `inlineTemplate`（setup 直接返回渲染函数），
`<script setup>` 的顶层绑定不会挂到 `setupState` 上 —— 从实例上取绑定在 dev 能用、
在生产取不到，dev 与生产会变成两套行为。

底座里的 `viewer` 引用要用 `toRaw` 取：底座若经过**深响应式代理**，
Vue 会**解包 ref**，`stage.viewer` 拿回来是 `null` 而不是那个 `Ref` ——
拿它去 `watch` 只会得到一句「Invalid watch source」警告，监听根本装不上，
表现为「点地面没反应」且没有任何报错。

## 派生事件流与场景联动

右列的「实时事件流」里的每一条，都是后端从**真实指标派生**出来的
（`GET /api/city/overview` 的 `events`）：

```
● 空气质量由优转为良   城心（全市指标）   提示   11:00
```

> **这个项目没有告警系统、没有摄像头、没有工单系统。**
> 事件全部是从真实指标推导出来的（规则见后端 `city_data/events.py`），
> **派生不出来就是空数组** —— 空事件流是数据现实，不是故障。
> 空态会把「检查了哪些条件、为什么没触发」写清楚，例如
> 「当前无触发事件 —— 最近 24 小时 AQI 等级未变化（当前「良」）；路网负载 63.5 低于阈值 80」。

事件的三条硬约定：

- **每条都带来源**：来源名、观测时间、`metric_key`、发生时间都在事件里（悬停可见）；
- **id 稳定**：同一条事件重复派生时 id 不变 —— 前端按 id 去重，60 秒一次的轮询不会重复插入；
- **模型估算派生的标「（模型估算）」**：目前只有路网负载这一类。

### 事件落在哪里：`location_kind` 说了算

事件分两类，**由后端给的 `location_kind` 区分**（前端不靠猜）：

| `location_kind` | 是哪类事件 | 落点 | 位置标签 |
|---|---|---|---|
| `city` | **全市级**（空气质量、天气） | **城心**（天安门 = `cityConfig.center` = 相机的绕行中心） | 城心（全市指标） |
| `geometry` | **几何锚定**（路网负载） | **真实几何**上的点：最长主干道的弧长中点 | 主路段（OSM way/175277980） |

- **全市级指标本来就没有空间位置**，画在城心是准确的；
  而且城心正是相机盯着的那一点，所以默认鸟瞰视角下标记**永远在屏幕中心**
  （实测屏幕坐标 **(744, 403)**，画布 1578×802）。
- **几何锚定事件保持真实坐标** —— 真实道路的弧长中点比「城心」有信息量。
  它离城心约 2.9 km，所以默认视角下不一定在屏内（相机转到那一侧就会看到）；
  点它则由相机直接飞过去，飞行后标记落在屏幕中心。

> **「城心」全项目只有一个**：天安门（`cityConfig.center`）。
> 后端那个「数据范围中心」（OSM 抽取范围的围盒中心）比城心偏北约 1.1 km，
> **不是城心** —— 拿它放标记的话，默认鸟瞰视角下标记会落到屏幕之外
> （2026-10-22 复核时实测 y=1198，画布高 802）。

### 场景里怎么标事件

| 图元 | 做法 | 为什么 |
|---|---|---|
| **垂直光柱** | 300 m 高的竖直 polyline + 底下半径 40 m 的半透明圆柱 | 自己建的 `Primitive`（`asynchronous: false`）—— 实体的非贴地 polyline 会去请求被剪枝掉的 Cesium worker，404 会让整个页面停摆 |
| **告警脉冲环** | 贴地（`clampToGround: true`）的 dynamic polyline，半径 20 → 260 m 扩张并淡出，周期 2.4 s | 贴地的 dynamic polyline 走 `GroundPolylinePrimitive`（主线程建几何），不碰被剪掉的 worker。**`clampToGround` 是硬要求** |
| **点事件 → 定位** | 点事件流里的一行 → 相机飞到事件点正南 800 m、高 800 m、俯角 45°，1.2 s | 飞行期间暂停自转，飞行后从相机当前位置反算轨道状态（不硬拽回去） |

场景里最多画 **8** 个标记，其中前 **3** 个带脉冲环（多了帧率会掉）。
组件卸载时全部清掉 —— 重新挂载不叠加。

### 页签切换 → 场景联动

| 页签 | 场景动作 |
|---|---|
| 区域概览 | 无联动（全部正常显示） |
| 空气质量 | 不联动（全市指标，没有空间定位），面板里写一句说明 |
| 公共安全 | 高亮 `public_safety` + `medical` 分类的建筑，**其余压暗** |
| 城市文旅 | 高亮 `heritage` 分类的建筑，其余压暗 |
| 路网运行 | 不压暗建筑；把流动光效层的颜色提亮 |

- **焦点建筑集合来自后端** `facilities[].members`（建筑的 OSM id），前端**按 id 匹配**，
  **不重新实现 OSM 分类规则**（规则只写在后端 `city_data/sources/facilities.py`）。
- **压暗 / 提亮只改一个材质 uniform**（`material.uniforms.color`）：Cesium 的
  `Material._uniforms[name]` 是每帧求值的取值函数，所以换掉它下一帧就生效 ——
  不重建几何、不换 appearance。
- **绝不逐个改 3854 个建筑的 `polygon.material`**：那会打散 Cesium 的批处理 → 全量几何重建 → 卡死。
- **切页签不移动相机**：用户没点事件，就不许乱飞。切回「区域概览」必须完全恢复。

实测（2026-10-22，生产构建 + 真实 Chrome）：5 个页签的切换耗时
**26.3 / 35.8 / 46.1 / 44.2 / 24.1 ms**（验收线 < 300 ms），有脉冲环时帧率
**61.6 fps**（验收线 ≥ 30 fps），页面**没有** "Rendering has stopped."。
默认鸟瞰视角下，全市级事件标记的屏幕坐标实测 **(744, 403)**（画布 1578×802）——
落在屏幕中心。

## 16:9 大屏骨架

`DashboardOverlay.vue` 把面板摆成 **16:9** 的一屏：

```
┌──────────── 顶栏：标题 + 5 个页签 ────────────┬── 右侧读数带 ──┐
│ 左列：核心指标(6)   │                     │ 右列：区域统计 │
│        趋势面板      │   中心 3D 场景      │  分类分布     │
│                    │                     │  实时事件流   │
├────────────────────── 通栏底栏：城市资源概览（横向条形）+ 控制按钮/署名 ─┤
```

- **面板浮在场景之上**，Cesium 容器保持全屏，中心那一格留空，3D 城市从面板后面
  透出来 —— 所以 Cesium 逻辑一行都不用改。
- **`pointer-events` 分两层**：overlay 容器 `none`、面板 `auto`。
  不这样的话中心的 Cesium 交互（拖拽 / 滚轮）会被 overlay 整块吃掉。
- **网格**（`.dashboard-grid`）：
  `"top top top" / "left scene right" / "bottom bottom bottom"`，
  列宽 340 px、顶栏 96 px、**通栏底栏 160 px** —— 数字在 `src/theme/dashboard.ts` 里，
  由 `applyDashboardVariables()` 写进 CSS 自定义属性，样式表只写 `var(--dc-*)`。
- **三个插槽**：`top-extra`（顶栏右侧读数带）、`bottom-right`（底栏右侧控制区），
  左列是组件自己的两卡。
- **窄屏（< 1280 px）降级**：两列收窄、间距缩小、指标卡改成一列；
  overlay 是 `inset: 0` + `overflow: hidden`，**不出现横向滚动条**。
- **DOM 契约不许破**：`.control-panel`（4 个按钮）、`.traffic-status`、
  `.metric-strip`、OSM 署名行都还在 —— **只换位置，不删内容**：
  - 指标带 + 实时交通读数 → **顶栏右侧**（一条紧凑的横向读数带）；
  - 4 个控制按钮 + OSM 署名 → **通栏底栏右侧**；
  - 左列于是只剩「核心指标」+「趋势面板」两块（风格板线框的「左列两卡」）。

### 5 个页签：换的是「看哪一组指标」，不是换图表类型

| 页签 | 核心指标卡（6 个） | 分类分布（环形） | 趋势（折线） | 底栏条形 |
|---|---|---|---|---|
| 区域概览 | 建筑总数 / 道路总数 / 路网总长 / 覆盖面积 / 道路分级合计 / 设施分类总数 | 道路等级分布 | AQI 24h / 逐日趋势 | 设施分类计数 |
| 空气质量 | 首要污染物 / PM2.5 / PM10 / O3 / NO2 / SO2 | 污染物浓度 | AQI 24h / 逐日趋势 | 6 项污染物浓度 |
| 公共安全 | 医疗 / 公共安全 / 教育 / 历史建筑 / 商业与办公 / 设施分类总数 | 设施分类 | AQI 24h / 逐日趋势 | 设施分类计数 |
| 城市文旅 | 历史建筑 / 设施分类总数 / 建筑总数 / 道路总数 / 路网总长 / 覆盖面积 | 设施分类 | AQI 24h / 逐日趋势 | 设施分类计数 |
| 路网运行 | 路网总长 / 覆盖面积 / 道路分级合计 / 主干道 / 支路 / 道路总数 | 道路等级分布 | AQI 24h / 逐日趋势 | 道路分级条数 |

- 每个数字都来自 `GET /api/city/overview` 的**真实字段**（按 `key` 取，不按 label 匹配）。
- **卡片里不重复顶栏读数带的三个数**（空气质量 / 气温 / 路网负载）——
  同一个数字在大屏上出现两次就是信息噪音，所以那三个指标只出现在顶栏读数带上
  （路网负载的「（模型估算）」标记也在那儿）。
- **页签状态是模块级单例**（`useDashboardState.ts`）：大屏与 3D 场景共用同一份
  `activeTabKey`，阶段 3 的「页签联动场景」就靠它。
- **数据模型层是纯函数**（`useDashboardData.ts` 的 `resolveTabView(tab, overview)`）：
  输入输出都是普通数据，不碰 Vue 响应式 —— 所以「切页签 → 卡片内容跟着变」
  这类断言不需要 mount 组件。
- **取不到的数据不许填 0**：`value: null` + `unavailable: true`，
  组件显示「数据源暂不可用」；`source.estimated === true` 显示「（模型估算）」；
  `source.realtime === false` 显示「（非实时）」。
- **环形图要能对上账**：分类互斥（一个建筑只归一类），圆心是**各段之和**。
  道路分级环形只统计线要素（1955 条），与「道路总数」（2260，含广场地面）不是同一个数，
  所以圆心标题写「道路分级合计」而不是「道路总数」。

### 图表全是手写 SVG

| 组件 | 画什么 | 关键约定 |
|---|---|---|
| `MetricCard.vue` | 标签 / 数值 / 分级徽标 / 来源小字 | `value` 为 null → 「数据源暂不可用」；来源小字带 `title`（完整来源信息） |
| `LineChart.vue` | 折线 | `v` 为 null 的点**断线**（不补 0）；空数据 → 诚实的空态 |
| `DonutChart.vue` | 环形（`stroke-dasharray`）+ 图例 | 圆心是**各段之和**；配色取自 `CHART_COLORS`（蓝青 6 档序列色） |
| `BarChart.vue` | 横向条形 | `value` 为 null → 画成空槽并标「暂无」 |
| `EventStream.vue` | 事件流 | 渲染**派生**事件（时间 · 标题 · 位置标签 · 严重度徽标），点一行抛 `select`；没有事件 → **说明性空态**（为什么没触发），不编条目 |
| `TrendPanel.vue` | 趋势面板 | 24 小时 / 日两个视图 + 日视图下 7 个指标切换；折线复用 `LineChart.vue`（不改它）；时间自己拼，不用 `toLocaleTimeString`；取不到 → 空态 |

**分类图表里一档橙红都没有**：普通分类（人行道 / 历史建筑 / 商业与办公）**不是告警**，
画成橙色会被读成一条告警 —— 那是语义级错误。所以 `CHART_COLORS` 只取
`DARK_PALETTE.chartSeries`（蓝青系 6 档），**橙色只做预警、红色只做告警**，
它们留给 severity：拥堵徽标、事件流的严重度、S3 的告警脉冲环。

**没有图表库**：`package.json` 与 `package-lock.json` 零改动，
`dist/` 相对上一版只多了 **30.4 KB**（8,057,583 → 8,088,665 字节）。

## 生产构建与 sourcemap

`npm run build` **默认不产出 sourcemap**（`vite.config.js` 里 `build.sourcemap`
由环境变量 `SOURCEMAP` 控制）。理由有两个：`.map` 让 Vite 自己的构建产物从
3.9 MB 涨到 20.5 MB（多出来的 16.6 MB 全是 `.map`），而且它把全部原始源码
原样发布出去。

需要线上排障时临时打开：

```bash
SOURCEMAP=true npm run build
```

> **PowerShell**：`$env:SOURCEMAP = 'true'; npm run build`（用完记得清掉环境变量）。

数字来源：`cd Data-driven-modeling && npm run build` 前后各量一次
`Get-ChildItem dist\assets -Recurse -File | Measure-Object Length -Sum`
（改前 20.5 MB / 改后 3.9 MB）与
`Get-ChildItem dist -Recurse -File -Filter *.map | Measure-Object`
（改前 2 个 / 改后 0 个）。

### `dist/` 的体积口径

实测（`dist/` 共 104 个文件 / **7.72 MB**）：

| 口径 | 体积 | 文件数 | 说明 |
|---|---|---|---|
| **Vite 产物（应用自身）** | **3.97 MB** | 5 | `index.html`、`favicon.ico`、`assets/cesium-*.js`、`assets/index-*.js`、`assets/index-*.css`；**< 5 MB** |
| **自托管 Cesium 运行时** | 3.75 MB | 99 | `dist/Cesium/`：98 个运行时文件 + 1 个 `pruned-manifest.json` 排查报告；厂商运行时，不是应用产物；由 `vite-plugins/cesium-assets.js` 拷贝后**按剪枝清单裁剪** |
| `dist/` 合计 | **7.72 MB** | 104 | **按「整个 `dist/`」口径不满足 5 MB，按「应用自身产物」口径满足** |

剪枝前是 10.49 MB / 385 个文件（Cesium 运行时 6.57 MB / 380 个文件）；
**剪掉 282 个文件、2,979,559 字节**。事件标记与页签联动**没引任何依赖**
（脉冲环与光柱都是 Cesium 现有图元）。

说「产物体积」时要分清是**应用产物**还是**整个 `dist/`**。`assets/cesium-*.js`
一个文件就占 3,973,988 字节（gzip 后约 1.07 MB 线上），是首屏最大的一块。

## Cesium 静态资源

Cesium 会在运行时用 `window.CESIUM_BASE_URL` 拼出 `/Cesium/Workers/*` 这类路径。
Vite 默认不提供这些文件，所以 `vite-plugins/cesium-assets.js` 负责：

- **dev**：中间件把 `/Cesium/*` 直接映射回 `node_modules/cesium/Build/Cesium`（带正确的
  Content-Type；不能走 `server.transformRequest`，它会把 `.json` 当 ES module 转译）。
- **build**：`closeBundle` 之后把同一棵树拷进 `dist/Cesium/`，**再按剪枝清单裁掉本应用
  用不到的部分**（380 → 98 个文件）。

`vite.config.js` 里 `vite-plugin-vue-devtools` 与该插件都挂在 `mode !== 'test'` 后面：
去掉前者会让 Vitest 启动即崩，去掉后者会让插件在每次跑测试时把 Cesium 资源白拷一遍。
**不要动这两个 gate。**

另外 Cesium 是**刻意不接 ion** 的：Viewer 用 `baseLayerPicker: false`、
`geocoder: false`、`baseLayer: false` 三项关掉会触发 ion 401 的功能。
**`baseLayer: false` 不能去掉** —— 去掉它 Cesium 会自己走 `fromWorldImagery()` → ion 401。
底座是自绘的纯色地面 + 发光网格，不接任何瓦片服务。

**Cesium 默认控件也全关了**：`homeButton: false` / `sceneModePicker: false` /
`navigationHelpButton: false` / `navigationInstructionsInitiallyVisible: false` ——
浅色圆角按钮与浅灰说明板在纯黑大屏上就是破功。副作用：实际加载集从 64 降到 **55**
（9 个 `NavigationHelp/*.svg` 不再请求；它们在剪枝清单的 kept 集合里，清单与 `dist/Cesium` 不受影响）。

### Cesium 运行时的剪枝

`dist/Cesium/` 里有一大半文件本应用**永远用不到**（maki 地点图标、NaturalEarthII 的
TMS 瓦片、3D Tiles 的 Draco/KTX2 解码器、几十个用不到的 worker 与各 widget 的独立 CSS）。
裁掉它们，`dist/` 从 10.49 MB 降到 **7.67 MB**。

| 东西 | 位置 | 说明 |
|---|---|---|
| 分析器 | `vite-plugins/cesium-prune.mjs` | Cesium 运行时的 4 种加载机制（路径字面量 / 模板串 / 目录字面量 / worker 裸名 + import 闭包）的静态可达性分析；也是 CLI |
| 剪枝清单 | `cesium-runtime-manifest.json` | **入库**、可 review、可 diff；每条都带「为什么被剪 / 为什么被留」 |
| 剪枝动作 | `vite-plugins/cesium-assets.js` 的 `closeBundle` | 先整棵拷贝，再按清单删；产物里写一份 `dist/Cesium/pruned-manifest.json` 排查报告 |
| 回归验证 | 仓库根 `scripts/verify-cesium-runtime.mjs` | 10 个交互动作 + 零 404 + 被剪文件零命中 |
| 清单自检 | 仓库根 `scripts/check-cesium-runtime-manifest.mjs` | 「产物 == 清单的 kept 集合」，CI 里跑 |

**逃生舱**：环境变量 `CESIUM_RUNTIME=full` → 一个都不剪，`dist/Cesium` 保持完整的
380 个文件（实测 6,890,404 字节）。要临时开某个 Cesium 特性时用它。

```powershell
# 临时要完整运行时
$env:CESIUM_RUNTIME = 'full'; npm run build
```

**清单不会自己跟上 Cesium 版本**。升级 Cesium 或改了应用功能之后，重新生成一次：

```bash
cd Data-driven-modeling
node vite-plugins/cesium-prune.mjs --write
```

构建时插件会自检「产物 == 清单的 kept 集合」，对不上**直接让构建失败** ——
比默默多出一个文件强。CI 里还有一条同样的检查。

### 实际被请求了哪些 Cesium 文件

真实 headless Chrome 实测（生产构建 + 后端单端口托管，跑完 10 个交互动作后，
2026-10-21）：

- **实际加载集 = 55 个文件**（Assets 10 / **Widgets 0** / Workers 45）。
  这个数取的是**两个口径的并集**：
  1. **CDP `Network.*` 事件**（能看到 worker 内部的请求，但 Chrome 的网络日志有条数上限，
     外部请求会把早期的 Cesium 请求挤掉）；
  2. **页面内 `performance.getEntriesByType('resource')`**（没有条数上限，但看不到 worker
     target 内部的 chunk 导入）。
  只用其中一个都会漏。
- 抓 worker 请求**必须**发 `Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart:
  true, flatten: true })`，并对**每个 attach 进来的 worker target** 单独 `Network.enable`
  —— 否则 worker 的请求一个都抓不到。
- **判定必须在全部 10 个交互动作跑完之后做** —— 首屏只加载 42 个，跑完交互才 65 个。
  多出来的包括 6 张 SkyBox 贴图、`IAU2006_XYS_18.json`、`ion-credit.png`、
  `moonSmall.jpg` 与 9 个 NavigationHelp 的 `.svg`。
  —— **Widgets 是 0**：Cesium 默认控件（home / 地球 / ? 与 NavigationHelp 说明板）
  全关了，那 9 个 SVG 不再被请求（它们**在剪枝清单的 kept 集合里**，清单与 `dist/Cesium` 不受影响）。
- **「本次没被请求」≠「运行时用不到」**：一次相机交互就能把某个「从未请求」的文件翻转成
  「已请求」。所以剪枝的判据是「静态不可达 ∪（静态可达 ∧ 属于已论证的组 ∧ 实测未加载 ∧
  回归通过）」。
- **被剪掉的 worker 要特别小心**：Cesium 的「非贴地实体 polyline」静态路径会建一个
  `asynchronous: true` 的 `Primitive`，它需要 `Workers/createPolylineGeometry.js` ——
  那个文件在剪枝清单里，**一旦用到就是 404，渲染循环直接停摆**。
  所以本项目**不使用非贴地的实体 polyline**（流动光效那条线自己用 `Primitive` 画，
  `asynchronous: false`，不需要任何 worker）。

## 浏览器端度量

仓库根有一个**只用 Node 内置能力**的脚本（不新增任何依赖），量的是**生产构建 +
真实浏览器**（不是 dev server）：

```bash
# 一条命令：构建（缺产物时）→ 起后端 → 3 轮独立测量 → 打印对照表 + 写 JSON
node scripts\measure-browser-performance.mjs

# 常用开关
node scripts\measure-browser-performance.mjs --runs 1 --sample-seconds 2
node scripts\measure-browser-performance.mjs --no-build --port 8045 --cdp-port 9350
```

产物在 `.acceptance/`（已 gitignore）：`browser-performance.json`（全部原始数据）、
`screenshots/run-N-before-motion.png` / `-after-motion.png`（运动取证）、
`server-logs/`（后端与 Chrome 的日志）。退出码：测出数据 → 0；测不出数据（找不到
Chrome / 构建失败 / 后端起不来）→ 1，**不产出假数字**。

**实测**（2026-10-22，16 核 i7-13620H，3 轮；**测量期间整机 CPU 非空闲 ≥ 60%**，
共享开发机上帧率数字会被显著压低）：

| 指标 | 验收线 | 实测（3 轮） | 判定 |
|---|---|---|---|
| 首屏（LargestContentfulPaint） | < 3 s | **0.98 s**（0.98 / 0.98 / 5.14，第三轮是宿主机争用） | 达标 |
| 页面 load 事件 | < 3 s | **1.33 s**（1.28 / 1.33 / 5.17） | 达标 |
| 应用就绪（数据到位 → 城市入场景） | 参考 | **1.78 s**（1.76 / 1.78 / 13.29） | 参考 |
| 帧率（静止 / 相机运动） | ≥ 30 fps | 静止 38.5 / 76.9 / 0.5、运动 154.0 / 0.4 / 0.4 —— **宿主机争用下不具参考性** | 见下 |
| 首屏传输量（线上字节） | 参考 | **2.54 MB**（解码后 12.4 MB） | 参考 |
| **首屏外部请求** | 0 | **0 个 / 0 ms**（三轮都是 0） | 达标 |

> **帧率这一行在共享开发机上不可直接引用**：三轮静止帧率在 0.5 ~ 76.9 之间跳，
> 运动帧率在 0.3 ~ 154 之间跳，而同一份代码的外部请求数三轮恒为 0、首屏传输量
> 三轮只差 30 KB。**别把机器忙当成产品慢** —— 权威数字要在空载机器上复跑。
> 脚本会同时记录测量期的整机 CPU 占用，≥ 60% 时会给出警告。


**读这些数字之前必须知道三个口径坑**：

1. **WebGL 画布不是 LCP 的候选元素** —— Chrome 的 Largest Contentful Paint 在本应用里
   命中的是控制面板的 `<div>`，量的是页面文字块，**不是「3D 城市画出来了」**。
   要看城市真的出现，看「应用就绪」那一行。
2. **首屏里混着浏览器冷启动** —— 全新 Chrome 实例的**第一个**导航要几百毫秒到好几秒
   才拿到首字节（本机实测 0.31 s ~ 2.49 s，极差 2.2 s），同一实例里的后续导航只要
   几毫秒。不拆开的话量到的是「浏览器冷启动 + 页面加载」的混合体，在共享机器上
   **根本不可复跑**。脚本因此先访问一次同源的 `/health` 把浏览器拉起来，冷启动延迟
   单独记在「冷启动」一行（浏览器缓存全程禁用，**产品资源仍然是第一次下载**）。
3. **headless Chrome 没有 vsync**，帧源不受显示器刷新率锁，所以 162 fps 是
   「渲染器每秒能产出多少帧」，不是「屏幕上每秒显示多少帧」。

另外**「静止」那一行现在其实是「慢速环绕」**：相机默认缓慢自转（0.02 rad/s），
采样期间不派发鼠标事件，但相机自己在动。

## CI

`.github/workflows/verify.yml` 在 push 到 `main`、PR 或手动触发时跑前端这套：
`npm ci` → `npm run lint` → `npm run typecheck` → `npm run build` → 断言 `dist/Cesium`
的文件数是 **98** → 断言**剪枝清单与产物一致**。Windows 与 Ubuntu 两个 job 各跑一遍；
测试部分复用仓库根的 `verify.ps1` / `verify.sh`。

- `npm ci` 用默认 registry（`package-lock.json` 已与 `package.json` 同步）。
- `dist/Cesium` 断言的是**精确的 98**（不含构建时写的 `pruned-manifest.json` 报告），
  不是「大于 0」——它能在 CI 上第一时间发现 `vite-plugins/cesium-assets.js` 的输出路径被改坏。
- 「剪枝清单与产物一致」那条检查跑的是 `node scripts/check-cesium-runtime-manifest.mjs`：
  清单是入库的，Cesium 升级或应用功能变了都可能让它过期，这条检查就是那个哨兵。
- 跑测试用的是 `npm test -- --run` / `npm run test:run`，**不要用 `npm test`**（watch 模式）。
- **`npm run typecheck` 是阻塞门禁**：类型错误不会让 `npm run build` 失败（Vite 用
  esbuild 转译、不查类型），所以类型检查必须是独立的一步。
- Ubuntu job 另有两步「**报告，不阻塞**」（`continue-on-error: true`）：**浏览器端度量**
  与**验收度量**。它们证明脚本在干净环境里跑得通，但 runner 的 CPU / 网络与本机不同，
  **数字不可与本机直接比较**；权威数字来自本地跑。
- **仓库已经推送到 GitHub**（`origin` = `https://github.com/Echovagant/smart-city.git`），
  这份工作流**会真正运行**：push 到 `main`、提 PR 或手动触发都会触发上面那两个 job。

## 常见问题

| 现象 | 原因 |
|---|---|
| 页面只有一个空地球 | 后端没启动，或 `backend-python/geojson/*.geojson` 缺失（后端会返回 503） |
| 面板上出现红色错误条 | 后端返回了错误；`error.message` 与 `error.status` 会显示在条上 |
| 面板上没有「实时交通」那一行 | 后端还没起来，或交通状态请求失败（轮询失败会保留上一次读数；完全没读数时这一行不渲染） |
| 中心的 3D 场景拖不动 / 滚轮没反应 | overlay 容器被写成了 `pointer-events: auto` —— 容器必须是 `none`，只有面板是 `auto` |
| 大屏上某几格写着「数据源暂不可用」 | 那个源没取到（上游挂了 / 本地 geojson 读不到）。**这是设计**：不拿 0 或旧值冒充 |
| 控制台报 `Failed to load module script: text/html` | `window.CESIUM_BASE_URL` 或 Cesium 静态资源插件被改掉了 |
| 页面报 "An error occurred while rendering" | 用了**非贴地的实体 polyline** → Cesium 要 `Workers/createPolylineGeometry.js`，那个文件被剪枝清单剪掉了 → 404。用 `Primitive`（`asynchronous: false`）代替 |
| `npm test` 一直不退出 | 那是 watch 模式，用 `npm test -- --run` |

## 许可与署名

底座是自绘的（没有瓦片服务，也就没有瓦片服务商的署名）。建筑/道路数据来自 OpenStreetMap，
遵循 [ODbL](https://opendatacommons.org/licenses/odbl/1-0/)，
**展示这份数据时必须署名 "© OpenStreetMap contributors"**——控制面板里已经常驻这一行
（`src/components/SmartCity.vue` 的 `.attribution`），**不要删掉它**。

> **GCJ-02 偏移**：底座若换成 GCJ-02 坐标系的商业瓦片，而数据仍用 OSM 的 WGS-84 原始坐标，
> 在中心城区一带会差 **东 533 m / 北 156 m**（合成 556 m）。
> 现在底座自绘，路与楼用的都是 OSM 原始坐标，**天然同坐标系，不需要任何转换**。
> **如果将来有人把 GCJ-02 坐标系的瓦片加回底座，这个偏移会立刻回来**，
> 而且不会报错——只是整体错开，看起来像「数据没对齐」。

