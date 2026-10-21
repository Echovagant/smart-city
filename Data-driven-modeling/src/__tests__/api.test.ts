import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiGet, ApiError } from '@/api/client'
import type { AbortSignalLike } from '@/api/client'

const originalFetch = globalThis.fetch

/**
 * 把一个 fetch 桩装到 globalThis 上。
 *
 * fetch 的类型是 `(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>`，
 * 而测试里的桩只关心 url 与 signal —— 这里做一次显式收窄（而不是改 fetch 的类型），
 * 免得桩的简化把真实签名也一起放松了。
 */
const installFetch = (stub: unknown) => {
  globalThis.fetch = stub as typeof fetch
}

// 真实的 fetch 在 signal 被中止时以 AbortError 拒绝；
// 桩必须复刻这个行为，否则"超时"分支永远走不到。
const abortError = () => {
  const err = new Error('The operation was aborted.')
  err.name = 'AbortError'
  return err
}

/** 桩真正用到的 fetch 参数。 */
interface FetchStubOptions {
  signal: AbortSignal
}

const fetchThatNeverResolves = () =>
  vi.fn((_url: string, options: FetchStubOptions) => new Promise<Response>((_resolve, reject) => {
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
interface AbortListener {
  handler: () => void
  once: boolean
}

const makeCountingSignal = () => {
  const listeners: AbortListener[] = []
  const signal: AbortSignalLike = {
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

/** apiGet 的成功/失败两态结果。 */
type SettledResult =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown }

/**
 * 断言请求失败，并返回错误对象。
 *
 * 结果是成功/失败两态的联合；断言不成立时直接抛错，
 * 保证后面的断言不会因为「分支没走到」而被悄悄跳过。
 */
const expectFailure = (result: SettledResult): ApiError => {
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error('期望请求失败，但它成功了')
  }
  return result.error as ApiError
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('apiGet', () => {
  it('returns parsed JSON on 200', async () => {
    installFetch(vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ))
    const result = await apiGet('/api/whatever')
    expect(result).toEqual({ ok: true })
  })

  it('throws ApiError with status on non-2xx', async () => {
    const response = new Response(
      JSON.stringify({ detail: 'bad' }),
      { status: 400, statusText: 'Bad Request', headers: { 'Content-Type': 'application/json' } },
    )
    installFetch(vi.fn<typeof fetch>().mockResolvedValue(response))
    await expect(apiGet('/api/x')).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      body: { detail: 'bad' },
    })
  })

  it('throws ApiError on network failure', async () => {
    installFetch(vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(apiGet('/api/x')).rejects.toThrowError(ApiError)
  })

  it('aborts the request and reports status 0 on timeout', async () => {
    // 假定时器：超时立刻到期，测试不用真的等
    vi.useFakeTimers()
    installFetch(fetchThatNeverResolves())

    const settled = apiGet('/api/slow', { timeout: 10 }).then(
      (value): SettledResult => ({ ok: true, value }),
      (error): SettledResult => ({ ok: false, error }),
    )

    await vi.advanceTimersByTimeAsync(50)
    const result = await settled

    const error = expectFailure(result)
    expect(error).toBeInstanceOf(ApiError)
    // 超时与中止共用一条分支：status 0
    expect(error.status).toBe(0)
    expect(error.message).toMatch(/超时|中止/)
    expect(error.message).toContain('/api/slow')
  })

  it('aborts the request when the caller supplies an aborted signal', async () => {
    const controller = new AbortController()
    installFetch(fetchThatNeverResolves())

    const settled = apiGet('/api/x', { signal: controller.signal }).then(
      (value): SettledResult => ({ ok: true, value }),
      (error): SettledResult => ({ ok: false, error }),
    )

    controller.abort()
    const result = await settled

    const error = expectFailure(result)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(0)
    expect(error.message).toMatch(/超时|中止/)
  })

  it('rejects immediately when the caller passes an already aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    installFetch(fetchThatNeverResolves())

    await expect(apiGet('/api/x', { signal: controller.signal })).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
    })
  })

  it('keeps the status and a null body when the error response is not JSON', async () => {
    installFetch(vi.fn<typeof fetch>().mockResolvedValue(
      new Response('<html>500</html>', { status: 500, statusText: 'Internal Server Error' }),
    ))

    await expect(apiGet('/api/x')).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      body: null,
    })
  })
})

describe('apiGet 的 abort 监听器', () => {
  it('removes the abort listener when the request completes normally', async () => {
    installFetch(vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ))
    const caller = makeCountingSignal()

    await apiGet('/api/whatever', { signal: caller.signal })

    // { once: true } 只保证「不重复触发」，不保证「只挂一次」：
    // 请求正常结束的话，监听器会一直挂在调用方的 signal 上。
    expect(caller.count).toBe(0)
  })

  it('removes the abort listener when the request fails', async () => {
    installFetch(vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')))
    const caller = makeCountingSignal()

    await expect(apiGet('/api/x', { signal: caller.signal })).rejects.toThrowError(ApiError)

    expect(caller.count).toBe(0)
  })

  it('keeps the abort listener attached while the request is in flight', async () => {
    // 手动放行：请求一直悬着，等我们调用 release 才 resolve。
    // 初值是一个会抛错的占位实现——桩没被调用时测试照样失败。
    let release: (response: Response) => void = () => {
      throw new Error('fetch 桩还没有被调用')
    }
    installFetch(vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { release = resolve })))
    const caller = makeCountingSignal()

    const pending = apiGet('/api/slow', { signal: caller.signal })
    // 请求还没结束：监听器必须在，否则调用方中止时我们收不到。
    expect(caller.count).toBe(1)

    release(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await pending

    expect(caller.count).toBe(0)
  })

  it('removes the abort listener after the caller aborts', async () => {
    installFetch(fetchThatNeverResolves())
    const caller = makeCountingSignal()

    const settled = apiGet('/api/x', { signal: caller.signal }).then(
      (value): SettledResult => ({ ok: true, value }),
      (error): SettledResult => ({ ok: false, error }),
    )

    expect(caller.count).toBe(1)
    caller.fire()
    const result = await settled

    const error = expectFailure(result)
    expect(error).toBeInstanceOf(ApiError)
    // 触发时 { once: true } 已经自动摘掉了。
    expect(caller.count).toBe(0)
  })
})
