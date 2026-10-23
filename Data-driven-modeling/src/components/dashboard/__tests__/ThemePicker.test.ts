import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ThemeDefinition, ThemeOverrides } from '@/theme/themes/types'
import { THEMES } from '@/theme/themes'

/**
 * 主题选择器的行为断言。
 *
 * 主题状态是模块级单例，所以这里换成**可控的假控制器**：
 * 用例只关心「界面把用户的动作递给了控制器」，
 * 不依赖主题模块实现的任何具体行为（持久化、CSS 变量写入等）。
 */
interface ThemeControllerMock {
  themeId: { value: string }
  overrides: { value: ThemeOverrides }
  theme: { value: ThemeDefinition }
}

const themeMock = vi.hoisted(() => ({
  setTheme: vi.fn(),
  setOverride: vi.fn(),
  resetOverrides: vi.fn(),
  /** 假控制器实例：用例靠它改主题 / 覆盖，验证界面跟着变。 */
  controller: null as ThemeControllerMock | null,
}))

vi.mock('@/composables/useTheme', async () => {
  const { computed, ref } = await import('vue')
  const { resolveTheme } = await import('@/theme/themes')
  return {
    useTheme: () => {
      const themeId = ref('deep-space')
      const overrides = ref<ThemeOverrides>({})
      const theme = computed(() => resolveTheme(themeId.value, overrides.value))
      const controller = {
        themeId,
        overrides,
        theme,
        setTheme: (id: string) => {
          themeMock.setTheme(id)
          themeId.value = id
        },
        setOverride: (key: keyof ThemeOverrides, value: string | number | undefined) => {
          themeMock.setOverride(key, value)
          overrides.value = { ...overrides.value, [key]: value }
        },
        resetOverrides: () => {
          themeMock.resetOverrides()
          overrides.value = {}
        },
      }
      themeMock.controller = controller as unknown as ThemeControllerMock
      return controller
    },
  }
})

import ThemePicker from '../ThemePicker.vue'

beforeEach(() => {
  vi.clearAllMocks()
  themeMock.controller = null
})

