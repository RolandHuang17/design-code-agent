import json
import threading

import pytest

from codeagent.provider import Cancelled
from codeagent.safety import Redactor
from codeagent.tools import Toolset


def make_tools(tmp_path, callback):
    (tmp_path / "compose.yaml").write_text("services: {gateway: {image: node:22}}")
    tools = Toolset(tmp_path, threading.Event(), Redactor("private-secret"), runtime_check=callback)
    tools.phase = "repair"
    return tools


def runtime(tools):
    return tools.execute("run_check", '{"profile":"runtime"}')


def test_repair_reuses_latest_full_bound_redacted_evidence_after_two_callbacks(tmp_path):
    calls = []
    def check():
        calls.append(1)
        return {"profile": "runtime", "status": "failed", "error": f"attempt {len(calls)}", "stages": [
            {"stage": ["inspect"], "output": "unhealthy private-secret", "nested": {"exit": 127}}]}
    tools = make_tools(tmp_path, check)
    first, latest = runtime(tools), runtime(tools)
    reused = runtime(tools)
    assert len(calls) == 2 and first["error"] == "attempt 1" and reused["error"] == "attempt 2"
    assert reused["runtime_reused"] is True and "unchanged snapshot" in reused["runtime_suppression_note"]
    assert reused["stages"] == latest["stages"] and reused["snapshot_id"] == latest["snapshot_id"]
    assert reused["snapshot_after"] == latest["snapshot_after"] and reused["stale"] is False
    assert "private-secret" not in json.dumps(reused) and "[REDACTED]" in json.dumps(reused)
    reused["stages"][0]["nested"]["exit"] = 0
    assert runtime(tools)["stages"][0]["nested"]["exit"] == 127
    assert len(calls) == 2 and len(tools.check_history) == 4


def test_real_config_change_gets_new_attempts_and_reverting_preserves_old_limit(tmp_path):
    calls = []
    tools = make_tools(tmp_path, lambda: calls.append(1) or {"profile": "runtime", "status": "failed"})
    old_config = (tmp_path / "compose.yaml").read_text()
    original = runtime(tools)
    runtime(tools)
    (tmp_path / "compose.yaml").write_text(old_config + "\n# corrected healthcheck")
    changed = runtime(tools)
    assert len(calls) == 3 and changed["snapshot_id"] != original["snapshot_id"]
    assert "runtime_reused" not in changed
    (tmp_path / "compose.yaml").write_text(old_config)
    assert runtime(tools)["runtime_reused"] is True and len(calls) == 3


def test_host_verification_always_runs_and_does_not_consume_or_replace_repair_evidence(tmp_path):
    calls = []
    def check():
        calls.append(1)
        return {"profile": "runtime", "status": "passed" if len(calls) > 4 else "failed", "attempt": len(calls)}
    tools = make_tools(tmp_path, check)
    tools.phase = "verification"
    for _ in range(3):
        assert "runtime_reused" not in runtime(tools)
    tools.phase = "repair"
    runtime(tools)
    latest = runtime(tools)
    assert len(calls) == 5 and runtime(tools)["attempt"] == latest["attempt"]
    tools.phase = "verification"
    for _ in range(3):
        assert runtime(tools)["status"] == "passed"
    assert len(calls) == 8
    tools.phase = "repair"
    assert runtime(tools)["attempt"] == 5 and len(calls) == 8


def test_cancellation_propagates_without_consuming_attempt_or_caching_result(tmp_path):
    calls = []
    def check():
        calls.append(1)
        if len(calls) in (1, 3):
            raise Cancelled("cancelled")
        return {"profile": "runtime", "status": "failed", "attempt": len(calls)}
    tools = make_tools(tmp_path, check)
    with pytest.raises(Cancelled):
        runtime(tools)
    assert tools.check_history == [] and tools._repair_runtime_checks == {}
    runtime(tools)
    with pytest.raises(Cancelled):
        runtime(tools)
    assert len(tools.check_history) == 1
    assert runtime(tools)["attempt"] == 4
    assert runtime(tools)["runtime_reused"] is True and len(calls) == 4


def test_other_profiles_are_never_suppressed(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr("codeagent.tools.validate", lambda root, profile, *args, **kwargs:
                        calls.append(profile) or {"profile": profile, "status": "passed"})
    tools = make_tools(tmp_path, lambda: pytest.fail("runtime callback should not run"))
    for profile in ("static", "test", "install"):
        for _ in range(3):
            assert tools.execute("run_check", json.dumps({"profile": profile}))["status"] == "passed"
    assert len(calls) == 9 and tools._repair_runtime_checks == {}


def test_callback_errors_are_bound_and_cannot_trigger_unlimited_retries(tmp_path):
    calls = []
    def check():
        calls.append(1)
        raise OSError("Docker unavailable private-secret")
    tools = make_tools(tmp_path, check)
    runtime(tools)
    latest = runtime(tools)
    reused = runtime(tools)
    assert len(calls) == 2 and reused["runtime_reused"] is True
    assert reused["status"] == "failed" and reused["snapshot_id"] == latest["snapshot_id"]
    assert reused["error"] == "Docker unavailable [REDACTED]"


def test_cancellation_event_set_by_callback_does_not_cache_its_result(tmp_path):
    calls = []
    def check():
        calls.append(1)
        if len(calls) == 1:
            tools.cancel.set()
        return {"profile": "runtime", "status": "failed"}
    tools = make_tools(tmp_path, check)
    with pytest.raises(Cancelled):
        runtime(tools)
    assert not tools._repair_runtime_checks and not tools.check_history
    tools.cancel.clear()
    runtime(tools)
    runtime(tools)
    assert runtime(tools)["runtime_reused"] is True and len(calls) == 3
