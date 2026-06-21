<template>
  <div class="smart-city-container">
    <!-- Cesium容器 -->
    <div ref="cesiumContainer" class="cesium-container"></div>

    <!-- 控制面板 -->
    <div class="control-panel">
      <button @click="toggleBuildings">
        {{ buildingVisible ? '隐藏建筑' : '显示建筑' }}
      </button>
      <button @click="toggleRoads">
        {{ roadVisible ? '隐藏道路' : '显示道路' }}
      </button>
      <button @click="toggleTraffic">
        {{ trafficVisible ? '停止交通' : '启动交通' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, reactive } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { useCityData } from '@/composables/useCityData'

// 移除手动设置的CESIUM_BASE_URL，让Vite自动处理

// 跟踪所有 requestAnimationFrame handle，onUnmounted 时统一取消
const animationFrames = new Set()

function safeRequestAnimationFrame(callback) {
  const handle = requestAnimationFrame((t) => {
    animationFrames.delete(handle)
    callback(t)
  })
  animationFrames.add(handle)
  return handle
}

function cancelAllAnimations() {
  for (const handle of animationFrames) {
    cancelAnimationFrame(handle)
  }
  animationFrames.clear()
}

// 组件挂载状态标志，async 初始化路径在 await 后检查
let isMounted = true

// 组件状态
const cesiumContainer = ref(null)
const viewer = ref(null)
const state = reactive({
  buildingVisible: true,
  roadVisible: true,
  trafficVisible: true,
  buildingEntities: [],
  roadEntities: [],
  trafficEntities: []
})

// 城市配置参数
const cityConfig = {
  center: { lng: 116.404, lat: 39.915 }, // 北京坐标，可根据需要修改
  zoomLevel: 1500,
  buildingColors: [
    Cesium.Color.fromCssColorString('#4A90E2'),
    Cesium.Color.fromCssColorString('#7ED321'),
    Cesium.Color.fromCssColorString('#F5A623'),
    Cesium.Color.fromCssColorString('#D0021B'),
    Cesium.Color.fromCssColorString('#9013FE')
  ]
}

// 城市数据来源（通过 useCityData composable 从后端 /api/* 拉取 GeoJSON）
const { buildings, roads, loadAll } = useCityData()

// 初始化Cesium - 使用最简单的配置
const initCesium = () => {
  if (!cesiumContainer.value) return

  // 创建一个非常基础的viewer实例
  viewer.value = new Cesium.Viewer(cesiumContainer.value, {
    timeline: false,
    animation: false,
    baseLayerPicker: true, // 启用基础图层选择器，让用户可以选择地图
    imageryProvider: new Cesium.OpenStreetMapImageryProvider({
      url: 'https://tile.openstreetmap.org/'
    }),
    terrainProvider: undefined,
    // 禁用可能导致问题的功能
    useDefaultRenderLoop: true,
    sceneMode: Cesium.SceneMode.SCENE3D,
    // 增加错误处理
    errorHandler: function(error) {
      console.warn('Cesium初始化错误:', error)
    }
  })
  
  // 定位到城市中心
  viewer.value.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      cityConfig.center.lng,
      cityConfig.center.lat,
      cityConfig.zoomLevel
    ),
    duration: 2
  })
}

// 保持简单，不单独初始化影像图层，使用Cesium默认配置

// 优化3D场景性能
const optimizePerformance = () => {
  // 开启视锥体剔除（只渲染可见区域）
  viewer.value.scene.globe.enableLighting = true

  // 添加雾效果（远处建筑渐隐，减少渲染压力）
  viewer.value.scene.fog.density = 0.0002
  viewer.value.scene.fog.near = 1000 // 雾开始生效的距离
  viewer.value.scene.fog.far = 5000 // 雾完全遮挡的距离

  // 开启抗锯齿
  viewer.value.scene.postProcessStages.fxaa.enabled = true

  // 限制最大帧率（避免过度消耗GPU）
  viewer.value.scene.maximumFrameRate = 60
}

