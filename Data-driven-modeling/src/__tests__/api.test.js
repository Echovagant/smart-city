import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiGet, ApiError } from '@/api/client'

const originalFetch = globalThis.fetch

// 真实的 fetch 在 signal 被中止时以 AbortError 拒绝；
// 桩必须复刻这个行为，否则"超时"分支永远走不到。
const abortError = () => {
  const err = new Error('The operation was aborted.')
  err.name = 'AbortError'
  return err
}

const fetchThatNeverResolves = () =>
  vi.fn((_url, options) => new Promise((_resolve, reject) => {
    const onAbort = () => reject(abortError())
    if (options.signal.aborted) {
      onAbort()
      return
    }
    options.signal.addEventListener('abort', onAbort)
  }))

// AbortSignal 没有公开的「监听器数量」接口，用一个替身来数。
// 替身只实现 apiGet 真正用到的那几个接口：aborted、addEventListener、removeEventListener。
// once 语义也照抄：触发一次就自动摘除——这样才能区分
// 「监听器被 { once: true } 自动摘掉」和「监听器还挂在 signal 上没摘」。
const makeCountingSignal = () => {
  const listeners = []
  const signal = {
    aborted: false,
    addEventListener(type, handler, options = {}) {
      if (type !== 'abort') return
      listeners.push({ handler, once: Boolean(options.once) })
    },
    removeEventListener(type, handler) {
      if (type !== 'abort') return
      const index = listeners.findIndex((item) => item.handler === handler)
      if (index >= 0) listeners.splice(index, 1)
    },
  }
  return {
    signal,
    get count() {
      return listeners.length
    },
    fire() {
      for (const item of listeners.slice()) {
        if (item.once) {
          const index = listeners.indexOf(item)
          if (index >= 0) listeners.splice(index, 1)
        }
        item.handler()
      }
    },
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('apiGet', () => {
  it('returns parsed JSON on 200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    const result = await apiGet('/api/whatever')
    expect(result).toEqual({ ok: true })
  })

  it('throws ApiError with status on non-2xx', async () => {
    const response = new Response(
      JSON.stringify({ detail: 'bad' }),
      { status: 400, statusText: 'Bad Request', headers: { 'Content-Type': 'application/json' } },
    )
    globalThis.fetch = vi.fn().mockResolvedValue(response)
    await expect(apiGet('/api/x')).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      body: { detail: 'bad' },
    })
  })

  it('throws ApiError on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(apiGet('/api/x')).rejects.toThrowError(ApiError)
  })

  it('aborts the request and reports status 0 on timeout', async () => {
    // 假定时器：超时立刻到期，测试不用真的等
    vi.useFakeTimers()
    globalThis.fetch = fetchThatNeverResolves()

    const settled = apiGet('/api/slow', { timeout: 10 }).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    )

    await vi.advanceTimersByTimeAsync(50)
    const result = await settled

    expect(result.ok).toBe(false)
    expect(result.error).toBeInstanceOf(ApiError)
    // 超时与中止共用一条分支：status 0
    expect(result.error.status).toBe(0)
    expect(result.error.message).toMatch(/超时|中止/)
    expect(result.error.message).toContain('/api/slow')
  })

  it('aborts the request when the caller supplies an aborted signal', async () => {
    const controller = new AbortController()
    globalThis.fetch = fetchThatNeverResolves()

    const settled = apiGet('/api/x', { signal: controller.signal }).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    )

    controller.abort()
    const result = await settled

    expect(result.ok).toBe(false)
    expect(result.error).toBeInstanceOf(ApiError)
    expect(result.error.status).toBe(0)
    expect(result.error.message).toMatch(/超时|中止/)
  })

  it('rejects immediately when the caller passes an already aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    globalThis.fetch = fetchThatNeverResolves()

    await expect(apiGet('/api/x', { signal: controller.signal })).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
    })
  })

  it('keeps the status and a null body when the error response is not JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('<html>500</html>', { status: 500, statusText: 'Internal Server Error' }),
    )

    await expect(apiGet('/api/x')).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      body: null,
    })
  })
})

describe('apiGet 的 abort 监听器', () => {
  it('removes the abort listener when the request completes normally', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    const caller = makeCountingSignal()

    await apiGet('/api/whatever', { signal: caller.signal })

    // { once: true } 只保证「不重复触发」，不保证「只挂一次」：
    // 请求正常结束的话，监听器会一直挂在调用方的 signal 上。
    expect(caller.count).toBe(0)
  })

  it('removes the abort listener when the request fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const caller = makeCountingSignal()

    await expect(apiGet('/api/x', { signal: caller.signal })).rejects.toThrowError(ApiError)

    expect(caller.count).toBe(0)
  })

  it('keeps the abort listener attached while the request is in flight', async () => {
    let settle
    globalThis.fetch = vi.fn(() => new Promise((resolve) => { settle = resolve }))
    const caller = makeCountingSignal()

    const pending = apiGet('/api/slow', { signal: caller.signal })
    // 请求还没结束：监听器必须在，否则调用方中止时我们收不到。
    expect(caller.count).toBe(1)

    settle(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await pending

    expect(caller.count).toBe(0)
  })

  it('removes the abort listener after the caller aborts', async () => {
    globalThis.fetch = fetchThatNeverResolves()
    const caller = makeCountingSignal()

    const settled = apiGet('/api/x', { signal: caller.signal }).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    )

    expect(caller.count).toBe(1)
    caller.fire()
    const result = await settled

    expect(result.ok).toBe(false)
    expect(result.error).toBeInstanceOf(ApiError)
    // 触发时 { once: true } 已经自动摘掉了。
    expect(caller.count).toBe(0)
  })
})