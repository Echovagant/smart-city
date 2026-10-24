/**
 * 城市清单 —— **id 与名字的唯一事实来源**。
 *
 * 这个模块刻意不 import 任何重的东西（没有 Cesium、没有场景层），
 * 所以数据层（`useCityData`）与场景层（`useSceneStage`）都能引它，
 * 不会形成循环依赖。
 *
 * 场景参数（城心 / 鸟瞰高度 / 平视落点）在 `useSceneStage` 的 `CITY_SCENES` 里 ——
 * 那是**这套数据的事实**，不是通用常量。
 */

/** 默认城市。 */
export const DEFAULT_CITY_ID = 'barcelona'

/** 一个可选项。 */
export interface CityOption {
  id: string
  label: string
}

/** 可选的城市（与后端 `city_data/cities.py` 一一对应）。 */
export const CITY_OPTIONS: CityOption[] = [
  { id: 'barcelona', label: '巴塞罗那' },
  { id: 'milano', label: '米兰' },
]

/** 城市 id 是否已知。 */
export function isKnownCity(cityId: string | null | undefined): boolean {
  return !!cityId && CITY_OPTIONS.some(option => option.id === cityId)
}
