# Data-driven-modeling —— 智慧城市 3D 可视化前端

基于 **Vue 3 + Vite + Cesium + TypeScript（严格模式）** 的 3D 城市浏览器，把后端提供的北京天安门一带 OSM
建筑/道路 GeoJSON 渲染成可拉伸的三维建筑与分级道路，并附带一个可开关的交通模拟。

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
| `npm run build` | 生产构建，产物在 `dist/`（Cesium 静态资源在 `dist/Cesium/`，剪枝后实测 **98 个文件**；`dist/` 共 104 个文件、7.67 MB）；**默认不产 sourcemap**，要排障用 `SOURCEMAP=true npm run build` |
| `npm run preview` | 预览构建产物 |
| `npm run lint` | ESLint **只检查不修改**（`eslint . --no-fix`） |
| `npm run lint:fix` | ESLint 修复版（会改文件，按需使用） |
| `npm run typecheck` | `vue-tsc --noEmit` 类型检查（CI 里是**阻塞门禁**） |
| `npm run format` | Prettier 格式化 `src/` |
| `npm test -- --run` | 单次跑完测试（5 个文件 / **40 个用例**，全部是 `.ts`） |
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
> 了，看着漂亮、实际统计的是子集。当前全口径：语句 **92.61%**、函数 **90.24%**、分支 **81.86%**。

## 关键文件

| 文件 | 作用 |
|---|---|
| `src/components/SmartCity.vue` | 唯一的功能组件：Cesium 视图、GeoJSON 加载、交通模拟、实时交通读数、鸟瞰↔平视切换（`<script setup lang="ts">`） |
| `src/api/client.ts` | 极简 fetch 封装：超时（默认 15 s）、`ApiError` 规范化；请求结束时会摘掉挂在调用方 signal 上的 abort 监听器 |
| `src/composables/useCityData.ts` | 三个接口的调用方；`buildings`/`roads` 用 `shallowRef`（载荷是几 MB 的 GeoJSON，不能深度响应式）；另有只刷新交通状态一个端点的 `refreshTrafficStatus()` |
| `src/main.ts` / `src/App.vue` | 引导入口；`App.vue` 只渲染 `<SmartCity />` |
| `types/city.ts` | 城市类型系统（345 行）：GeoJSON 泛型子集、`OSMProperties`、三个端点的响应契约、视图状态，以及**补 Cesium 类型缺口**的 `Writable*` 与模块增强 |
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

控制面板上有一行**实时交通读数**（`src/components/SmartCity.vue:16`）：

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

实测（`dist/` 共 104 个文件 / **7.67 MB**，Plan C1 剪枝后重测）：

| 口径 | 体积 | 文件数 | 说明 |
|---|---|---|---|
| **Vite 产物（应用自身）** | **3.92 MB** | 5 | `index.html`、`favicon.ico`、`assets/cesium-*.js`、`assets/index-*.js`、`assets/index-*.css`；**已达计划书的 < 5 MB** |
| **自托管 Cesium 运行时** | 3.75 MB | 99 | `dist/Cesium/`：98 个运行时文件 + 1 个 `pruned-manifest.json` 排查报告；厂商运行时，不是应用产物；由 `vite-plugins/cesium-assets.js` 拷贝后**按剪枝清单裁剪** |
| `dist/` 合计 | **7.67 MB** | 104 | 计划书写的是 < 5 MB —— **按「整个 `dist/`」口径不达标，按「应用自身产物」口径达标** |

剪枝前是 10.49 MB / 385 个文件（Cesium 运行时 6.57 MB / 380 个文件）；
**剪掉 282 个文件、2,979,559 字节**。

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
`geocoder: false`、`baseLayer: false` 三项关掉会触发 ion 401 的功能，底图改用高德
`UrlTemplateImageryProvider`。

### Cesium 运行时的剪枝（Plan C1）

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

- **实际加载集 = 65 个文件**（Assets 10 / Widgets 9 / **Workers 46**）。
  这个数取的是**两个口径的并集**：
  1. **CDP `Network.*` 事件**（能看到 worker 内部的请求，但 Chrome 的网络日志有条数上限，
     高德瓦片会把早期的 Cesium 请求挤掉）；
  2. **页面内 `performance.getEntriesByType('resource')`**（没有条数上限，但看不到 worker
     target 内部的 chunk 导入）。
  只用其中一个都会漏。
- 抓 worker 请求**必须**发 `Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart:
  true, flatten: true })`，并对**每个 attach 进来的 worker target** 单独 `Network.enable`
  —— 否则 worker 的请求一个都抓不到。
