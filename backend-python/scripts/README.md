# OSM 数据抓取脚本

`fetch_osm_data.py` 从 [Overpass API](https://overpass-api.de/) 抓取 OpenStreetMap 的
建筑与道路数据，转换成 GeoJSON，写进 `backend-python/geojson/`。

仓库里那份约 5 MB 的 OSM 抽取数据**不入 git**（见 `backend-python/.gitignore` 的
`geojson/` 规则），所以全新 clone 之后需要用这个脚本把它重新抓回来。

## 特性

- **只用 Python 标准库**（`urllib` / `json` / `argparse` / `time`）。
  不需要 `requests`、`osmnx`、`geopandas`。
- **多端点 + 重试**：本机到海外 CDN 的链路慢且经常不可达，所以脚本按顺序尝试
  多个 Overpass 端点，每个端点最多重试 3 次（读超时 180 秒，失败后退避 10 秒）。
- **空结果当成失败**：HTTP 200 不等于抓到了数据。Overpass 会在 `remark` 字段里
  报告运行时错误；区域性镜像（只收录本国数据的实例）会对本项目的北京 bbox 直接
  返回 0 个元素。这两种情况都会换下一个端点继续重试，**绝不会把空结果写成
  GeoJSON 覆盖掉现有数据**。所有端点都拿不到有效数据时脚本以非 0 退出，
  现有数据集保持原样。
- **输出格式与后端兼容**：`FeatureCollection` → `features[]`，每个要素的
  `properties` 是**扁平**的 tag 字典（`building`、`height`、`building:levels`、
  `highway`、`name`、`surface` …），tag 值保持 Overpass 返回的字符串原样，
  不做数字转换。

## 抓取范围（bbox）

默认 bbox 为 `south,west,north,east`：

```
39.905,116.380,39.925,116.420
```

即北京天安门周边约 4 km × 2 km 的范围。

前端不再默认带 bbox 发请求（见 Plan 011：默认 bbox 和这份 OSM 抽取的范围完全重合，
过滤等于没过滤），只有需要看子区域时才会显式传一个 bbox 进来。

## 使用的 Overpass 查询

建筑（way + relation）：

```overpass
[out:json][timeout:180];
(
  way["building"](39.905,116.380,39.925,116.420);
  relation["building"](39.905,116.380,39.925,116.420);
);
out body geom;
```

道路：

```overpass
[out:json][timeout:180];
way["highway"](39.905,116.380,39.925,116.420);
out body geom;
```

## 依次尝试的端点

1. `https://overpass-api.de/api/interpreter`
2. `https://overpass.kumi.systems/api/interpreter`
3. `https://overpass.osm.ch/api/interpreter`

成功的那个端点会在输出里打印出来。也可以用 `--endpoint` 指定只用一个端点。

> **端点覆盖范围不一样**：区域性镜像收录的本国数据之外可能查不到东西。
> 实测（第 3 个端点）：用它查北京的 `way["highway"]` 会返回 HTTP 200 +
> 0 个元素 —— 脚本会把这种"成功但没数据"的情况当成失败，继续换下一个端点，
> 不会写出空文件。第 1、2 个是全球实例，但在部分网络下会比较慢甚至超时，
> 所以留了重试。

## 怎么跑

在 `backend-python/` 目录下：

```bash
# 默认：按顺序尝试所有端点，写到 backend-python/geojson/
./.venv/Scripts/python.exe scripts/fetch_osm_data.py

# 指定端点
./.venv/Scripts/python.exe scripts/fetch_osm_data.py \
    --endpoint https://overpass-api.de/api/interpreter

# 换范围
./.venv/Scripts/python.exe scripts/fetch_osm_data.py \
    --bbox 39.900,116.370,39.930,116.430

# 只抓一类 / 换输出目录
./.venv/Scripts/python.exe scripts/fetch_osm_data.py --only buildings
./.venv/Scripts/python.exe scripts/fetch_osm_data.py --out-dir /tmp/osm
```

### 命令行参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--endpoint URL` | 无 | 只用这一个 Overpass 端点（不给就按上面的顺序逐个试） |
| `--bbox s,w,n,e` | `39.905,116.380,39.925,116.420` | 抓取范围，顺序是 `south,west,north,east` |
| `--out-dir DIR` | `backend-python/geojson` | GeoJSON 输出目录，不存在会自动创建 |
| `--only buildings\|roads` | 两者都抓 | 只抓其中一类数据 |

## 输出

| 文件 | 内容 | 2026-10-20 实测规模 |
|---|---|---|
| `geojson/buildings.geojson` | 建筑面 | 3914 个要素（`Polygon` 3864，`MultiPolygon` 50） |
| `geojson/roads.geojson` | 道路 | 2285 个要素（`LineString` 1957，`Polygon` 328） |

> **`MultiPolygon` 为什么是 50 而不是 1**：仓库里原来那份抽取（文件时间戳
> 2026-06-21）只有 1 个 `MultiPolygon`，而现在这份有 50 个。这是 **OSM 数据本身的变化** ——
> 天安门周边这些年补了不少 `building` 关系（带内环的多边形建筑），Overpass 会把它们
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
      "geometry": { "type": "Polygon", "coordinates": [[[116.39, 39.91], ...]] },
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
