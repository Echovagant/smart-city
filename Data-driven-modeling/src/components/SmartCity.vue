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

// 移除手动设置的CESIUM_BASE_URL，让Vite自动处理

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

// 初始化Cesium - 使用最简单的配置
const initCesium = () => {
  if (!cesiumContainer.value) return
  
  // 关键：不使用Cesium.Ion
  Cesium.Ion.defaultAccessToken = ''
  
  // 创建一个非常基础的viewer实例
  viewer.value = new Cesium.Viewer(cesiumContainer.value, {
    timeline: false,
    animation: false,
    baseLayerPicker: true, // 启用基础图层选择器，让用户可以选择地图
    imageryProvider: undefined, // 不预先设置，让Cesium使用默认的离线地图
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
  try {
    // 加载public/data/buildings.geojson
    const dataSource = await viewer.value.dataSources.add(
      Cesium.GeoJsonDataSource.load('/data/buildings.geojson') // 路径对应public下的文件
    )

    const entities = dataSource.entities.values
    entities.forEach(entity => {
      // 从GeoJSON的properties中获取高度（如果没有则默认30米）
      const height = entity.properties.height?.getValue() || 30
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
  } catch (error) {
    console.error('加载建筑GeoJSON失败:', error)
  }
}

// 加载真实GeoJSON道路数据
const loadGeoJSONRoads = async () => {
  try {
    // 加载public/data/roads.geojson
    const dataSource = await viewer.value.dataSources.add(
      Cesium.GeoJsonDataSource.load('/data/roads.geojson')
    )

    const entities = dataSource.entities.values
    entities.forEach(entity => {
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
  } catch (error) {
    console.error('加载道路GeoJSON失败:', error)
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
      position: Cesium.Cartesian3.fromDegrees(position.lng, position.lat, 5),
      model: {
        uri: '/models/traffic-light.glb', // 需要准备交通灯模型
        scale: 0.5
      }
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
        model: {
          uri: '/models/car.glb', // 需要准备车辆模型
          scale: 0.3,
          heading: getHeadingFromDirection(pos.direction)
        },
        description: `<h3>车辆 ${index + 1}</h3><p>方向: ${pos.direction}</p>`
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
        model: {
          uri: '/models/street-light.glb', // 需要准备路灯模型
          scale: 0.8
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
      requestAnimationFrame(moveVehicle)
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
onMounted(() => {
  try {
    initCesium()          // 初始化Cesium容器
    // 暂时不启用性能优化，先确保基础地图显示
    // optimizePerformance() 
    
    // 添加一个简单的实体来测试渲染
    if (viewer.value) {
      viewer.value.entities.add({
        name: '测试点',
        position: Cesium.Cartesian3.fromDegrees(cityConfig.center.lng, cityConfig.center.lat, 100),
        point: {
          pixelSize: 10,
          color: Cesium.Color.RED
        }
      })
      
      // 先注释掉可能影响渲染的复杂功能，确保基础地图正常显示
      // loadGeoJSONBuildings() // 加载GeoJSON建筑
      // loadGeoJSONRoads()     // 加载GeoJSON道路
      // createTrafficSystem()  // 创建交通系统
    }
  } catch (error) {
    console.error('初始化错误:', error)
  }
})

onUnmounted(() => {
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
