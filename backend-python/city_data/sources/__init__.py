"""各个数据源。

一个源一个模块，各自负责：取数、解析、产出指标与序列。
所有取数失败都抛 :class:`city_data.http.SourceUnavailable`，
由聚合器统一转成降级。
"""
