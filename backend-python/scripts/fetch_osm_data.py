#!/usr/bin/env python3
"""从 Overpass API 抓取 OSM 建筑/道路数据并转换成 GeoJSON。

设计约束：
  * 只用 Python 标准库（urllib / json / argparse / time …）。
    不引入 requests / osmnx / geopandas —— requirements.txt 后续会精简掉
    geopandas / numpy / pandas，这个脚本不能把它们又引回来。
  * 抓到的数据直接写成 backend-python/geojson/*.geojson，与仓库里已存在的
    那份 OSM 抽取结构兼容（features[].properties 是扁平 tag 字典，
    features[].id 是 "way/123" / "relation/456"）。
  * 本机到海外 CDN 的链路慢且经常不可达，所以每个端点重试 3 次，
    读超时 180 秒（与查询自带的 [timeout:180] 对齐），失败后退避 10 秒再试；
    换端点之前会打印进度。实测 roads 的 `out count` 单是计数就要 41.5 秒，
    30 秒的读超时对 roads 数据集是必然失败的。

用法：
    cd backend-python
    ./.venv/Scripts/python.exe scripts/fetch_osm_data.py
    ./.venv/Scripts/python.exe scripts/fetch_osm_data.py --only buildings
    ./.venv/Scripts/python.exe scripts/fetch_osm_data.py \
        --endpoint https://overpass-api.de/api/interpreter \
        --bbox 39.905,116.380,39.925,116.420 \
        --out-dir geojson

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
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
]

# 抓取范围：south, west, north, east = 39.905,116.380,39.925,116.420，
# 即北京天安门周边约 4 km × 2 km。前端不再默认带 bbox 请求（见 Plan 011），
# 只有需要子区域时才显式传一个进来。
DEFAULT_BBOX = (39.905, 116.380, 39.925, 116.420)

# 读取超时。查询本身声明了 [timeout:180]（服务端最多算 180 秒），
# 所以客户端的读超时必须比它大一点，否则服务端还在算的时候客户端就断了。
# 实测（2026-10-20，本机）：roads 的 `out count` 单是计数就要 41.5 秒，
# 带几何的完整查询更久 —— 30 秒的读超时对 roads 数据集是必然失败的。
HTTP_TIMEOUT = 180  # 秒
MAX_ATTEMPTS = 3  # 每个端点最多试 3 次
BACKOFF_SECONDS = 10  # 每次重试前退避 10 秒

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

def request_json(endpoint: str, query: str, timeout: int = HTTP_TIMEOUT):
    """POST 一条 Overpass 查询，返回解析后的 JSON。"""
    payload = urllib.parse.urlencode({"data": query}).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=payload,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "smart-city-fetch-osm-data/1.0 (stdlib urllib)",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
    return json.loads(raw.decode("utf-8"))


def fetch_overpass(query: str, endpoints):
    """依次尝试端点，返回 (数据, 成功的端点)。全部失败则抛 FetchError。

    HTTP 200 并不代表成功：Overpass 会在 "remark" 字段里报告运行时错误
    （查询超时等），而区域性镜像（只收录本国数据的实例）会对本项目这个
    北京 bbox 直接返回 0 个元素。两种情况都当成这次尝试失败，换下一个
    端点继续；绝不把空结果当成有效数据写出去。
    """
    failures = []
    for endpoint in endpoints:
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
                    print(
                        f"[fetch_osm_data] retrying in {BACKOFF_SECONDS}s ...",
                        file=sys.stderr,
                    )
                    time.sleep(BACKOFF_SECONDS)
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
        help="只使用这一个 Overpass 端点（默认按顺序尝试内置列表）",
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
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    bbox = parse_bbox(args.bbox)
    endpoints = [args.endpoint] if args.endpoint else list(DEFAULT_ENDPOINTS)
    out_dir = Path(args.out_dir)
    datasets = ["buildings", "roads"] if args.only is None else [args.only]

    print(f"[fetch_osm_data] bbox (south,west,north,east) = {bbox}")
    print(f"[fetch_osm_data] out-dir = {out_dir}")

    written = []
    for kind in datasets:
        query = build_query(kind, bbox)
        print(f"[fetch_osm_data] fetching {kind} ...")
        try:
            data, endpoint = fetch_overpass(query, endpoints)
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