- **判定必须在全部 10 个交互动作跑完之后做** —— 首屏只加载 42 个，跑完交互才 65 个。
  多出来的包括 6 张 SkyBox 贴图、`IAU2006_XYS_18.json`、`ion-credit.png`、
  `moonSmall.jpg` 与 9 个 NavigationHelp 的 `.svg`。
- **「本次没被请求」≠「运行时用不到」**：一次相机交互就能把某个「从未请求」的文件翻转成
  「已请求」。所以剪枝的判据是「静态不可达 ∪（静态可达 ∧ 属于已论证的组 ∧ 实测未加载 ∧
  回归通过）」。
- 剪枝后的实际加载集与剪枝前**逐文件相同**（65 个，一个不多一个不少），
  282 个被剪文件**零命中**，**零 404**。

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

**本轮实测**（3 轮取中位数，16 核 i7-13620H，测量期整机 CPU 非空闲 69%–73%）：

| 指标 | 验收线 | 实测 | 判定 |
|---|---|---|---|
| 首屏（LargestContentfulPaint） | < 3 s | **0.78 s**（三轮 0.74 / 0.78 / 0.83） | 达标 |
| 页面 load 事件 | < 3 s | **0.91 s** | 达标 |
| 应用就绪（数据到位 → 城市入场景） | 参考 | **1.77 s** | 参考 |
| 帧率（静止） | ≥ 30 fps | **89.0 fps** | 达标 |
| 帧率（相机运动） | ≥ 30 fps | **163.1 fps** | 达标 |
| 首屏传输量（线上，不含高德瓦片） | 参考 | 2.53 MB | 参考 |
| 首屏解码后体积（不含高德瓦片） | 参考 | 12.37 MB | 参考 |
| 高德瓦片（外部网络） | 参考 | 77 个 / 累计 9.1–31.6 s | 参考 |

**读这些数字之前必须知道三个口径坑**：

1. **WebGL 画布不是 LCP 的候选元素** —— Chrome 的 Largest Contentful Paint 在本应用里
   命中的是控制面板的 `<div>`，量的是页面文字块，**不是「3D 城市画出来了」**。
   要看城市真的出现，看「应用就绪」那一行。
2. **首屏里混着浏览器冷启动** —— 全新 Chrome 实例的**第一个**导航要几百毫秒到好几秒
   才拿到首字节（本机实测 0.31 s ~ 2.49 s，极差 2.2 s），同一实例里的后续导航只要
   几毫秒。不拆开的话量到的是「浏览器冷启动 + 页面加载」的混合体，在共享机器上
   **根本不可复跑**。脚本因此先访问一次同源的 `/health` 把浏览器拉起来，冷启动延迟
   单独记在「冷启动」一行（浏览器缓存全程禁用，**产品资源仍然是第一次下载**）。
3. **headless Chrome 没有 vsync**，帧源不受显示器刷新率锁，所以 163 fps 是
   「渲染器每秒能产出多少帧」，不是「屏幕上每秒显示多少帧」。

另外**外部依赖要单独摘出来**：高德瓦片每轮 77 个，累计等待 9.1–31.6 s，占首屏全部
请求耗时的 46%–72%，但**不阻塞首屏**（首屏绘制 0.74 s 发生在瓦片回来之前）。
把「高德 CDN 慢」说成「前端首屏慢」是错的。

## CI

`.github/workflows/verify.yml` 在 push 到 `main`、PR 或手动触发时跑前端这套：
`npm ci` → `npm run lint` → `npm run typecheck` → `npm run build` → 断言 `dist/Cesium`
的文件数是 **98** → 断言**剪枝清单与产物一致**。Windows 与 Ubuntu 两个 job 各跑一遍；
测试部分复用仓库根的 `verify.ps1` / `verify.sh`。

- `npm ci` 走 `https://registry.npmmirror.com`（`package-lock.json` 已与 `package.json` 同步）。
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
| 控制台报 `Failed to load module script: text/html` | `window.CESIUM_BASE_URL` 或 Cesium 静态资源插件被改掉了 |
| `npm test` 一直不退出 | 那是 watch 模式，用 `npm test -- --run` |

## 许可与署名

底图来自高德（界面上显示 "© AutoNavi"）。建筑/道路数据来自 OpenStreetMap，
遵循 [ODbL](https://opendatacommons.org/licenses/odbl/1-0/)，
**展示这份数据时必须署名 "© OpenStreetMap contributors"**——控制面板里已经常驻这一行
（`src/components/SmartCity.vue:19`），**不要删掉它**。