// 加载真实GeoJSON建筑数据（替换随机生成的建筑）
const loadGeoJSONBuildings = async () => {
  if (!buildings.value) return
  try {
    // 使用 useCityData 已加载到内存的 GeoJSON 对象，避免再次发起 HTTP 请求。
    const dataSource = await Cesium.GeoJsonDataSource.load(buildings.value, {
      clampToGround: false,
    })
    if (!isMounted) return

    const entities = dataSource.entities.values
    entities.forEach(entity => {
      if (!isMounted) return
      // 从GeoJSON的properties中获取高度（OSM常用字段为 height 或 building:levels）
      const height = entity.properties.height?.getValue() || entity.properties['building:levels']?.getValue() * 3 || 30
      // 随机选择建筑颜色
      const color = cityConfig.buildingColors[Math.floor(Math.random() * cityConfig.buildingColors.length)]

      // 将多边形拉伸为3D建筑
      entity.polygon.extrudedHeight = height // 拉伸高度
      entity.polygon.material = color.withAlpha(0.8) // 建筑颜色
      entity.polygon.outline = true // 显示轮廓
      entity.polygon.outlineColor = Cesium.Color.WHITE // 轮廓颜色

      // 存入状态管理，用于控制显示/隐藏
      state.buildingEntities.push(entity)
    })

    if (isMounted) {
      viewer.value.dataSources.add(dataSource)
    }
  } catch (error) {
    console.error('加载建筑 GeoJSON 失败:', error)
  }
}

// 加载真实GeoJSON道路数据
const loadGeoJSONRoads = async () => {
  if (!roads.value) return
  try {
    // 使用 useCityData 已加载到内存的 GeoJSON 对象，避免再次发起 HTTP 请求。
    const dataSource = await Cesium.GeoJsonDataSource.load(roads.value, {
      clampToGround: true,
    })
    if (!isMounted) return

    const entities = dataSource.entities.values
    entities.forEach(entity => {
      if (!isMounted) return
      // 从GeoJSON的properties中获取道路宽度（默认10米）
      const width = entity.properties.width?.getValue() || 10
      // 根据道路类型设置颜色（主干道深灰，其他浅灰）
      const color = entity.properties.type?.getValue() === 'main'
        ? Cesium.Color.DARKGRAY
        : Cesium.Color.GRAY

      // 配置道路样式
      entity.polyline.width = width // 道路宽度
      entity.polyline.material = color // 道路颜色
      entity.polyline.clampToGround = true // 贴地显示

      // 存入状态管理，用于控制显示/隐藏
      state.roadEntities.push(entity)
    })

    if (isMounted) {
      viewer.value.dataSources.add(dataSource)
    }
  } catch (error) {
    console.error('加载道路 GeoJSON 失败:', error)
  }
}