describe('ThemePicker', () => {
  it('renders one card per default theme with its label and description', () => {
    const wrapper = mount(ThemePicker)

    const cards = wrapper.findAll('.dc-theme-card')
    expect(cards).toHaveLength(THEMES.length)
    expect(cards.map(card => card.find('.dc-theme-card-label').text())).toEqual(
      THEMES.map(theme => theme.label),
    )
    expect(cards.map(card => card.find('.dc-theme-card-desc').text())).toEqual(
      THEMES.map(theme => theme.description),
    )
  })

  it('previews each theme with colours taken from that theme', () => {
    const wrapper = mount(ThemePicker)

    const swatches = wrapper
      .findAll('.dc-theme-card')
      .map(card => card.findAll('.dc-theme-swatch').map(swatch => swatch.attributes('data-color')))

    swatches.forEach((colors, index) => {
      const theme = THEMES[index]
      expect(colors).toContain(theme.palette.screen)
      expect(colors).toContain(theme.palette.accent)
      expect(colors).toContain(theme.palette.flow)
      expect(colors).toContain(theme.roadColors.main)
    })
  })

  it('switches the theme when a card is clicked', async () => {
    const wrapper = mount(ThemePicker)

    const cards = wrapper.findAll('.dc-theme-card')
    await cards[1].trigger('click')

    expect(themeMock.setTheme).toHaveBeenCalledTimes(1)
    expect(themeMock.setTheme).toHaveBeenCalledWith(THEMES[1].id)
  })

  it('marks the active theme with a border and a text marker, not colour alone', () => {
    const wrapper = mount(ThemePicker)

    const cards = wrapper.findAll('.dc-theme-card')
    const active = cards.filter(card => card.classes().includes('is-active'))
    expect(active).toHaveLength(1)
    expect(active[0].attributes('aria-pressed')).toBe('true')
    // 不只靠颜色：当前主题另有一个文字标记
    expect(active[0].find('.dc-theme-card-marker').text()).toBe('当前')
    // 其余卡片没有标记
    const others = cards.filter(card => !card.classes().includes('is-active'))
    expect(others.every(card => card.find('.dc-theme-card-marker').exists())).toBe(false)
  })

  it('sends the road colour to setOverride', async () => {
    const wrapper = mount(ThemePicker)

    const colors = wrapper.findAll('input[type="color"]')
    expect(colors).toHaveLength(2)
    await colors[0].setValue('#3b82f6')

    expect(themeMock.setOverride).toHaveBeenCalledTimes(1)
    expect(themeMock.setOverride).toHaveBeenCalledWith('roadMain', '#3b82f6')
  })

  it('sends the building colour to setOverride', async () => {
    const wrapper = mount(ThemePicker)

    const colors = wrapper.findAll('input[type="color"]')
    await colors[1].setValue('#0d1a2e')

    expect(themeMock.setOverride).toHaveBeenCalledTimes(1)
    expect(themeMock.setOverride).toHaveBeenCalledWith('building', '#0d1a2e')
  })

  it('sends the glow power to setOverride', async () => {
    const wrapper = mount(ThemePicker)

    const ranges = wrapper.findAll('input[type="range"]')
    expect(ranges).toHaveLength(2)
    // 辉光强度的取值范围是 0 ~ 0.3
    expect(ranges[0].attributes('min')).toBe('0')
    expect(ranges[0].attributes('max')).toBe('0.3')
    expect(ranges[0].attributes('step')).toBe('0.01')
    await ranges[0].setValue('0.2')

    expect(themeMock.setOverride).toHaveBeenCalledTimes(1)
    expect(themeMock.setOverride).toHaveBeenCalledWith('glowPower', 0.2)
  })

  it('sends the road opacity to setOverride', async () => {
    const wrapper = mount(ThemePicker)

    const ranges = wrapper.findAll('input[type="range"]')
    // 路面不透明度的取值范围是 0.3 ~ 1
    expect(ranges[1].attributes('min')).toBe('0.3')
    expect(ranges[1].attributes('max')).toBe('1')
    expect(ranges[1].attributes('step')).toBe('0.01')
    await ranges[1].setValue('0.5')

    expect(themeMock.setOverride).toHaveBeenCalledTimes(1)
    expect(themeMock.setOverride).toHaveBeenCalledWith('roadAlpha', 0.5)
  })

  it('clears every override when 恢复默认 is clicked', async () => {
    const wrapper = mount(ThemePicker)

    const reset = wrapper.find('.dc-theme-reset')
    expect(reset.text()).toBe('恢复默认')
    await reset.trigger('click')

    expect(themeMock.resetOverrides).toHaveBeenCalledTimes(1)
  })

  it('never offers the warning and alert colours as editable items', async () => {
    const wrapper = mount(ThemePicker)

    // 语义色（预警橙 / 告警红）跨主题恒定，不开放自选：
    // 面板里根本不出现这两个色值，也不许把它们送进 setOverride。
    expect(wrapper.html()).not.toContain('#f59e0b')
    expect(wrapper.html()).not.toContain('#f43f5e')

    const colorValues = wrapper
      .findAll('input[type="color"]')
      .map(input => input.attributes('value'))
    expect(colorValues).not.toContain('#f59e0b')
    expect(colorValues).not.toContain('#f43f5e')

    // 可编辑的颜色只有两项：道路主色与建筑本体色
    await wrapper.findAll('input[type="color"]')[0].setValue('#3b82f6')
    expect(themeMock.setOverride.mock.calls.map(([key]) => key)).toEqual(['roadMain'])
  })

  it('shows the current theme and marks the overridden fields', async () => {
    const wrapper = mount(ThemePicker)

    expect(wrapper.find('.dc-theme-picker-current').text()).toBe(THEMES[0].label)
    expect(wrapper.find('.dc-theme-status').text()).toBe('当前使用主题原值')

    await wrapper.findAll('input[type="color"]')[0].setValue('#3b82f6')

    expect(wrapper.find('.dc-theme-status').text()).toBe('已自定义 1 项')
    expect(wrapper.find('.dc-theme-field-flag').text()).toBe('已改')
  })
})
