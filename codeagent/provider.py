import json
import queue
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from .budget import Budget
from .safety import Redactor

API_ROOT = "https://api.deepseek.com"
MODEL = "deepseek-v4-pro"
REQUEST_DEADLINE_SECONDS = 300


def validate_endpoint(provider: str, base_url: str) -> str:
    parsed = urlsplit(base_url)
    host = parsed.hostname or ""
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.port not in (None, 443):
        raise ValueError("API 地址必须为不含凭证、查询参数的 HTTPS 地址")
    if provider == "deepseek":
        if base_url.rstrip("/") not in (API_ROOT, API_ROOT + "/v1"):
            raise ValueError("官方模式仅支持 DeepSeek 官方地址")
    elif provider == "bailian":
        allowed = host in {"dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"} or host.endswith(".maas.aliyuncs.com")
        if not allowed or parsed.path.rstrip("/") != "/compatible-mode/v1":
            raise ValueError("百炼模式需要阿里云官方 OpenAI 兼容 Base URL")
    else:
        raise ValueError("未知平台")
    return base_url.rstrip("/")


class Cancelled(RuntimeError):
    pass


class ProviderError(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class DeepSeek:
    def __init__(self, api_key: str, budget: Budget, cancel: threading.Event, *, pricing_confirmed=False,
                 provider="deepseek", base_url=API_ROOT, model=MODEL):
        if not api_key.strip() or any(c.isspace() for c in api_key.strip()):
            raise ValueError("请配置有效的 DeepSeek API Key")
        if not pricing_confirmed:
            raise ValueError("请先核对官方当前价格，并确认预算计价上界仍然有效")
        self.api_key, self.budget, self.cancel = api_key.strip(), budget, cancel
        self.base_url = validate_endpoint(provider, base_url)
        if model not in {"deepseek-v4-pro", "deepseek-v4-pro-0813"}:
            raise ValueError("本作业仅支持 DeepSeek V4 Pro 系列模型")
        self.provider, self.model = provider, model
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.calls = 0
        self.usage = []

    def _request(self, request):
        """A wall-clock deadline, in addition to urllib's per-socket timeout.

        Cancellation leaves the prepaid reservation intact if no response is known.
        A daemon reader cannot hold the desktop process open after cancellation.
        """
        delivered = queue.Queue(maxsize=1)

        def receive():
            try:
                with self.opener.open(request, timeout=REQUEST_DEADLINE_SECONDS) as response:
                    raw = response.read(2_000_001)
                    if len(raw) > 2_000_000:
                        raise ValueError("API response exceeds size limit")
                    data = json.loads(raw)
                delivered.put((data, None))
            except Exception as exc:
                delivered.put((None, exc))

        threading.Thread(target=receive, daemon=True).start()
        deadline = time.monotonic() + REQUEST_DEADLINE_SECONDS
        while True:
            try:
                data, error = delivered.get(timeout=0.1)
                if error:
                    raise error
                return data
            except queue.Empty:
                if self.cancel.is_set():
                    raise Cancelled("请求已取消；响应费用不确定，保留预留")
                if time.monotonic() >= deadline:
                    raise TimeoutError("API wall-clock deadline exceeded")

    def complete(self, messages, tools=None, max_tokens=8192):
        payload = {"model": self.model, "messages": messages, "max_tokens": max_tokens, "stream": False}
        if self.provider == "deepseek":
            payload["thinking"] = {"type": "disabled"}
        else:
            payload["enable_thinking"] = False
        if tools:
            payload["tools"] = tools
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        # UTF-8 byte count is intentionally much more conservative than a chars/4 estimate.
        # Extra margin covers protocol/template tokens. Reject instead of silent truncation.
        input_bound = len(body) + 4096
        if input_bound > 240_000:
            raise ProviderError("上下文达到本工具上限；已停止，文件及日志仍保留")
        for attempt in range(3):
            if self.cancel.is_set():
                raise Cancelled("用户取消")
            reservation = self.budget.reserve(input_bound, max_tokens)
            request = urllib.request.Request(self.base_url + "/chat/completions", data=body,
                                             headers={"Authorization": "Bearer " + self.api_key,
                                                      "Content-Type": "application/json"})
            self.calls += 1
            try:
                data = self._request(request)
            except urllib.error.HTTPError as exc:
                # Keep the reservation: even server-side errors have uncertain billing semantics.
                if exc.code in (429, 500, 502, 503, 504) and attempt < 2:
                    if self.cancel.wait(2 ** (attempt + 1)):
                        raise Cancelled("用户取消")
                    continue
                label = {401: "API Key 无效", 402: "账户余额不足", 403: "访问被拒绝", 429: "请求限流"}.get(exc.code, "API 请求失败")
                try:
                    detail = exc.read(4096).decode("utf-8", errors="replace")
                    error_data = json.loads(detail)
                    if isinstance(error_data, dict):
                        detail = str(error_data.get("error", error_data))
                except (OSError, ValueError, AttributeError):
                    detail = ""
                detail = Redactor(self.api_key).text(detail)[:600]
                raise ProviderError(f"{label}（HTTP {exc.code}）；不确定费用已保留。{detail}") from None
            except (OSError, ValueError) as exc:
                raise ProviderError("连接超时、网络或 JSON 响应异常；为避免重复计费未自动重发。费用预留已保留") from exc
            usage = data.get("usage", {})
            cost = self.budget.settle(reservation, usage)
            self.usage.append({"usage": usage, "estimated_cny": cost})
            if self.cancel.is_set():
                raise Cancelled("用户取消；本次响应用量已记录")
            try:
                if data.get("model") and not data["model"].startswith(MODEL):
                    raise ProviderError("服务端返回了非指定模型，停止任务")
                choice = data["choices"][0]
                message = choice["message"]
                if choice["finish_reason"] == "length":
                    raise ProviderError("模型输出被截断；未执行本次工具调用，请缩小单文件规模后重新运行")
                if choice["finish_reason"] not in ("stop", "tool_calls") or message.get("role") != "assistant":
                    raise ProviderError("API 返回了不支持的结束状态")
                return {k: v for k, v in message.items() if k in {"role", "content", "tool_calls"}}
            except (KeyError, IndexError, TypeError):
                raise ProviderError("API 响应缺少必要字段") from None

    def test_connection(self):
        result = self.complete([{"role": "user", "content": "Reply OK."}], max_tokens=32)
        return {"provider": self.provider, "model": self.model, "reply": result.get("content"), "budget": self.budget.snapshot()}
