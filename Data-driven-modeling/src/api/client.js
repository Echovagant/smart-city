// 极简的 fetch 封装：处理超时、JSON 解析、错误规范化。
// 业务侧只需关心返回值，不需要 try/catch fetch 错误。

const DEFAULT_TIMEOUT_MS = 15000

export class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export async function apiGet(path, { timeout = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  // 允许调用方传入自己的 signal 与我们的超时 controller 合并。
  if (signal) {
    if (signal.aborted) controller.abort()
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    const response = await fetch(path, { signal: controller.signal })
    if (!response.ok) {
      let body = null
      try { body = await response.json() } catch { /* body 不可 JSON */ }
      throw new ApiError(
        `HTTP ${response.status} ${response.statusText} for ${path}`,
        { status: response.status, body },
      )
    }
    return await response.json()
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (err.name === 'AbortError') {
      throw new ApiError(`请求超时或被中止: ${path}`, { status: 0 })
    }
    throw new ApiError(`网络错误: ${err.message}`, { status: 0 })
  } finally {
    clearTimeout(timer)
  }
}