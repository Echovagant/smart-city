import json
import logging
import math
import os
from typing import Dict, List, Any, Optional, Tuple
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
from shapely.errors import ShapelyError

logger = logging.getLogger(__name__)


def _iter_positions(coordinates: Any):
    """递归产出 GeoJSON 坐标数组里的所有位置（[lon, lat] 或 [lon, lat, alt]）。

    坐标嵌套的层数由几何类型决定（Point 1 层、LineString 2 层、Polygon 3 层……），
    这里不区分类型，而是靠「当前位置是不是数字」自底向上识别。
    读不懂的结构不产出任何位置，调用方据此放弃提前判定。
    """
    if not isinstance(coordinates, (list, tuple)):
        return
    if len(coordinates) >= 2 and all(
        isinstance(value, (int, float)) and not isinstance(value, bool)
        for value in coordinates[:2]
    ):
        yield coordinates
        return
    for item in coordinates:
        yield from _iter_positions(item)


def _bounds_overlap(
    bounds: Tuple[float, float, float, float],
    min_lon: float,
    min_lat: float,
    max_lon: float,
    max_lat: float,
) -> bool:
    """要素自身的范围与 bbox 是否可能相交。

    用闭区间比较：边界相接也算相交，与 shapely 的 intersects 语义一致。
    """
    b_min_lon, b_min_lat, b_max_lon, b_max_lat = bounds
    if b_max_lon < min_lon or b_min_lon > max_lon:
        return False
    if b_max_lat < min_lat or b_min_lat > max_lat:
        return False
    return True


class DataProcessorError(Exception):
    """DataProcessor 操作失败时抛出的领域异常。

    捕获自文件系统、JSON 解析或 Shapely 几何操作的具体错误，
    包装为统一的领域错误，便于上层（如 FastAPI 处理器）做统一映射。
    """


