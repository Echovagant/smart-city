#!/usr/bin/env python3
"""从 Overpass API 抓取 OSM 建筑/道路数据并转换成 GeoJSON。

设计约束：
  * 只用 Python 标准库（urllib / json / argparse / time …）。
    不引入 requests / osmnx / geopandas —— requirements.txt 后续会精简掉
    geopandas / numpy / pandas，这个脚本不能把它们又引回来。
  * 抓到的数据直接写成 backend-python/geojson/*.geojson，与仓库里已存在的
    那份 OSM 抽取结构兼容（features[].properties 是扁平 tag 字典，
    features[].id 是 "way/123" / "relation/456"）。
  * 本机到部分实例的链路慢且经常不可达，所以抓取分两步：
      1) 健康探测 —— 正式查询之前，先对每个端点发一次**短超时**
         （PROBE_TIMEOUT 秒）的轻量查询。探不通就立刻换下一个端点，
         **不进入重试循环**：死端点最多浪费 PROBE_TIMEOUT 秒，
         而不是 3 × HTTP_TIMEOUT 秒（实测有实例 DNS 直接解析失败）。
      2) 正式查询 —— 探测通过的端点最多试 MAX_ATTEMPTS 次，读超时
         HTTP_TIMEOUT 秒（与查询自带的 [timeout:180] 对齐），失败后退避重试。
    退避是**指数**的：BACKOFF_BASE * 2 ** (attempt - 1)，封顶 BACKOFF_MAX。
    当前参数下曲线是 10 秒 → 20 秒 → 40 秒（上限 60 秒），
    MAX_ATTEMPTS = 3 时实际用到的间隔是 10 秒与 20 秒。
    换端点之前会打印进度。实测 roads 的 `out count` 单是计数就要 41.5 秒，
    30 秒的读超时对 roads 数据集是必然失败的。
  * 端点列表默认是若干公开实例（DEFAULT_ENDPOINTS，可以自行补充）。
    本机链路不同时，用环境变量 OVERPASS_ENDPOINTS 覆盖它 —— 逗号分隔的
    URL 列表，给了就用它替代默认列表；空值或全是非法值时回落到默认列表。
    命令行 --endpoint 优先级最高（只用它给的那一个）。

用法：
    cd backend-python
    ./.venv/Scripts/python.exe scripts/fetch_osm_data.py
    ./.venv/Scripts/python.exe scripts/fetch_osm_data.py --only buildings
    ./.venv/Scripts/python.exe scripts/fetch_osm_data.py \
        --endpoint https://overpass-api.de/api/interpreter \
        --bbox 39.905,116.380,39.925,116.420 \
        --out-dir geojson
    OVERPASS_ENDPOINTS=https://a.example/api/interpreter,https://b.example/api/interpreter \
        ./.venv/Scripts/python.exe scripts/fetch_osm_data.py

输出数据的版权：OSM 数据遵循 ODbL，界面或文档里展示它时必须标注
"© OpenStreetMap contributors"。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

# ---------------------------------------------------------------- 常量

DEFAULT_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    # lz4 / z 是同一个 Overpass 实例的另外两个入口。
    # 实测（2026-10-24，本机）：主入口偶尔超时，另两个入口同一时刻可用 ——
    # 三个都留着，探活阶段换着试，比只有一个入口稳。
    "https://lz4.overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
]
# 默认列表只是若干公开实例，可以自行补充；本机链路不同时用环境变量覆盖。
# 环境变量名：逗号分隔的端点 URL 列表。给了就替代默认列表。
ENDPOINTS_ENV_VAR = "OVERPASS_ENDPOINTS"

# 抓取范围：south, west, north, east = 41.385,2.145,41.405,2.185，
# 即西班牙巴塞罗那 Eixample 街区与圣家堂一带，约 2.2 km × 3.4 km。
# 前端不再默认带 bbox 请求（见 Plan 011），只有需要子区域时才显式传一个进来。
DEFAULT_BBOX = (41.385, 2.145, 41.405, 2.185)

# 读取超时。查询本身声明了 [timeout:180]（服务端最多算 180 秒），
# 所以客户端的读超时必须比它大一点，否则服务端还在算的时候客户端就断了。
# 实测（2026-10-20，本机）：roads 的 `out count` 单是计数就要 41.5 秒，
# 带几何的完整查询更久 —— 30 秒的读超时对 roads 数据集是必然失败的。
HTTP_TIMEOUT = 180  # 秒
MAX_ATTEMPTS = 3  # 每个端点最多试 3 次

# 指数退避：第 attempt 次失败后等 BACKOFF_BASE * 2 ** (attempt - 1) 秒，
# 封顶 BACKOFF_MAX。当前参数下的曲线是 10 → 20 → 40（上限 60）秒；
# MAX_ATTEMPTS = 3 时实际用到的间隔是 10 秒与 20 秒。
BACKOFF_BASE = 10  # 秒，退避基数
BACKOFF_MAX = 60  # 秒，退避上限

# 健康探测：正式查询前的轻量检查。短超时（12 秒）+ 极小查询，
# 探不通就立刻换下一个端点，不进入重试循环。
#
# 12 秒是**默认值**，可以覆盖：慢实例（实测 overpass-api.de 的空查询偶尔要
# 十几秒才响应）会被误判成「不可达」而整批跳过 —— 那不是端点死了，
# 只是这一次的链路慢。用环境变量 OVERPASS_PROBE_TIMEOUT 或 --probe-timeout
# 调大即可；**不要把默认值调大**，默认值要保持「死端点快速排除」。
PROBE_TIMEOUT = 12  # 秒
PROBE_TIMEOUT_ENV_VAR = "OVERPASS_PROBE_TIMEOUT"
PROBE_QUERY = "[out:json];node(1);out;"  # 按 id 取单个节点，最轻量的一条查询

# 默认输出目录：<repo>/backend-python/geojson（本脚本位于 backend-python/scripts/）
DEFAULT_OUT_DIR = Path(__file__).resolve().parent.parent / "geojson"

# 坐标比较容差：Overpass 对同一个节点返回的 lat/lon 完全一致，
# 但仍留一点容差，避免浮点尾数导致闭环判断失败。
EPS = 1e-9


class FetchError(RuntimeError):
    """所有端点都失败时抛出。"""


class OverpassResponseError(RuntimeError):
    """端点返回了 HTTP 200 但内容不可用（remark / 空结果）。"""


# ---------------------------------------------------------------- 查询

def build_query(kind: str, bbox) -> str:
    """构造 Overpass QL 查询。kind 为 'buildings' 或 'roads'。"""
    south, west, north, east = bbox
    if kind == "buildings":
        return (
            "[out:json][timeout:180];\n"
            "(\n"
            f'  way["building"]({south},{west},{north},{east});\n'
            f'  relation["building"]({south},{west},{north},{east});\n'
            ");\n"
            "out body geom;\n"
        )
    if kind == "roads":
        return (
            "[out:json][timeout:180];\n"
            f'way["highway"]({south},{west},{north},{east});\n'
            "out body geom;\n"
        )
    raise ValueError(f"unknown dataset: {kind}")


# ---------------------------------------------------------------- HTTP

def _urlopen(request, timeout):
    """唯一的出网口。单独抽一层是为了让测试能用桩替换它，不碰真实网络。"""
    return urllib.request.urlopen(request, timeout=timeout)


def _user_agent() -> str:
    return "smart-city-fetch-osm-data/1.0 (stdlib urllib)"


def request_json(endpoint: str, query: str, timeout: int = HTTP_TIMEOUT):
    """POST 一条 Overpass 查询，返回解析后的 JSON。"""
    payload = urllib.parse.urlencode({"data": query}).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=payload,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": _user_agent(),
        },
        method="POST",
    )
    with _urlopen(request, timeout) as response:
        raw = response.read()
    return json.loads(raw.decode("utf-8"))


# ---------------------------------------------------------------- 退避

def backoff_delay(attempt: int) -> int:
    """第 attempt 次失败之后的退避秒数。

    指数退避：BACKOFF_BASE * 2 ** (attempt - 1)，封顶 BACKOFF_MAX。
    当前参数下曲线是 10 → 20 → 40（上限 60）秒。
    """
    if attempt < 1:
        attempt = 1
    return min(BACKOFF_BASE * (2 ** (attempt - 1)), BACKOFF_MAX)


# ---------------------------------------------------------------- 健康探测

def probe_url(endpoint: str) -> str:
    """健康探测用的 URL：GET <endpoint>?data=<极小查询>。

    用 GET 打同一个 interpreter 地址（而不是同级的 /status 之类的旁路路径），
    探测结果才真的预告「正式查询能不能走通」。
    """
    parts = urllib.parse.urlsplit(endpoint)
    query = urllib.parse.urlencode({"data": PROBE_QUERY})
    return urllib.parse.urlunsplit(
        (parts.scheme, parts.netloc, parts.path, query, parts.fragment)
    )


def probe_endpoint(endpoint: str, timeout: int = PROBE_TIMEOUT) -> bool:
    """短超时轻量探测端点是否可用。返回 True/False，不抛异常。

    探不通（DNS 失败、连接被拒、超时、非 JSON 响应）一律算不可用，
    调用方要立刻换下一个端点，不要为它进重试循环。
    """
    try:
        request = urllib.request.Request(
            probe_url(endpoint),
            headers={"User-Agent": _user_agent()},
            method="GET",
        )
        with _urlopen(request, timeout) as response:
            raw = response.read()
        json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - 网络错误种类多，统一收敛
        print(
            f"[fetch_osm_data] probe failed, skipping endpoint: "
            f"{endpoint} ({type(exc).__name__}: {exc})",
            file=sys.stderr,
        )
        return False
    return True


# ---------------------------------------------------------------- 端点列表

def _is_valid_endpoint(candidate: str) -> bool:
    """只接受 http / https 的绝对 URL。"""
    return candidate.startswith(("http://", "https://"))


def endpoints_from_env(env=None) -> list:
    """从环境变量 OVERPASS_ENDPOINTS 读端点列表。

    逗号分隔的 URL 列表。返回空列表表示「没有可用的自定义端点」，
    调用方据此回落到默认列表。非法条目（非 http/https URL）被丢掉，
    并打印一行提示 —— 不是静默吞掉。
    """
    environ = os.environ if env is None else env
    raw = environ.get(ENDPOINTS_ENV_VAR)
    if raw is None:
        return []
    candidates = [part.strip() for part in raw.split(",")]
    candidates = [part for part in candidates if part]
    valid = [part for part in candidates if _is_valid_endpoint(part)]
    for bad in (part for part in candidates if not _is_valid_endpoint(part)):
        print(
            f"[fetch_osm_data] ignoring invalid endpoint in {ENDPOINTS_ENV_VAR}: {bad!r}",
            file=sys.stderr,
        )
    return valid


def resolve_endpoints(explicit=None, env=None) -> list:
    """决定这次用哪些端点。

    优先级：命令行 --endpoint > 环境变量 OVERPASS_ENDPOINTS > 默认列表。
    环境变量为空 / 全是非法值时回落到默认列表（不是空列表 ——
    空列表会让抓取直接失败，没有退路）。
    """
    if explicit:
        return [explicit]
    from_env = endpoints_from_env(env)
    if from_env:
        return from_env
    return list(DEFAULT_ENDPOINTS)


def resolve_probe_timeout(explicit=None, env=None) -> int:
    """决定这次探活用的超时秒数。

    优先级：命令行 --probe-timeout > 环境变量 OVERPASS_PROBE_TIMEOUT > 默认值。

    环境变量里不是正整数就忽略它（回落到默认值）并打印一行提示 ——
    静默吞掉一个写错的环境变量会让人以为超时已经生效了。
    """
    if explicit is not None:
        return int(explicit)
    environ = os.environ if env is None else env
    raw = environ.get(PROBE_TIMEOUT_ENV_VAR)
    if raw is None or not str(raw).strip():
        return PROBE_TIMEOUT
    try:
        value = int(str(raw).strip())
    except ValueError:
        print(
            f"[fetch_osm_data] ignoring invalid {PROBE_TIMEOUT_ENV_VAR}: {raw!r}",
            file=sys.stderr,
        )
        return PROBE_TIMEOUT
    if value <= 0:
        print(
            f"[fetch_osm_data] ignoring non-positive {PROBE_TIMEOUT_ENV_VAR}: {raw!r}",
            file=sys.stderr,
        )
        return PROBE_TIMEOUT
    return value


def fetch_overpass(query: str, endpoints, probe_timeout: int = PROBE_TIMEOUT):
    """依次尝试端点，返回 (数据, 成功的端点)。全部失败则抛 FetchError。

    每个端点分两步：先做健康探测（短超时），探不通就立刻换下一个 ——
    **不进入重试循环**，不为死端点白等 3 × HTTP_TIMEOUT 秒。
    探测通过的端点才进入正式查询的重试循环。

    ``probe_timeout`` 让调用方按链路情况调大探活窗口（慢实例不是死实例）。

    HTTP 200 并不代表成功：Overpass 会在 "remark" 字段里报告运行时错误
    （查询超时等），而只收录部分区域数据的实例会对本项目这个 bbox
    直接返回 0 个元素。两种情况都当成这次尝试失败，换下一个
    端点继续；绝不把空结果当成有效数据写出去。
    """
    failures = []
    for endpoint in endpoints:
        if not probe_endpoint(endpoint, timeout=probe_timeout):
            failures.append(f"  {endpoint} [probe] unreachable")
            continue
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                data = request_json(endpoint, query)
                remark = data.get("remark")
                if remark:
                    raise OverpassResponseError(f"server remark: {remark}")
                if not (data.get("elements") or []):
                    raise OverpassResponseError(
                        "server returned 0 elements (this endpoint does not cover the bbox)"
                    )
            except Exception as exc:  # noqa: BLE001 - 网络错误种类多，统一记录
                reason = f"{type(exc).__name__}: {exc}"
                failures.append(f"  {endpoint} [attempt {attempt}/{MAX_ATTEMPTS}] {reason}")
                print(
                    f"[fetch_osm_data] {endpoint} attempt {attempt}/{MAX_ATTEMPTS} failed: {reason}",
                    file=sys.stderr,
                )
                if attempt < MAX_ATTEMPTS:
                    delay = backoff_delay(attempt)
                    print(
                        f"[fetch_osm_data] retrying in {delay}s ...",
                        file=sys.stderr,
                    )
                    time.sleep(delay)
                continue
            print(f"[fetch_osm_data] using endpoint: {endpoint}")
            return data, endpoint
    raise FetchError(
        "all Overpass endpoints failed:\n" + "\n".join(failures)
    )


# ---------------------------------------------------------------- 几何转换

def _same_point(a, b) -> bool:
    return abs(a[0] - b[0]) <= EPS and abs(a[1] - b[1]) <= EPS


def _points_of(geometry):
    """Overpass geometry: [{"lat":..,"lon":..}, ...] -> [[lon, lat], ...]"""
    points = []
    for node in geometry or []:
        if "lat" in node and "lon" in node:
            points.append([float(node["lon"]), float(node["lat"])])
    return points


def _close_ring(points):
    """确保环闭合（首尾相同）。"""
    if points and not _same_point(points[0], points[-1]):
        points = points + [list(points[0])]
    return points


def _stitch_rings(ways):
    """把若干条 way 的点串拼成若干条闭合环。

    Overpass 的 relation 成员常常把一条完整边界拆成多段 way，
    相邻两段共享端点，这里按共享端点把它们接起来。
    """
    rings = []
    current = []
    for points in ways:
        if not points:
            continue
        if not current:
            current = list(points)
            continue
        tail = current[-1]
        head = points[0]
        if _same_point(tail, head):
            current.extend(points[1:])
        elif _same_point(tail, points[-1]):
            current.extend(reversed(points[:-1]))
        else:
            # 接不上：先收一条环，另起一条。
            if len(current) > 2:
                rings.append(_close_ring(current))
            current = list(points)
    if len(current) > 2:
        rings.append(_close_ring(current))
    return rings


def _point_in_ring(point, ring) -> bool:
    """射线法判断点是否落在环内（ring 为 [[lon, lat], ...]）。"""
    x, y = point
    inside = False
    count = len(ring)
    j = count - 1
    for i in range(count):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y):
            x_cross = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < x_cross:
                inside = not inside
        j = i
    return inside


def _feature(element, geometry):
    """组装一个 GeoJSON Feature。

    properties 是扁平的 tag 字典（和仓库里已有数据一致），额外带一个
    '@id'；tag 值保持 Overpass 返回的字符串原样，不做数字转换。
    """
    tags = element.get("tags") or {}
    properties = {str(key): str(value) for key, value in tags.items()}
    osm_id = f"{element['type']}/{element['id']}"
    properties["@id"] = osm_id
    return {
        "type": "Feature",
        "properties": properties,
        "geometry": geometry,
        "id": osm_id,
    }


def way_to_feature(element):
    """way -> 闭环 Polygon，否则 LineString。"""
    points = _points_of(element.get("geometry"))
    if len(points) < 2:
        return None
    if _same_point(points[0], points[-1]):
        ring = _close_ring(points)
        return _feature(element, {"type": "Polygon", "coordinates": [ring]})
    return _feature(element, {"type": "LineString", "coordinates": points})


def relation_to_feature(element):
    """type=multipolygon 的 relation -> MultiPolygon。"""
    tags = element.get("tags") or {}
    if tags.get("type") != "multipolygon":
        return None
    members = element.get("members") or []
    outer_ways = []
    inner_ways = []
    for member in members:
        geometry = member.get("geometry")
        if not geometry:
            continue
        points = _points_of(geometry)
        if len(points) < 2:
            continue
        if member.get("role") == "inner":
            inner_ways.append(points)
        elif member.get("role") == "outer":
            outer_ways.append(points)
    if not outer_ways:
        return None
    outer_rings = _stitch_rings(outer_ways)
    inner_rings = _stitch_rings(inner_ways)
    polygons = []
    for outer in outer_rings:
        rings = [outer]
        for inner in inner_rings:
            if _point_in_ring(inner[0], outer):
                rings.append(inner)
        polygons.append(rings)
    if not polygons:
        return None
    return _feature(element, {"type": "MultiPolygon", "coordinates": polygons})


def to_features(elements):
    """Overpass elements -> GeoJSON features 列表。"""
    features = []
    for element in elements or []:
        element_type = element.get("type")
        if element_type == "way":
            feature = way_to_feature(element)
        elif element_type == "relation":
            feature = relation_to_feature(element)
        else:
            feature = None
        if feature is not None:
            features.append(feature)
    return features


def to_feature_collection(features):
    return {"type": "FeatureCollection", "features": features}


def write_geojson(path: Path, feature_collection) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(feature_collection, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


# ---------------------------------------------------------------- CLI

def parse_bbox(text: str):
    parts = [part.strip() for part in text.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError(
            f"--bbox expects south,west,north,east, got {text!r}"
        )
    try:
        south, west, north, east = (float(part) for part in parts)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"--bbox has non-numeric values: {text!r}") from exc
    if south >= north or west >= east:
        raise argparse.ArgumentTypeError(f"--bbox is not a valid box: {text!r}")
    return (south, west, north, east)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Fetch OSM buildings/roads from Overpass and write GeoJSON.",
    )
    parser.add_argument(
        "--endpoint",
        default=None,
        help="只使用这一个 Overpass 端点（优先级最高；不给就用环境变量 %s 或内置列表）"
        % ENDPOINTS_ENV_VAR,
    )
    parser.add_argument(
        "--bbox",
        default=",".join(str(value) for value in DEFAULT_BBOX),
        help="south,west,north,east（默认 %(default)s）",
    )
    parser.add_argument(
        "--out-dir",
        default=str(DEFAULT_OUT_DIR),
        help="输出目录（默认 %(default)s）",
    )
    parser.add_argument(
        "--only",
        choices=["buildings", "roads"],
        default=None,
        help="只抓取其中一类数据",
    )
    parser.add_argument(
        "--probe-timeout",
        type=int,
        default=None,
        help="健康探测的超时秒数（默认 %d；也可用环境变量 %s）。"
        "慢实例不是死实例 —— 调大它，别把慢端点误判成不可达。"
        % (PROBE_TIMEOUT, PROBE_TIMEOUT_ENV_VAR),
    )
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    bbox = parse_bbox(args.bbox)
    endpoints = resolve_endpoints(args.endpoint)
    probe_timeout = resolve_probe_timeout(args.probe_timeout)
    out_dir = Path(args.out_dir)
    datasets = ["buildings", "roads"] if args.only is None else [args.only]

    print(f"[fetch_osm_data] bbox (south,west,north,east) = {bbox}")
    print(f"[fetch_osm_data] out-dir = {out_dir}")
    print(f"[fetch_osm_data] probe timeout = {probe_timeout}s")
    print(f"[fetch_osm_data] endpoints ({len(endpoints)}):")
    for endpoint in endpoints:
        print(f"[fetch_osm_data]   - {endpoint}")

    written = []
    for kind in datasets:
        query = build_query(kind, bbox)
        print(f"[fetch_osm_data] fetching {kind} ...")
        try:
            data, endpoint = fetch_overpass(query, endpoints, probe_timeout=probe_timeout)
        except FetchError as exc:
            print(f"[fetch_osm_data] ERROR: {exc}", file=sys.stderr)
            print(
                "[fetch_osm_data] no GeoJSON written for this dataset; "
                "the existing dataset is left untouched.",
                file=sys.stderr,
            )
            return 1

        elements = data.get("elements") or []
        features = to_features(elements)
        collection = to_feature_collection(features)
        target = out_dir / f"{kind}.geojson"
        write_geojson(target, collection)

        breakdown = Counter(feature["geometry"]["type"] for feature in features)
        written.append(target)
        print(f"[fetch_osm_data] {kind}: endpoint={endpoint}")
        print(f"[fetch_osm_data] {kind}: {len(features)} features -> {target}")
        for geometry_type, count in sorted(breakdown.items()):
            print(f"[fetch_osm_data] {kind}:   {geometry_type} = {count}")

    for target in written:
        print(f"[fetch_osm_data] wrote {target} ({os.path.getsize(target)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
