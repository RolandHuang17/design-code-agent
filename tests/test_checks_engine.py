import json
import shutil
import sys
import threading
from pathlib import Path

import pytest

from codeagent.budget import Budget
from codeagent.checks import clean_environment, run_command, validate
from codeagent.engine import Agent
from codeagent.provider import Cancelled


def test_environment_omits_keys_and_runtime_injection(monkeypatch):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "private")
    monkeypatch.setenv("NODE_OPTIONS", "--require malicious.js")
    env = clean_environment()
    assert "DASHSCOPE_API_KEY" not in env
    assert "NODE_OPTIONS" not in env
    assert env["NPM_CONFIG_IGNORE_SCRIPTS"] == "true"


def test_timeout_cancellation_and_bounded_output(tmp_path):
    cancel = threading.Event()
    result = run_command([sys.executable, "-c", "import time; print('x'*100000, flush=True); time.sleep(5)"], tmp_path, cancel, timeout=0.3)
    assert result["timed_out"] and result["status"] == "failed"
    assert len(result["output"]) <= 32000
    cancel.set()
    with pytest.raises(Cancelled):
        run_command([sys.executable, "-c", "import time; time.sleep(5)"], tmp_path, cancel)


def test_execution_is_explicitly_opt_in(tmp_path):
    (tmp_path / "package.json").write_text('{"scripts":{"test":"exit 99"}}')
    assert validate(tmp_path, "test", threading.Event())["status"] == "unverified"


@pytest.mark.skipif(not shutil.which("node"), reason="Node required")
def test_static_check_resolves_relative_project_paths(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    project = Path("relative run/中文 项目")
    project.mkdir(parents=True)
    (project / "good.js").write_text("function valid() {}", encoding="utf-8")
    result = validate(project, "static", threading.Event())
    source = next(r for r in result["results"] if r["check"] == "good.js")
    assert source["status"] == "passed"


class ReplayProvider:
    """A scripted offline fixture ONLY. It cannot produce a real API run."""
    api_key = "fixture-key"
    provider = "offline-test-fixture"
    base_url = "not-a-network-endpoint"
    model = "scripted-fixture"
    def __init__(self, tmp_path):
        self.budget = Budget(tmp_path / "budget.json")
        self.usage = []
        self.position = 0
        self.messages = []
        self.replies = []

    def add(self, name, args):
        self.replies.append({"role": "assistant", "content": None, "tool_calls": [
            {"id": str(len(self.replies)), "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]})

    def done(self):
        self.replies.append({"role": "assistant", "content": "Fixture phase complete"})

    def complete(self, messages, tools):
        self.messages.append(messages.copy())
        value = self.replies[self.position]
        self.position += 1
        return value


@pytest.mark.skipif(not shutil.which("node"), reason="Node syntax check is required for this regression")
def test_actual_static_failure_drives_read_edit_recheck(tmp_path):
    arch, view = tmp_path / "arch.md", tmp_path / "view.md"
    arch.write_text("# Architecture\nA small fixture.\n", encoding="utf-8")
    view.write_text("```plantuml\n@startuml\nclass Test\n@enduml\n```", encoding="utf-8")
    provider = ReplayProvider(tmp_path)
    provider.add("write_file", {"path": "plan.json", "content": '{"tasks":[{"id":"T1"}]}'})
    provider.done()
    files = {"package.json": '{"scripts":{"test":"node --test","build":"node --check math.js"}}',
             "README.md": "Offline test fixture, never a real generation example.", "openapi.yaml": "openapi: 3.0.3\n", "internal.proto": 'syntax = "proto3";',
             "math.js": "function broken( {", "math.test.js": "// fixture syntax check\n",
             "traceability.json": json.dumps({"items": [{"id": "T1", "source": {"document": "arch.md", "start_line": 1}, "files": ["math.js"], "tests": ["math.test.js"], "status": "implemented"}]})}
    for path, content in files.items():
        provider.add("write_file", {"path": path, "content": content})
    provider.done()
    provider.add("read_file", {"path": "math.js"})
    provider.add("edit_file", {"path": "math.js", "old": "function broken( {", "new": "function fixed() { return 1; }"})
    provider.done()
    agent = Agent(provider, threading.Event())
    run, report = agent.run(arch, view, tmp_path / "runs")
    assert report["repair_rounds"] == 1
    assert report["status"] == "completed_with_gaps"
    first = json.loads((run / "artifacts/checks-0.json").read_text(encoding="utf-8"))
    second = json.loads((run / "artifacts/checks-1.json").read_text(encoding="utf-8"))
    assert first[0]["status"] == "failed"
    assert second[0]["status"] == "passed"
    assert (run / "artifacts/revisions/0006/math.js").read_text() == "function broken( {"
    assert (run / "project/math.js").read_text() == "function fixed() { return 1; }"
    assert not report["official_api_compliant"]
    # Every tool result is paired with a preceding assistant tool call.
    for messages in provider.messages:
        pending = set()
        for message in messages:
            if message["role"] == "assistant":
                pending.update(c["id"] for c in message.get("tool_calls", []))
            if message["role"] == "tool":
                assert message["tool_call_id"] in pending
                pending.remove(message["tool_call_id"])
