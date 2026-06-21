import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiGet, ApiError } from '@/api/client'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
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
})