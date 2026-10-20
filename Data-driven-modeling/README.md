# Data-driven-modeling —— 智慧城市 3D 可视化前端

基于 **Vue 3 + Vite + Cesium** 的 3D 城市浏览器，把后端提供的北京天安门一带 OSM
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
（`vite.config.js:45-57`）；目标端口读自 `backend-python/.env` 的 `PORT`，
读不到就回落 8000。所以后端端口改了不用动前端配置。

> **数据不在 git 里**：后端的 `backend-python/geojson/*.geojson`（OSM 抽取）是必需
> 的运行时输入，全新 clone 后要用 `backend-python/scripts/fetch_osm_data.py`
> 重新抓一遍。详见 `backend-python/README.md`。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发服务器，http://localhost:5173/ |
| `npm run build` | 生产构建，产物在 `dist/`（Cesium 静态资源在 `dist/Cesium/`） |
| `npm run preview` | 预览构建产物 |
| `npm run lint` | ESLint **只检查不修改**（`eslint . --no-fix`） |
| `npm run lint:fix` | ESLint 修复版（会改文件，按需使用） |
| `npm run format` | Prettier 格式化 `src/` |
| `npm test -- --run` | 单次跑完测试（5 个文件 / 30 个用例） |
| `npm run test:run` | 同上，等价写法 |
| `npm test` | ⚠️ **watch 模式**，不会自己退出；脚本里不要用 |

Node 版本要求 `^20.19.0 || >=22.12.0`（`package.json:6-8`）。

仓库根目录的 `verify.ps1`（Windows）/ `verify.sh`（POSIX）会一次跑完后端 pytest
与前端 vitest，任一失败即以非零码退出。

## 关键文件

| 文件 | 作用 |
|---|---|
| `src/components/SmartCity.vue` | 唯一的功能组件：Cesium 视图、GeoJSON 加载、交通模拟、鸟瞰↔平视切换 |
| `src/api/client.js` | 极简 fetch 封装：超时（默认 15 s）、`ApiError` 规范化 |
| `src/composables/useCityData.js` | 三个接口的调用方；`buildings`/`roads` 用 `shallowRef`（载荷是几 MB 的 GeoJSON，不能深度响应式） |
| `src/main.js` / `src/App.vue` | 引导入口；`App.vue` 只渲染 `<SmartCity />` |
| `vite.config.js` | dev 代理、`@`/`cesium` 别名、Cesium 独立 chunk、Vitest 配置 |
| `vite-plugins/cesium-assets.js` | 自定义 Vite 插件：dev 提供 `/Cesium/*`，build 拷进 `dist/Cesium/` |
| `src/router/index.js` | `createWebHistory`，**目前 routes 为空** |
| `src/stores/counter.js` | create-vue 脚手架自带的示例 store，**没有任何组件引用** |

## Cesium 静态资源

Cesium 会在运行时用 `window.CESIUM_BASE_URL` 拼出 `/Cesium/Workers/*` 这类路径。
Vite 默认不提供这些文件，所以 `vite-plugins/cesium-assets.js` 负责：

- **dev**：中间件把 `/Cesium/*` 直接映射回 `node_modules/cesium/Build/Cesium`（带正确的
  Content-Type；不能走 `server.transformRequest`，它会把 `.json` 当 ES module 转译）。
- **build**：`closeBundle` 之后把同一棵树拷进 `dist/Cesium/`（约 380 个文件）。

`vite.config.js` 里 `vite-plugin-vue-devtools` 与该插件都挂在 `mode !== 'test'` 后面：
去掉前者会让 Vitest 启动即崩，去掉后者会让插件在每次跑测试时把 Cesium 资源白拷一遍。
**不要动这两个 gate。**

另外 Cesium 是**刻意不接 ion** 的：Viewer 用 `baseLayerPicker: false`、
`geocoder: false`、`baseLayer: false` 三项关掉会触发 ion 401 的功能，底图改用高德
`UrlTemplateImageryProvider`。

## 常见问题

| 现象 | 原因 |
|---|---|
| 页面只有一个空地球 | 后端没启动，或 `backend-python/geojson/*.geojson` 缺失（后端会返回 503） |
| 面板上出现红色错误条 | 后端返回了错误；`error.message` 与 `error.status` 会显示在条上 |
| 控制台报 `Failed to load module script: text/html` | `window.CESIUM_BASE_URL` 或 Cesium 静态资源插件被改掉了 |
| `npm test` 一直不退出 | 那是 watch 模式，用 `npm test -- --run` |

## 许可与署名

底图来自高德（界面上显示 "© AutoNavi"）。建筑/道路数据来自 OpenStreetMap，
遵循 [ODbL](https://opendatacommons.org/licenses/odbl/1-0/)，
**展示这份数据时必须署名 "© OpenStreetMap contributors"**。
