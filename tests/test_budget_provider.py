import io
import json
import threading
import urllib.error

import pytest

from codeagent.budget import Budget, BudgetError, Prices
from codeagent.provider import Cancelled, DeepSeek, ProviderError, validate_endpoint


def test_persistent_budget_and_unknown_charges(tmp_path):
    ledger = tmp_path / "budget.json"
    budget = Budget(ledger, 0.1, Prices(10, 20))
    key = budget.reserve(1000, 1000)
    assert Budget(ledger, 0.1).snapshot()["charged_cny"] == pytest.approx(0.03)
    assert budget.snapshot()["uncertain_requests"] == 1
    budget.settle(key, {"prompt_tokens": 100, "completion_tokens": 200})
    assert budget.snapshot()["charged_cny"] == pytest.approx(0.005)
    with pytest.raises(BudgetError):
        budget.reserve(10000, 10000)
    unknown = budget.reserve(1000, 1000)
    with pytest.raises(BudgetError):
        budget.settle(unknown, {})
    assert budget.snapshot()["uncertain_requests"] == 1


def test_bad_budget_and_corrupt_ledger_fail_closed(tmp_path):
    for value in (0, -1, 201, float("nan"), float("inf")):
        with pytest.raises(ValueError):
            Budget(tmp_path / "budget.json", value)
    ledger = tmp_path / "budget.json"
    ledger.write_text('{"schema_version":1,"reservations":{"bad":{"charged":-5}}}')
    with pytest.raises(BudgetError):
        Budget(ledger).reserve(100, 100)


@pytest.mark.parametrize("url", ["http://api.deepseek.com", "https://evil.com", "https://dashscope.aliyuncs.com.evil.com/compatible-mode/v1", "https://user:pass@dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope.aliyuncs.com/api/v1", "https://dashscope.aliyuncs.com:444/compatible-mode/v1"])
def test_reject_wrong_bailian_endpoint(url):
    with pytest.raises(ValueError):
        validate_endpoint("bailian", url)


class Response(io.BytesIO):
    def __init__(self, data):
        super().__init__(json.dumps(data).encode())


def make_provider(tmp_path):
    return DeepSeek("sk-test-placeholder-only", Budget(tmp_path / "budget.json"), threading.Event(), pricing_confirmed=True)


def response(reason="stop", usage=True):
    data = {"model": "deepseek-v4-pro", "choices": [{"finish_reason": reason, "message": {"role": "assistant", "content": "OK"}}]}
    if usage:
        data["usage"] = {"prompt_tokens": 10, "completion_tokens": 2}
    return data


def test_provider_sends_tools_and_records_usage(tmp_path):
    provider = make_provider(tmp_path)
    seen = []
    def open_request(req, timeout):
        seen.append(json.loads(req.data))
        assert req.full_url == "https://api.deepseek.com/chat/completions"
        assert timeout == 300
        return Response(response())
    provider.opener.open = open_request
    assert provider.test_connection()["reply"] == "OK"
    assert seen[0]["thinking"] == {"type": "disabled"}
    assert provider.budget.snapshot()["uncertain_requests"] == 0


def test_bailian_has_distinct_protocol(tmp_path):
    provider = DeepSeek("placeholder", Budget(tmp_path / "budget.json"), threading.Event(), pricing_confirmed=True,
                        provider="bailian", base_url="https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1")
    def open_request(req, timeout):
        payload = json.loads(req.data)
        assert payload["enable_thinking"] is False and "thinking" not in payload
        return Response(response())
    provider.opener.open = open_request
    assert provider.test_connection()["provider"] == "bailian"


def test_retry_limit_auth_and_cancellation(tmp_path, monkeypatch):
    provider = make_provider(tmp_path)
    monkeypatch.setattr(provider.cancel, "wait", lambda _: False)
    def limited(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 429, "limited", {}, None)
    provider.opener.open = limited
    with pytest.raises(ProviderError, match="限流"):
        provider.test_connection()
    assert provider.calls == 3
    assert provider.budget.snapshot()["uncertain_requests"] == 3
    provider.cancel.set()
    with pytest.raises(Cancelled):
        provider.test_connection()
    assert provider.calls == 3


@pytest.mark.parametrize("reason,usage,match", [("length", True, "截断"), ("stop", False, "usage")])
def test_missing_usage_or_truncation_stops(tmp_path, reason, usage, match):
    provider = make_provider(tmp_path)
    provider.opener.open = lambda *a, **k: Response(response(reason, usage))
    with pytest.raises(RuntimeError, match=match):
        provider.test_connection()


def test_cancel_after_response_still_settles(tmp_path):
    provider = make_provider(tmp_path)
    def deliver(*a, **k):
        provider.cancel.set()
        return Response(response())
    provider.opener.open = deliver
    with pytest.raises(Cancelled):
        provider.test_connection()
    assert provider.budget.snapshot()["uncertain_requests"] == 0


def test_wall_clock_deadline_retains_reservation(tmp_path, monkeypatch):
    import codeagent.provider as module
    provider = make_provider(tmp_path)
    gate = threading.Event()
    def stalled(*a, **k):
        gate.wait(3)
        return Response(response())
    provider.opener.open = stalled
    monkeypatch.setattr(module, "REQUEST_DEADLINE_SECONDS", 0.01)
    try:
        with pytest.raises(ProviderError, match="超时"):
            provider.test_connection()
        assert provider.budget.snapshot()["uncertain_requests"] == 1
    finally:
        gate.set()


def test_cancel_inflight_returns_without_resending(tmp_path):
    provider = make_provider(tmp_path)
    gate = threading.Event()
    def stalled(*a, **k):
        gate.wait(3)
        return Response(response())
    provider.opener.open = stalled
    timer = threading.Timer(0.02, provider.cancel.set)
    timer.start()
    try:
        with pytest.raises(Cancelled):
            provider.test_connection()
        assert provider.budget.snapshot()["uncertain_requests"] == 1
        assert provider.calls == 1
    finally:
        gate.set()
        timer.join()
