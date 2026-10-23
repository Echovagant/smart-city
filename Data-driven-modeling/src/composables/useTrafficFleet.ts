import { markRaw } from 'vue'
import type { Ref } from 'vue'
import * as Cesium from 'cesium'
import { DARK_PALETTE, cssColor } from '@/theme/dark'
import { cityConfig } from './useSceneStage'
import type { SmartCityState } from './useSceneStage'
import type { LngLat, WritableEntity } from '../../types/city'

/**
 * 交通：车辆与路灯。
 *
 * 全部用 Cesium 图元（`box` / `cylinder` / `point`）画，**不引用任何 `.glb` 模型**。
 */

/** 车辆在地图上的位置与行驶方向。 */
export interface VehiclePosition {
  lng: number
  lat: number
  direction: 'east' | 'west' | 'north' | 'south'
}

/** 一辆车的动画句柄。 */
export interface VehicleAnimation {
  vehicle: Cesium.Entity
  pos: VehiclePosition
  /** 重新拉起这条动画链（幂等）。 */
  restart: () => void
}

/** 车队对外暴露的东西。 */
export interface TrafficFleet {
  /** 创建交通系统（交通灯 + 车辆 + 路灯）。 */
  createTrafficSystem(): void
  /** 交通显隐（隐藏时动画链断开，重新显示时拉起来）。 */
  toggleTraffic(): void
  /** 取消所有在途的动画帧（组件卸载时调用）。 */
  cancelAllAnimations(): void
}

/** 车队的输入。 */
export interface TrafficFleetOptions {
  /** Cesium 视图（场景底座给的那一份）。 */
  viewer: Ref<Cesium.Viewer | null>
  /** 视图状态（车辆显隐与实体列表都在这里）。 */
  state: SmartCityState
}

