"""Owned startup failure diagnostics, using fake CLI responses only."""
import json
import threading

import pytest

from codeagent.engine import Agent
from codeagent.provider import Cancelled
from codeagent.runtime import validate_runtime
from codeagent.safety import Redactor


CONTAINER_ID = "a" * 64


def fake_runtime(tmp_path, monkeypatch, ps_output, *, diagnostic_error=None, inspect_output="{}", failed_verb=None):
    (tmp_path / "compose.yaml").write_text("services: {gateway: {}, keycloak: {}}")
    calls = []

    def run(argv, root, cancel, **kwargs):
        # Ensure all diagnostics use the real cancellation event, while cleanup
        # deliberately uses a separate event after cancellation.
        args = argv[argv.index("-f") + 2:] if "compose" in argv else argv[1:]
        calls.append((argv, args, cancel, kwargs))
        verb = args[0]
        output, status = "", "passed"
        if verb == "config":
            output = json.dumps({"services": {"gateway": {}, "keycloak": {}}})
        elif verb == "up":
            output, status = "dependency failed: keycloak is unhealthy", "failed"
        elif verb == "ps":
            if diagnostic_error:
                raise diagnostic_error
            output = ps_output
        elif verb == "inspect":
            output = inspect_output
        if verb == failed_verb:
            status, output = "failed", "command timed out"
        return {"status": status, "output": output, "exit_code": int(status == "failed"), "command": argv}

    monkeypatch.setattr("codeagent.runtime.shutil.which", lambda name: name)
    monkeypatch.setattr("codeagent.runtime.run_command", run)
    return calls


@pytest.mark.parametrize("encoding", ["array", "ndjson"])
def test_unhealthy_keycloak_state_reaches_evidence_and_model_feedback(tmp_path, monkeypatch, encoding):
    rows = [{"ID": CONTAINER_ID, "Service": "keycloak"}, {"ID": "b" * 12, "Service": "gateway"}]
    ps_output = json.dumps(rows) if encoding == "array" else "\n".join(json.dumps(row) for row in rows)
    state = {"Status": "exited", "ExitCode": 1, "Error": "healthcheck failed", "Health": {
        "Status": "unhealthy", "Log": [{"ExitCode": 127, "Output": "/bin/sh: curl: not found secret-token"}]}}
    calls = fake_runtime(tmp_path, monkeypatch, ps_output, inspect_output=json.dumps(state))
    cancel = threading.Event()
    result = validate_runtime(tmp_path, "library", tmp_path / "evidence", cancel, Redactor("secret-token"), backend="docker")
    assert result["status"] == "failed" and result["cleanup"] == "passed"
    assert result["error"] == "容器构建或启动失败，见 runtime 命令输出"
    diagnostic_calls = [call for call in calls if call[1][0] in ("ps", "inspect")]
    assert [call[1] for call in diagnostic_calls] == [
        ["ps", "--all", "--format", "json"],
        ["inspect", "--format", "{{json .State}}", CONTAINER_ID, "b" * 12]]
    assert all(call[2] is cancel and call[3]["timeout"] == 10 for call in diagnostic_calls)
    ps_argv = diagnostic_calls[0][0]
    assert ps_argv[ps_argv.index("-p") + 1] == result["project"]
    assert ps_argv[ps_argv.index("-f") + 1] == str(tmp_path / "evidence" / "compose.isolated.json")
    bounded = Agent.bounded_checks([result])[0]["details_excerpt"]
    assert "unhealthy" in bounded and "curl: not found" in bounded and "ExitCode" in bounded
    assert "secret-token" not in json.dumps(result) and "[REDACTED]" in bounded
    assert [call[1][0] for call in calls][-2:] == ["logs", "down"]


@pytest.mark.parametrize("output", [
    '{"ID":"--help"}', '{"ID":"keycloak"}', '{"ID":"abc123"}',
    '{"ID":123}', '[null]', '{}', 'not json',
    json.dumps([{"ID": CONTAINER_ID}, {"ID": "bad; docker ps"}]),
    json.dumps([{"ID": CONTAINER_ID, "Project": "unowned-project"}]),
    json.dumps([{"ID": f"{i:064x}"} for i in range(17)]),
])
def test_malformed_or_untrusted_ps_never_triggers_inspect(tmp_path, monkeypatch, output):
    calls = fake_runtime(tmp_path, monkeypatch, output)
    result = validate_runtime(tmp_path, "library", tmp_path / "evidence", threading.Event(), backend="docker")
    assert result["error"] == "容器构建或启动失败，见 runtime 命令输出"
    assert result["cleanup"] == "passed"
    assert not any(call[1][0] == "inspect" for call in calls)
    assert any(stage["stage"] == ["startup_diagnostics"] for stage in result["stages"])


def test_diagnostic_exception_is_secondary_to_original_start_error(tmp_path, monkeypatch):
    calls = fake_runtime(tmp_path, monkeypatch, "", diagnostic_error=OSError("inspect CLI unavailable"))
    result = validate_runtime(tmp_path, "library", tmp_path / "evidence", threading.Event(), backend="docker")
    assert result["error"] == "容器构建或启动失败，见 runtime 命令输出"
    assert any(stage.get("output") == "inspect CLI unavailable" for stage in result["stages"])
    assert [call[1][0] for call in calls][-2:] == ["logs", "down"]


def test_diagnostic_cancellation_propagates_and_still_cleans_up(tmp_path, monkeypatch):
    calls = fake_runtime(tmp_path, monkeypatch, "", diagnostic_error=Cancelled("cancelled"))
    cancel = threading.Event()
    with pytest.raises(Cancelled):
        validate_runtime(tmp_path, "library", tmp_path / "evidence", cancel, backend="docker")
    assert [call[1][0] for call in calls][-2:] == ["logs", "down"]
    assert all(call[2] is not cancel for call in calls[-2:])
    report = json.loads((tmp_path / "evidence" / "runtime-report.json").read_text(encoding="utf-8"))
    assert report["status"] == "cancelled" and report["cleanup"] == "passed"


@pytest.mark.parametrize("failed_verb", ["ps", "inspect"])
def test_failed_diagnostic_command_keeps_original_failure_and_cleanup(tmp_path, monkeypatch, failed_verb):
    calls = fake_runtime(tmp_path, monkeypatch, json.dumps([{"ID": CONTAINER_ID}]), failed_verb=failed_verb)
    result = validate_runtime(tmp_path, "library", tmp_path / "evidence", threading.Event(), backend="docker")
    assert result["error"] == "容器构建或启动失败，见 runtime 命令输出"
    assert result["cleanup"] == "passed"
    assert any(stage["stage"][0] == failed_verb and stage["status"] == "failed" for stage in result["stages"])
    if failed_verb == "ps":
        assert not any(call[1][0] == "inspect" for call in calls)


def test_inspect_root_cause_precedes_large_generic_up_output():
    result = {"profile": "runtime", "status": "failed", "stages": [
        {"stage": ["up"], "status": "failed", "output": "x" * 32000},
        {"stage": ["inspect", "--format", "{{json .State}}", CONTAINER_ID], "status": "passed", "output": "curl: not found"},
    ]}
    assert "curl: not found" in Agent.bounded_checks([result])[0]["details_excerpt"]
