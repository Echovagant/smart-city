import { mount } from '@vue/test-utils'
import { describe, it, expect } from 'vitest'
import App from '../App.vue'

describe('App shell', () => {
  it('mounts without throwing', () => {
    const wrapper = mount(App, {
      // SmartCity.vue's onMounted will try to construct a Cesium.Viewer
      // against a jsdom container. Stub the cesium module to a no-op
      // so this test exercises component wiring, not WebGL.
      global: {
        stubs: {
          SmartCity: { template: '<div data-testid="smart-city-stub" />' },
        },
      },
    })
    expect(wrapper.find('[data-testid="smart-city-stub"]').exists()).toBe(true)
  })
})
