"""极简的 HTTP JSON 客户端 —— **只用标准库**。

为什么不用 requests / httpx
---------------------------
不新增任何依赖（``requirements.txt`` 零改动是硬要求）。
上游只有三个 JSON 接口，标准库的 ``urllib.request`` 足够。

设计要点
--------
- 任何失败（连接被重置、超时、非 200、响应不是 JSON）都抛
  :class:`SourceUnavailable` —— 上层只需要一种异常类型，
  不必逐个捕获 socket / http.client / json 的异常。
- 响应体**一律按 UTF-8 解码**：中国天气网的 ``sk`` 接口返回的是
  ``text/html``（没有 charset），按 latin-1 解会得到乱码。
- 自带 User-Agent，说明用途与出处（上游据此判断是不是机器人）。
"""
import json
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

# 单个上游请求的默认超时（秒）。与聚合器给每个源的总预算同量级：
# 源级超时是「整个源」的预算，单次请求的超时要比它略小，
# 这样「卡在某一个请求上」不会耗尽整个源的预算。
DEFAULT_TIMEOUT_SECONDS = 5.0

# User-Agent：写清用途与出处，别伪装成浏览器。
USER_AGENT = "smart-city-backend/1.0 (+https://github.com/Echovagant/smart-city)"


class SourceUnavailable(Exception):
    """取不到上游数据。

    触发条件：连接失败、超时、非 2xx、响应体不是 JSON。
    上层把它当成「这个源降级」处理，**不**当成服务错误。
    """


def request_json(
    url: str,
    *,
    method: str = "GET",
    headers: Optional[Dict[str, str]] = None,
    data: Optional[bytes] = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> Any:
    """请求一个 JSON 接口并返回解析后的结果。

    失败一律抛 :class:`SourceUnavailable`（不把 urllib 的异常类型漏给上层）。
    """
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("User-Agent", USER_AGENT)
    for name, value in (headers or {}).items():
        request.add_header(name, value)

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            # 没有 charset 时按 UTF-8 解（上游全是 UTF-8 的中文 JSON）。
            charset = response.headers.get_content_charset() or "utf-8"
    except urllib.error.HTTPError as exc:
        raise SourceUnavailable("HTTP %s for %s" % (exc.code, url)) from exc
    except SourceUnavailable:
        raise
    except Exception as exc:  # 网络层的一切异常（超时、连接重置、DNS……）
        raise SourceUnavailable("%s for %s" % (type(exc).__name__, url)) from exc

    try:
        return json.loads(raw.decode(charset, errors="replace"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        # 典型场景：请求不存在的 cityid 时上游返回的是 HTML 错误页。
        raise SourceUnavailable("响应不是 JSON for %s" % url) from exc