class DataProcessor:
    """数据处理器，用于处理GeoJSON和城市数据"""
    
    def __init__(self, data_dir: str):
        self.data_dir = data_dir
    
    def load_geojson(self, file_path: str) -> Dict[str, Any]:
        """加载GeoJSON文件。

        成功时返回解析后的 dict；失败时抛出 DataProcessorError，
        原始异常链保留在 __cause__ 中。
        """
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except FileNotFoundError as e:
            logger.error("GeoJSON 文件不存在: %s", file_path)
            raise DataProcessorError(f"GeoJSON 文件不存在: {file_path}") from e
        except PermissionError as e:
            logger.error("GeoJSON 文件无读取权限: %s", file_path)
            raise DataProcessorError(f"GeoJSON 文件无读取权限: {file_path}") from e
        except json.JSONDecodeError as e:
            logger.error("GeoJSON 文件不是合法 JSON: %s (line %s col %s)", file_path, e.lineno, e.colno)
            raise DataProcessorError(f"GeoJSON 文件不是合法 JSON: {file_path}") from e
        except OSError as e:
            # 捕获其他 OS 层错误（磁盘错误、路径过长等）。
            logger.exception("加载 GeoJSON 时发生 OS 错误: %s", file_path)
            raise DataProcessorError(f"加载 GeoJSON 时发生 OS 错误: {file_path}") from e
    
    def save_geojson(self, data: Dict[str, Any], file_path: str) -> bool:
        """保存GeoJSON文件。

        成功时返回 True；失败时抛出 DataProcessorError。
        """
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            return True
        except PermissionError as e:
            logger.error("GeoJSON 文件无写入权限: %s", file_path)
            raise DataProcessorError(f"GeoJSON 文件无写入权限: {file_path}") from e
        except OSError as e:
            logger.exception("保存 GeoJSON 时发生 OS 错误: %s", file_path)
            raise DataProcessorError(f"保存 GeoJSON 时发生 OS 错误: {file_path}") from e
        except (TypeError, ValueError) as e:
            # data 不是 JSON 可序列化对象。
            logger.exception("GeoJSON 数据不可序列化: %s", file_path)
            raise DataProcessorError(f"GeoJSON 数据不可序列化: {file_path}") from e
    
    def _geometry_bounds(self, geometry: Any) -> Optional[Tuple[float, float, float, float]]:
        """从原始 GeoJSON 坐标里算出要素自身的范围 (min_lon, min_lat, max_lon, max_lat)。

        支持 Point / LineString / MultiPoint / MultiLineString / Polygon / MultiPolygon
        等带 'coordinates' 的几何（靠递归识别位置，不按类型写死）。
        读不出合法坐标时返回 None，意思是「无法提前判定」，
        调用方必须回退到完整的 shapely 解析路径。
        """
        if not isinstance(geometry, dict):
            return None
        coordinates = geometry.get('coordinates')
        if coordinates is None:
            return None

        min_lon = min_lat = math.inf
        max_lon = max_lat = -math.inf
        found = False
        for position in _iter_positions(coordinates):
            if len(position) < 2:
                return None
            lon = position[0]
            lat = position[1]
            if not (math.isfinite(lon) and math.isfinite(lat)):
                return None
            min_lon = min(min_lon, lon)
            max_lon = max(max_lon, lon)
            min_lat = min(min_lat, lat)
            max_lat = max(max_lat, lat)
            found = True

        if not found:
            return None
        return (min_lon, min_lat, max_lon, max_lat)

    def filter_features_by_bbox(self, geojson: Dict[str, Any], bbox: List[float]) -> Dict[str, Any]:
        """根据边界框过滤GeoJSON要素

        单个要素的几何损坏时抛出 DataProcessorError（而不是 KeyError/TypeError/GEOSException），
        便于上层把它映射成 503（数据问题），而不是 500。

        性能上做了两件事：
        1. bbox 多边形只构造一次（它与循环无关）；
        2. 先用原始坐标算一次要素自身的范围，范围与 bbox 不相交的几何
           不可能被 intersects 命中，可以跳过昂贵的 shapely 解析。
        """
        min_lon, min_lat, max_lon, max_lat = bbox
        # bbox 多边形必须在 try 之外构造：否则多边形本身的构造失败
        # 会被误报成「第 N 个要素的几何数据非法」。
        try:
            bbox_poly = shape({
                'type': 'Polygon',
                'coordinates': [[
                    [min_lon, min_lat],
                    [max_lon, min_lat],
                    [max_lon, max_lat],
                    [min_lon, max_lat],
                    [min_lon, min_lat]
                ]]
            })
        except (ShapelyError, TypeError, ValueError) as e:
            logger.error("bbox 无法构造为有效多边形: %s", bbox)
            raise DataProcessorError(f"bbox 非法，无法构造为有效多边形: {bbox}") from e

        filtered_features = []

        for index, feature in enumerate(geojson.get('features', [])):
            if not isinstance(feature, dict):
                raise DataProcessorError(f"GeoJSON 第 {index} 个要素不是合法的 feature 对象")
            geometry = feature.get('geometry')
            if geometry is None:
                raise DataProcessorError(f"GeoJSON 第 {index} 个要素缺少 geometry 字段")

            # 廉价的范围预判：范围不相交就不必解析几何。
            # 读不出范围（None）时按「可能相交」处理，走完整解析路径。
            bounds = self._geometry_bounds(geometry)
            if bounds is not None and not _bounds_overlap(
                bounds, min_lon, min_lat, max_lon, max_lat
            ):
                continue

            try:
                geom = shape(geometry)
                intersects = geom.intersects(bbox_poly)
            except (ShapelyError, TypeError, ValueError, KeyError, AttributeError) as e:
                # ShapelyError 覆盖 GEOSException / GeometryTypeError 等几何错误。
                logger.error("GeoJSON 要素几何非法: 第 %s 个要素", index)
                raise DataProcessorError(f"GeoJSON 第 {index} 个要素的几何数据非法") from e

            if intersects:
                filtered_features.append(feature)

        return {
            "type": "FeatureCollection",
            "features": filtered_features
        }
    
    def calculate_building_statistics(self, buildings_geojson: Dict[str, Any]) -> Dict[str, Any]:
        """计算建筑统计信息"""
        features = buildings_geojson.get('features', [])
        stats = {
            'total_count': len(features),
            'type_distribution': {},
            'height_stats': {
                'min': float('inf'),
                'max': float('-inf'),
                'average': 0
            }
        }
        
        total_height = 0
        height_count = 0
        
        for feature in features:
            props = feature.get('properties', {})
            
            # 统计建筑类型
            building_type = props.get('type', 'unknown')
            stats['type_distribution'][building_type] = \
                stats['type_distribution'].get(building_type, 0) + 1
            
            # 统计建筑高度
            height = props.get('height', 0)
            if height > 0:
                stats['height_stats']['min'] = min(stats['height_stats']['min'], height)
                stats['height_stats']['max'] = max(stats['height_stats']['max'], height)
                total_height += height
                height_count += 1
        
        # 计算平均高度
        if height_count > 0:
            stats['height_stats']['average'] = round(total_height / height_count, 2)
        else:
            stats['height_stats']['min'] = 0
            stats['height_stats']['max'] = 0
            stats['height_stats']['average'] = 0
        
        return stats

# 创建数据处理工具实例
def get_data_processor(data_dir: str = "./data") -> DataProcessor:
    """获取数据处理器实例"""
    return DataProcessor(data_dir)