// 创建交通系统
const createTrafficSystem = () => {
  const centerLng = cityConfig.center.lng
  const centerLat = cityConfig.center.lat

  // 创建交通灯
  const createTrafficLight = (position, direction) => {
    const trafficLight = viewer.value.entities.add({
      name: 'Traffic Light',
      position: Cesium.Cartesian3.fromDegrees(position.lng, position.lat, 0),
      cylinder: {
        length: 5,
        topRadius: 0.1,
        bottomRadius: 0.1,
        material: Cesium.Color.DARKGRAY,
      },
      point: {
        pixelSize: 12,
        color: Cesium.Color.RED,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
      },
    })

    state.trafficEntities.push(trafficLight)
  }

  // 创建车辆
  const createVehicles = () => {
    const vehiclePositions = [
      { lng: centerLng - 0.01, lat: centerLat, direction: 'east' },
      { lng: centerLng + 0.01, lat: centerLat, direction: 'west' },
      { lng: centerLng, lat: centerLat - 0.01, direction: 'north' },
      { lng: centerLng, lat: centerLat + 0.01, direction: 'south' }
    ]

    vehiclePositions.forEach((pos, index) => {
      const vehicle = viewer.value.entities.add({
        name: `Vehicle ${index + 1}`,
        position: Cesium.Cartesian3.fromDegrees(pos.lng, pos.lat, 0.5),
        box: {
          dimensions: new Cesium.Cartesian3(2.0, 1.0, 0.6),
          material: Cesium.Color.fromCssColorString('#4A90E2'),
        },
        description: `<h3>车辆 ${index + 1}</h3><p>方向: ${pos.direction}</p>`,
      })

      state.trafficEntities.push(vehicle)

      // 车辆动画
      animateVehicle(vehicle, pos)
    })
  }

  // 创建路灯
  const createStreetLights = () => {
    const lightPositions = [
      { lng: centerLng - 0.005, lat: centerLat - 0.005 },
      { lng: centerLng + 0.005, lat: centerLat - 0.005 },
      { lng: centerLng - 0.005, lat: centerLat + 0.005 },
      { lng: centerLng + 0.005, lat: centerLat + 0.005 }
    ]

    lightPositions.forEach((pos, index) => {
      const light = viewer.value.entities.add({
        name: `Street Light ${index + 1}`,
        position: Cesium.Cartesian3.fromDegrees(pos.lng, pos.lat, 8),
        cylinder: {
          length: 8,
          topRadius: 0.1,
          bottomRadius: 0.1,
          material: Cesium.Color.DARKGRAY,
        },
        // 添加灯光效果
        point: {
          pixelSize: 20,
          color: Cesium.Color.YELLOW.withAlpha(0.6)
        }
      })

      state.trafficEntities.push(light)
    })
  }

  // 辅助函数
  const getHeadingFromDirection = (direction) => {
    const directions = {
      east: Cesium.Math.toRadians(90),
      west: Cesium.Math.toRadians(270),
      north: Cesium.Math.toRadians(0),
      south: Cesium.Math.toRadians(180)
    }
    return directions[direction] || 0
  }

  const animateVehicle = (vehicle, pos) => {
    let distance = 0
    const speed = 0.00001 // 移动速度

    const moveVehicle = () => {
      if (!state.trafficVisible) return

      distance += speed
      if (distance > 0.02) distance = -0.02

      let newLng = pos.lng
      let newLat = pos.lat

      switch (pos.direction) {
        case 'east':
          newLng = cityConfig.center.lng - 0.01 + distance
          break
        case 'west':
          newLng = cityConfig.center.lng + 0.01 - distance
          break
        case 'north':
          newLat = cityConfig.center.lat - 0.01 + distance
          break
        case 'south':
          newLat = cityConfig.center.lat + 0.01 - distance
          break
      }

      vehicle.position = Cesium.Cartesian3.fromDegrees(newLng, newLat, 0.5)
      safeRequestAnimationFrame(moveVehicle)
    }

    moveVehicle()
  }

  // 执行创建
  createTrafficLight({ lng: centerLng + 0.001, lat: centerLat }, 'north-south')
  createTrafficLight({ lng: centerLng, lat: centerLat + 0.001 }, 'east-west')
  createVehicles()
  createStreetLights()
}

// 控制函数
const toggleBuildings = () => {
  state.buildingVisible = !state.buildingVisible
  state.buildingEntities.forEach(entity => {
    entity.show = state.buildingVisible
  })
}

const toggleRoads = () => {
  state.roadVisible = !state.roadVisible
  state.roadEntities.forEach(entity => {
    entity.show = state.roadVisible
  })
}

const toggleTraffic = () => {
  state.trafficVisible = !state.trafficVisible
  state.trafficEntities.forEach(entity => {
    entity.show = state.trafficVisible
  })
}

// 生命周期钩子
onMounted(async () => {
  try {
    initCesium()
    if (!viewer.value) return
    optimizePerformance()
    await loadAll()
    if (!isMounted) return
    await loadGeoJSONBuildings()
    await loadGeoJSONRoads()
    createTrafficSystem()
  } catch (error) {
    console.error('初始化错误:', error)
  }
})

onUnmounted(() => {
  isMounted = false
  cancelAllAnimations()
  if (viewer.value) {
    viewer.value.destroy()
    viewer.value = null
  }
})
</script>

<style scoped>
.smart-city-container {
  position: relative;
  width: 100vw;
  height: 100vh;
}

.cesium-container {
  width: 100%;
  height: 100%;
}

.control-panel {
  position: absolute;
  top: 20px;
  left: 20px;
  z-index: 100;
  background: rgba(0, 0, 0, 0.7);
  padding: 15px;
  border-radius: 8px;
}

.control-panel button {
  display: block;
  margin: 8px 0;
  padding: 8px 16px;
  background: #4A90E2;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.3s;
}

.control-panel button:hover {
  background: #357ABD;
}

.building-info {
  padding: 10px;
  font-family: Arial, sans-serif;
}

.building-info h3 {
  margin: 0 0 10px 0;
  color: #4A90E2;
}

.building-info p {
  margin: 5px 0;
  color: #333;
}
</style>
