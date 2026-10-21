// 极简的 fetch 封装：处理超时、JSON 解析、错误规范化。
// 业务侧只需关心返回值，不需要 try/catch fetch 错误。

const DEFAULT_TIMEOUT_MS = 15000

/**
 * apiGet 真正用到的那几个 AbortSignal 能力。
 *
 * 这里声明成结构类型而不是直接用 AbortSignal：调用方（以及测试里的替身）
 * 只需要提供 aborted / addEventListener / removeEventListener 这三样，
 * 把「封装真正依赖什么」写进类型，比让调用方去满足整个 AbortSignal 更准确。
 */
export interface AbortSignalLike {
  /** 信号是否已经中止。 */
  aborted: boolean
  /** 注册中止监听器。 */
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void
  /** 摘掉中止监听器。 */
  removeEventListener(type: string, listener: () => void): void
}

export interface ApiErrorOptions {
  /** HTTP 状态码；网络错误或超时时是 0。 */
  status?: number
  /** 响应体：能解析成 JSON 才是对象，否则是 null。 */
  body?: unknown
}

export class ApiError extends Error {
  /** HTTP 状态码；网络错误或超时时是 0。 */
  status?: number
  /** 响应体：能解析成 JSON 才是对象，否则是 null。 */
  body?: unknown

  constructor(message: string, { status, body }: ApiErrorOptions = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export interface ApiGetOptions {
  /** 超时毫秒数，默认 15000。 */
  timeout?: number
  /** 调用方自己的中止信号（与超时信号合并）。 */
  signal?: AbortSignalLike
}

/**
 * 发一个 GET 请求并返回解析后的 JSON。
 *
 * 泛型 T 是响应体的类型；调用方负责保证它与后端契约一致
 * （契约类型在 types/city.ts 里）。
 */
export async function apiGet<T = unknown>(
  path: string,
  { timeout = DEFAULT_TIMEOUT_MS, signal }: ApiGetOptions = {},
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  // 允许调用方传入自己的 signal 与我们的超时 controller 合并。
  // onAbort 必须留个引用：请求结束时要把监听器摘掉
  // （{ once: true } 只保证「不重复触发」，不保证「只挂一次」）。
  let onAbort: (() => void) | null = null
  if (signal) {
    if (signal.aborted) controller.abort()
    onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const response = await fetch(path, { signal: controller.signal })
    if (!response.ok) {
      let body: unknown = null
      try { body = await response.json() } catch { /* body 不可 JSON */ }
      throw new ApiError(
        `HTTP ${response.status} ${response.statusText} for ${path}`,
        { status: response.status, body },
      )
    }
    // response.json() 的返回值没有类型信息，收到 unknown 再断言成调用方要的 T。
    const payload: unknown = await response.json()
    return payload as T
  } catch (err) {
    if (err instanceof ApiError) throw err
    // 抛出的值未必是 Error 实例（fetch 抛 TypeError，部分环境抛 DOMException），
    // 所以按结构取 name / message，取不到就是 undefined。
    const thrown = err as { name?: unknown; message?: unknown }
    if (thrown.name === 'AbortError') {
      throw new ApiError(`请求超时或被中止: ${path}`, { status: 0 })
    }
    throw new ApiError(`网络错误: ${thrown.message}`, { status: 0 })
  } finally {
    clearTimeout(timer)
    // 请求结束时摘掉监听器：{ once: true } 只在**触发**时自动摘除，
    // 请求正常结束的话监听器会一直挂在调用方的 signal 上。
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}
