import json
import shutil
import sys
import threading
from pathlib import Path

import pytest

from codeagent.budget import Budget
from codeagent.checks import UniqueKeyLoader, clean_environment, compose_port_conflicts, run_command, validate
from codeagent.engine import Agent
from codeagent.provider import Cancelled, TruncatedOutput
from codeagent.safety import Redactor
from codeagent.tools import Toolset


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


def test_static_check_rejects_noop_build(tmp_path):
    (tmp_path / "package.json").write_text('{"scripts":{"test":"node --test","build":"echo success"}}')
    result = validate(tmp_path, "static", threading.Event())
    manifest = next(r for r in result["results"] if r["check"] == "package.json")
    assert manifest["status"] == "failed"
    assert "build" in manifest["error"]


def test_yaml_duplicate_environment_keys_are_rejected(tmp_path):
    (tmp_path / "compose.yaml").write_text("services:\n  app:\n    environment:\n      A: one\n    environment:\n      B: two\n", encoding="utf-8")
    report = validate(tmp_path, "static", threading.Event())
    result = next(r for r in report["results"] if r["check"] == "compose.yaml")
    assert result["status"] == "failed"
    assert "duplicate mapping key" in result["error"]


def test_yaml_merge_override_is_valid_but_host_port_collision_is_not():
    import yaml
    data = yaml.load("base: &base {A: one}\nmerged: {<<: *base, A: two}\n", Loader=UniqueKeyLoader)
    assert data["merged"]["A"] == "two"
    with pytest.raises(ValueError, match="端口冲突"):
        compose_port_conflicts({"services": {"a": {"ports": ["9090:9090"]}, "b": {"ports": ["127.0.0.1:9090:9090"]}}})
    compose_port_conflicts({"services": {"a": {"ports": ["9090:9090/tcp"]}, "b": {"ports": ["9090:9090/udp"]}}})


def test_seed_resume_preserves_original_without_network(tmp_path):
    arch, view = tmp_path / "arch.md", tmp_path / "view.md"
    arch.write_text("# Architecture\nFixture\n")
    view.write_text("```plantuml\n@startuml\nclass X\n@enduml\n```")
    seed = tmp_path / "previous/project"
    seed.mkdir(parents=True)
    files = {"plan.json": '{"tasks":[{"id":"done","files":["already.js"]}]}',
             "already.js": "const existing = 1;", "already.test.js": "// fixture",
             "package.json": '{"scripts":{"test":"node --test","build":"node --check already.js"}}',
             "README.md": "fixture", "internal.proto": 'syntax = "proto3";', "openapi.yaml": "openapi: 3.0.3",
             "traceability.json": '{"items":[{"id":"F1","source":{"document":"arch.md","start_line":1},"files":["already.js"],"tests":["already.test.js"],"status":"implemented"}]}'}
    for name, content in files.items():
        (seed / name).write_text(content, encoding="utf-8")
    provider = ReplayProvider(tmp_path)
    run, report = Agent(provider, threading.Event()).run(arch, view, tmp_path / "runs", seed_project=seed)
    assert report["status"] == "completed_with_gaps"
    assert provider.position == 0
    assert (seed / "already.js").read_text() == (run / "project/already.js").read_text()
    manifest = json.loads((run / "artifacts/seed-manifest.json").read_text(encoding="utf-8"))
    assert len(manifest["files"]) == len(files)
    assert manifest["source_project"] == str(seed)
    provider.add("read_file", {"path": "already.js"})
    provider.add("edit_file", {"path": "already.js", "old": "const existing = 1;", "new": "const existing = 2;"})
    provider.done()
    revised, revised_report = Agent(provider, threading.Event()).run(arch, view, tmp_path / "runs", seed_project=seed,
        review_feedback=[{"profile": "independent_example", "details": "For this offline fixture, change existing from 1 to 2."}])
    assert revised_report["repair_rounds"] == 1
    assert (seed / "already.js").read_text() == "const existing = 1;"
    assert (revised / "project/already.js").read_text() == "const existing = 2;"
    external = next(c for c in revised_report["checks"] if c["profile"] == "external_review_retest")
    assert external["status"] == "unverified"


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
def test_candidate_syntax_failure_drives_rewrite_before_commit(tmp_path):
    arch, view = tmp_path / "arch.md", tmp_path / "view.md"
    arch.write_text("# Architecture\nA small fixture.\n", encoding="utf-8")
    view.write_text("```plantuml\n@startuml\nclass Test\n@enduml\n```", encoding="utf-8")
    provider = ReplayProvider(tmp_path)
    targets = ["package.json", "README.md", "openapi.yaml", "internal.proto", "math.js", "math.test.js", "traceability.json"]
    provider.add("write_file", {"path": "plan.json", "content": json.dumps({"tasks": [{"id": "T1", "files": targets}]})})
    provider.done()
    files = {"package.json": '{"scripts":{"test":"node --test","build":"node --check math.js"}}',
             "README.md": "Offline test fixture, never a real generation example.", "openapi.yaml": "openapi: 3.0.3\n", "internal.proto": 'syntax = "proto3";',
             "math.js": "function broken( {", "math.test.js": "// fixture syntax check\n",
             "traceability.json": json.dumps({"items": [{"id": "T1", "source": {"document": "arch.md", "start_line": 1}, "files": ["math.js"], "tests": ["math.test.js"], "status": "implemented"}]})}
    for path, content in files.items():
        provider.add("write_file", {"path": path, "content": content})
        if path == "math.js":
            provider.add("write_file", {"path": "math.js", "content": "function fixed() { return 1; }"})
    provider.done()
    agent = Agent(provider, threading.Event())
    run, report = agent.run(arch, view, tmp_path / "runs")
    assert report["repair_rounds"] == 0
    assert report["status"] == "completed_with_gaps"
    first = json.loads((run / "artifacts/checks-0.json").read_text(encoding="utf-8"))
    assert first[0]["status"] == "passed"
    journals = [json.loads(p.read_text(encoding="utf-8")) for p in (run / "artifacts/candidates").glob("*/journal.json")]
    rejected = [c for c in journals if c["status"] == "rejected"]
    assert len(rejected) == 1
    assert rejected[0]["changes"][0]["path"] == "math.js"
    assert (run / "project/math.js").read_text() == "function fixed() { return 1; }"
    assert not report["uses_official_endpoint"]
    # Every tool result is paired with a preceding assistant tool call.
    for messages in provider.messages:
        pending = set()
        for message in messages:
            if message["role"] == "assistant":
                pending.update(c["id"] for c in message.get("tool_calls", []))
            if message["role"] == "tool":
                assert message["tool_call_id"] in pending
                pending.remove(message["tool_call_id"])


