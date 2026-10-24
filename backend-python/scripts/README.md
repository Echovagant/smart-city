# OSM 数据抓取脚本

`fetch_osm_data.py` 从 [Overpass API](https://overpass-api.de/) 抓取 OpenStreetMap 的
建筑与道路数据，转换成 GeoJSON，写进 `backend-python/geojson/`。

仓库里那份约 5 MB 的 OSM 抽取数据**不入 git**（见 `backend-python/.gitignore` 的
`geojson/` 规则），所以全新 clone 之后需要用这个脚本把它重新抓回来。

## 特性

- **只用 Python 标准库**（`urllib` / `json` / `argparse` / `time`）。
  不需要 `requests`、`osmnx`、`geopandas`。
- **多端点 + 健康探测 + 指数退避**：本机到部分实例的链路慢且经常不可达，
  所以脚本按顺序尝试多个 Overpass 端点。**正式查询前先对每个端点做一次短超时（12 秒）
  的健康探测**：探不通就立刻换下一个，不进入重试循环 ——
  否则一个死端点会先耗掉 3 × 180 秒。探测通过的端点才进入正式查询，
  最多重试 3 次（读超时 180 秒），失败后退避 **10 → 20 → 40 秒**（上限 60 秒）。
- **端点列表可用环境变量覆盖**：`OVERPASS_ENDPOINTS`（逗号分隔的 URL 列表）。
  默认列表是若干公开实例，**本机链路不同时可以自行补充**（给了就替代默认列表；
  空值或全是非法值则回落到默认列表）。
- **空结果当成失败**：HTTP 200 不等于抓到了数据。Overpass 会在 `remark` 字段里
  报告运行时错误；只收录部分区域数据的实例会对本项目的 bbox 直接
  返回 0 个元素。这两种情况都会换下一个端点继续重试，**绝不会把空结果写成
  GeoJSON 覆盖掉现有数据**。所有端点都拿不到有效数据时脚本以非 0 退出，
  现有数据集保持原样。
- **输出格式与后端兼容**：`FeatureCollection` → `features[]`，每个要素的
  `properties` 是**扁平**的 tag 字典（`building`、`height`、`building:levels`、
  `highway`、`name`、`surface` …），tag 值保持 Overpass 返回的字符串原样，
  不做数字转换。

## 抓取范围（bbox）

取景范围**逐城不同**（密度差很多），所以按城市各存一份，用 `--city` 选：

| `--city` | 默认 bbox（south,west,north,east） | 范围 |
|---|---|---|
| `barcelona`（默认） | `41.3900,2.1580,41.4050,2.1780` | 巴塞罗那 Eixample 街区与圣家堂一带，约 1.7 km × 1.9 km |
| `milano` | `45.4590,9.1830,45.4700,9.1990` | 米兰大教堂与老城一带，约 1.2 km × 1.1 km |

`--bbox` 可以覆盖 `--city` 给的范围。

> **数据量提醒**：Eixample 一带的建筑密度约为 1500 栋/km²，**一次性查询会超时** ——
> 响应体过大时端点会回 502 或读超时。抓这一片请用 `--bbox` 切成小片分次抓，
> 再按要素 id 去重合并（跨片的要素会在相邻两片各命中一次，合并时去重即可；
> Overpass 返回的是**完整几何**、不按 bbox 裁剪，所以去重后几何是完整的那一份）。

> **别用探活判断端点死活**：实测有的实例对最轻量的探活查询都要十几秒才响应，
> 探活一失败就整批跳过 —— 等于白丢一个还能用的实例。脚本的 `--probe-timeout`
> 就是给这种情况调大窗口用的。

前端不再默认带 bbox 发请求（见 Plan 011：默认 bbox 和这份 OSM 抽取的范围完全重合，
过滤等于没过滤），只有需要看子区域时才会显式传一个 bbox 进来。

## 使用的 Overpass 查询

建筑（way + relation）：

```overpass
[out:json][timeout:180];
(
  way["building"](41.3900,2.1580,41.4050,2.1780);
  relation["building"](41.3900,2.1580,41.4050,2.1780);
);
out body geom;
```

道路：

```overpass
[out:json][timeout:180];
way["highway"](41.3900,2.1580,41.4050,2.1780);
out body geom;
```

## 依次尝试的端点

1. `https://overpass-api.de/api/interpreter`
2. `https://overpass.kumi.systems/api/interpreter`
3. `https://overpass.osm.ch/api/interpreter`

成功的那个端点会在输出里打印出来。也可以用 `--endpoint` 指定只用一个端点，
或用环境变量 `OVERPASS_ENDPOINTS` 覆盖整张列表（逗号分隔）：

```bash
# 本机链路不同时，用环境变量给出自己那份端点列表
OVERPASS_ENDPOINTS="https://a.example/api/interpreter,https://b.example/api/interpreter" \
  ./.venv/Scripts/python.exe scripts/fetch_osm_data.py
```

> **端点覆盖范围不一样**：只收录部分区域数据的实例，查别处可能什么都查不到。
> 实测（第 3 个端点）：用它查巴塞罗那的 `way["highway"]` 会返回 HTTP 200 +
> 0 个元素 —— 脚本会把这种「成功但没数据」的情况当成失败，继续换下一个端点，
> 不会写出空文件。前两个是全球实例，但在部分网络下会比较慢甚至超时，
> 所以留了重试；而**死端点由健康探测在 12 秒内排除**（正式查询的 180 秒超时只留给
> 探测通过的端点）。

## 怎么跑

在 `backend-python/` 目录下：

```bash
# 默认：按顺序尝试所有端点，写到 backend-python/geojson/<城市 id>/
./.venv/Scripts/python.exe scripts/fetch_osm_data.py

# 指定端点
./.venv/Scripts/python.exe scripts/fetch_osm_data.py \
    --endpoint https://overpass-api.de/api/interpreter

# 换范围
./.venv/Scripts/python.exe scripts/fetch_osm_data.py \
    --bbox 41.390,2.158,41.405,2.178

# 只抓一类 / 换输出目录
./.venv/Scripts/python.exe scripts/fetch_osm_data.py --only buildings
./.venv/Scripts/python.exe scripts/fetch_osm_data.py --out-dir /tmp/osm
```

### 命令行参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--endpoint URL` | 无 | 只用这一个 Overpass 端点（不给就按上面的顺序逐个试） |
| `--city barcelona\|milano` | `barcelona` | 选哪座城市的默认取景范围（`--bbox` 可覆盖） |
| `--bbox s,w,n,e` | 按 `--city` 给的范围 | 抓取范围，顺序是 `south,west,north,east` |
| `--out-dir DIR` | `backend-python/geojson` | GeoJSON 输出目录，不存在会自动创建 |
| `--only buildings\|roads` | 两者都抓 | 只抓其中一类数据 |
| `--probe-timeout SEC` | `12` | 健康探测的超时秒数。**慢实例不是死实例** —— 实测有的实例对最轻量的探活查询都要十几秒才响应，调大它，别把慢端点误判成不可达 |

环境变量：

| 变量 | 说明 |
|---|---|
| `OVERPASS_ENDPOINTS` | 覆盖端点列表（逗号分隔的 URL）；给了就替代默认列表，空值 / 全非法值回落到默认列表 |
| `OVERPASS_PROBE_TIMEOUT` | 同 `--probe-timeout`（命令行优先级更高） |

## 输出

| 文件 | 内容 | 2026-10-20 实测规模 |
|---|---|---|
| `geojson/barcelona/buildings.geojson` | 建筑面 | 4366 个要素 |
| `geojson/barcelona/roads.geojson` | 道路 | 3794 个要素（`LineString` 3717，`Polygon` 77） |

> **`MultiPolygon` 为什么是 50 而不是 1**：仓库里原来那份抽取（文件时间戳
> 2026-06-21）只有 1 个 `MultiPolygon`，而现在这份有 50 个。这是 **OSM 数据本身的变化** ——
> 这一带这些年补了不少 `building` 关系（带内环的多边形建筑），Overpass 会把它们
> 作为 relation 返回，本脚本按 `outer`/`inner` 拼成 `MultiPolygon`。不是转换出了问题：
> 要素总数（3914 vs 3854）和道路的构成（1957 / 328 vs 1955 / 305）都在同一量级。
> 拿新旧两份数据对比时别把这个差异当成 bug。

每个文件都是一个 `FeatureCollection`：

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "@id": "way/41662973", "highway": "pedestrian", "surface": "cobblestone" },
      "geometry": { "type": "Polygon", "coordinates": [[[2.17, 41.4], ...]] },
      "id": "way/41662973"
    }
  ]
}
```

几何转换规则：

- 闭合的 `way`（首尾点相同）→ `Polygon`；
- 其它 `way` → `LineString`；
- `type=multipolygon` 的 `relation` → `MultiPolygon`，成员按 `outer` / `inner`
  角色拼成环，内环按包含关系挂到对应的外环上。

文件用 `ensure_ascii=False` + `indent=2` 写出，方便 diff。

> **注意**：OSM 数据一直在变，重新抓取的结果**不会**和仓库里那一份逐字节相同，
> 要素数量也会随时间漂移。上表里的数字是量级参考，不是精确契约。

## 版权与署名

OSM 数据遵循 [ODbL](https://opendatacommons.org/licenses/odbl/1-0/) 的
"相同方式共享"要求。**任何展示这份数据的界面或文档都必须署名**
"© OpenStreetMap contributors"。
