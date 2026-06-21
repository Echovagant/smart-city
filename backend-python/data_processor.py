import json
import logging
import os
from typing import Dict, List, Any
from shapely.geometry import shape, mapping
from shapely.ops import unary_union

logger = logging.getLogger(__name__)


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
    
    def filter_features_by_bbox(self, geojson: Dict[str, Any], bbox: List[float]) -> Dict[str, Any]:
        """根据边界框过滤GeoJSON要素"""
        min_lon, min_lat, max_lon, max_lat = bbox
        filtered_features = []
        
        for feature in geojson.get('features', []):
            geom = shape(feature['geometry'])
            # 创建边界框多边形
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
            
            if geom.intersects(bbox_poly):
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