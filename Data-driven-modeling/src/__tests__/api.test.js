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