def test_task_completing_on_last_turn_does_not_fail(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    provider = ReplayProvider(tmp_path)
    provider.add("write_file", {"path": "last.js", "content": "const done = true;"})
    agent = Agent(provider, threading.Event())
    agent.run_dir = tmp_path / "run"
    (agent.run_dir / "artifacts").mkdir(parents=True)
    tools = Toolset(project, agent.cancel, Redactor())
    agent.phase_loop("generation", tools, limit=1, task={"id": "last", "files": ["last.js"]})
    assert (project / "last.js").is_file()
    assert provider.position == 1


def test_task_limit_yields_progress_for_remaining_file_retry(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    (project / "dependency.js").write_text("const existing = 1;")
    provider = ReplayProvider(tmp_path)
    provider.add("read_file", {"path": "dependency.js"})
    provider.add("write_file", {"path": "remaining.js", "content": "const completed = true;"})
    agent = Agent(provider, threading.Event())
    agent.run_dir = tmp_path / "run"
    (agent.run_dir / "artifacts").mkdir(parents=True)
    tools = Toolset(project, agent.cancel, Redactor())
    task = {"id": "partial", "files": ["remaining.js"]}
    agent.phase_loop("generation", tools, limit=1, task=task)
    assert not (project / "remaining.js").exists()
    agent.phase_loop("generation", tools, limit=1, task=task)
    assert (project / "remaining.js").is_file()


def test_truncated_output_retries_without_executing_partial_calls(tmp_path):
    class TruncatingFixture(ReplayProvider):
        attempts = 0
        def complete(self, messages, tools):
            self.attempts += 1
            if self.attempts == 1:
                raise TruncatedOutput("fixture truncation")
            assert any("NONE of its tool calls" in (m.get("content") or "") for m in messages)
            return super().complete(messages, tools)
    project = tmp_path / "project"
    project.mkdir()
    provider = TruncatingFixture(tmp_path)
    provider.add("write_file", {"path": "complete.js", "content": "const complete = true;"})
    agent = Agent(provider, threading.Event())
    agent.run_dir = tmp_path / "run"
    (agent.run_dir / "artifacts").mkdir(parents=True)
    agent.phase_loop("generation", Toolset(project, agent.cancel, Redactor()), 2, task={"id": "truncated", "files": ["complete.js"]})
    assert provider.attempts == 2
    assert provider.position == 1
    assert (project / "complete.js").read_text() == "const complete = true;"


@pytest.mark.parametrize("profile", ["test", "integration"])
def test_repair_feedback_groups_real_node_failure_sections(profile):
    checks = [{"profile": profile, "status": "failed", "output": "summary\ntest at shared/auth.test.js:12:1\nSignature failure\ntest at services/admin.test.js:30:1\nValidation failure\n"},
              {"profile": "auth", "status": "failed", "output": "wrong signature accepted"},
              {"profile": "static", "status": "failed", "results": [{"check": "compose.yaml", "status": "failed", "error": "duplicate environment"}, {"check": "fine.js", "status": "passed"}]}]
    groups = Agent.repair_groups(checks)
    assert len(groups) == 3
    assert groups[0][0]["target"] == "compose.yaml"
    assert [c["profile"] for c in groups[1]] == [profile, "auth"]
    assert groups[2][0]["target"] == "services/admin.test.js"