export function useTrafficFleet({ viewer, state }: TrafficFleetOptions): TrafficFleet {
  // 跟踪所有 requestAnimationFrame handle，卸载时统一取消
  const animationFrames = new Set<number>()

  // 记录每辆车的动画句柄（{ vehicle, pos, restart }）。
  // moveVehicle 在交通隐藏时会提前返回、动画链就此断掉，
  // 重新显示交通时靠这里的 restart 把链重新拉起来。
  const vehicleAnimations: VehicleAnimation[] = []

  const safeRequestAnimationFrame = (callback: FrameRequestCallback): number => {
    const handle = requestAnimationFrame((t) => {
      animationFrames.delete(handle)
      callback(t)
    })
    animationFrames.add(handle)
    return handle
  }

  const cancelAllAnimations = () => {
    for (const handle of animationFrames) {
      cancelAnimationFrame(handle)
    }
    animationFrames.clear()
  }

  // 创建交通系统
  const createTrafficSystem = () => {
    // 组件可能已经卸载（onUnmounted 里 viewer.value 被置空），
    // 此时直接返回，避免 "Cannot read properties of null (reading 'entities')"。
    if (!viewer.value) return

    // 取一次局部引用：viewer.value 是 ref 的属性，在闭包里会被类型系统当成
    // 可能为 null；createTrafficSystem 是同步的，中途不会被换掉。
    const activeViewer = viewer.value

    const centerLng = cityConfig.center.lng
    const centerLat = cityConfig.center.lat

    // 创建交通灯
    const createTrafficLight = (position: LngLat) => {
      const trafficLight = activeViewer.entities.add({
        name: 'Traffic Light',
        position: Cesium.Cartesian3.fromDegrees(position.lng, position.lat, 0),
        cylinder: {
          length: 5,
          topRadius: 0.1,
          bottomRadius: 0.1,
          // 灯杆用暗蓝：深色底上要看得见，又不能抢主体
          material: cssColor(DARK_PALETTE.secondary, 0.55),
        },
        point: {
          pixelSize: 12,
          // 顶部发光点：预警色（琥珀）
          color: cssColor(DARK_PALETTE.warning),
          outlineColor: cssColor(DARK_PALETTE.warning),
          outlineWidth: 2,
        },
      })

      state.trafficEntities.push(markRaw(trafficLight))
    }

    // 创建车辆
    const createVehicles = () => {
      const vehiclePositions: VehiclePosition[] = [
        { lng: centerLng - 0.01, lat: centerLat, direction: 'east' },
        { lng: centerLng + 0.01, lat: centerLat, direction: 'west' },
        { lng: centerLng, lat: centerLat - 0.01, direction: 'north' },
        { lng: centerLng, lat: centerLat + 0.01, direction: 'south' }
      ]

      vehiclePositions.forEach((pos, index) => {
        const vehicle = activeViewer.entities.add({
          name: `Vehicle ${index + 1}`,
          position: Cesium.Cartesian3.fromDegrees(pos.lng, pos.lat, 0.5),
          box: {
            dimensions: new Cesium.Cartesian3(2.0, 1.0, 0.6),
            // 车身：数据流色（青），在深色底上是发光的
            material: cssColor(DARK_PALETTE.flow, 0.95),
          },
          description: `<h3>车辆 ${index + 1}</h3><p>方向: ${pos.direction}</p>`,
        })

        state.trafficEntities.push(markRaw(vehicle))

        // 车辆动画。记录返回的 restart 回调，
        // 供 toggleTraffic 在"停止 → 启动"时重新拉起被中断的动画链。
        vehicleAnimations.push(animateVehicle(vehicle, pos))
      })
    }

    // 创建路灯
    const createStreetLights = () => {
      const lightPositions: LngLat[] = [
        { lng: centerLng - 0.005, lat: centerLat - 0.005 },
        { lng: centerLng + 0.005, lat: centerLat - 0.005 },
        { lng: centerLng - 0.005, lat: centerLat + 0.005 },
        { lng: centerLng + 0.005, lat: centerLat + 0.005 }
      ]

      lightPositions.forEach((pos, index) => {
        const light = activeViewer.entities.add({
          name: `Street Light ${index + 1}`,
          position: Cesium.Cartesian3.fromDegrees(pos.lng, pos.lat, 8),
          cylinder: {
            length: 8,
            topRadius: 0.1,
            bottomRadius: 0.1,
            material: cssColor(DARK_PALETTE.secondary, 0.55),
          },
          // 灯头：预警色（琥珀），大小与透明度沿用原来的量级
          point: {
            pixelSize: 20,
            color: cssColor(DARK_PALETTE.warning, 0.6)
          }
        })

        state.trafficEntities.push(markRaw(light))
      })
    }

    const animateVehicle = (vehicle: Cesium.Entity, pos: VehiclePosition): VehicleAnimation => {
      let distance = 0
      const speed = 0.00001 // 移动速度
      // 该车辆当前是否挂着一条动画链。用于保证 restart 幂等：
      // 链还在跑的时候不再启动第二条，否则快速反复点击"启动/停止"
      // 会开出多条并行链，每帧做多倍无用功。
      let running = false

      const moveVehicle = () => {
        // 每次进入先清掉运行标记：如果下面因为交通隐藏而提前返回，
        // 就说明这条链已经断开，toggleTraffic 可以安全地重新拉起它。
        running = false
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

        // Entity.position 运行时同样接受裸的 Cartesian3（自动包成
        // ConstantPositionProperty），见 types/city.ts 的 WritableEntity。
        const writableVehicle = vehicle as WritableEntity
        writableVehicle.position = Cesium.Cartesian3.fromDegrees(newLng, newLat, 0.5)
        running = true
        safeRequestAnimationFrame(moveVehicle)
      }

      // 重新拉起这条动画链。幂等：链还在跑的时候不重复启动。
      const restart = () => {
        if (running) return
        moveVehicle()
      }

      moveVehicle()

      return { vehicle, pos, restart }
    }

    // 执行创建
    createTrafficLight({ lng: centerLng + 0.001, lat: centerLat })
    createTrafficLight({ lng: centerLng, lat: centerLat + 0.001 })
    createVehicles()
    createStreetLights()
  }

  const toggleTraffic = () => {
    state.trafficVisible = !state.trafficVisible
    state.trafficEntities.forEach(entity => {
      entity.show = state.trafficVisible
    })

    // moveVehicle 在交通隐藏时会提前 return（不再排下一帧），动画链就此断掉。
    // 重新显示交通时必须显式 restart 每辆车，否则车辆会永远停在最后一次的位置，
    // 只有刷新页面才能恢复运动。restart 本身是幂等的，不会开出第二条并行链。
    if (state.trafficVisible) {
      vehicleAnimations.forEach(animation => animation.restart())
    }
  }

  return {
    createTrafficSystem,
    toggleTraffic,
    cancelAllAnimations,
  }
}
