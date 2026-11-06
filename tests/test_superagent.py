"""Deterministic mechanism tests; these are not real generation experiments."""
import json
import threading
from pathlib import Path

import pytest

from codeagent.superagent.runtime import Coordinator, UnknownRequest, snapshot
from codeagent.superagent.store import Store


def call(name, args):
    return {"role": "assistant", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}


TASKS = [
    {"id": "metadata", "description": "package and README", "files": ["package.json", "README.md"], "depends_on": []},
    {"id": "code", "description": "sum function", "files": ["sum.js"], "depends_on": []},
    {"id": "test", "description": "test function", "files": ["sum.test.js"], "depends_on": ["code"]},
]
FILES = {"package.json": '{"name":"prototype-test","version":"1.0.0","scripts":{"test":"node --test","build":"node --check sum.js"}}',
         "README.md": "# Sum\nRun npm test", "sum.js": "module.exports = (a,b) => a+b;",
         "sum.test.js": "const test=require('node:test'); const assert=require('node:assert/strict'); test('sum',()=>assert.equal(require('./sum')(1,2),3));"}
DOCUMENTS = {"documents": [{"filename": "a.md", "text": "Generate sum module and tests"}, {"filename": "b.md", "text": "sum(a,b) returns a+b"}]}


class Scripted:
    api_key = ""
    usage = []

    def __init__(self, role, seen):
        self.role, self.seen = role, seen

    def complete(self, messages, tools, max_tokens):
        self.seen.append(self.role)
        if self.role == "planner":
            return call("submit_plan", {"tasks": TASKS, "assumptions": []})
        if self.role == "reviewer":
            return call("submit_review", {"approved": True, "issues": []})
        task = next(t for t in TASKS if self.role == "coder-" + t["id"])
        return {"role": "assistant", "tool_calls": [{"id": f"write-{i}", "type": "function", "function": {"name": "write_file", "arguments": json.dumps({"path": f, "content": FILES[f]})}} for i, f in enumerate(task["files"])]}


def test_real_session_boundaries_and_durable_completed_work(tmp_path):
    seen = []
    c = Coordinator(tmp_path, lambda role, cancel: Scripted(role, seen))
    c.create(DOCUMENTS)
    result = c.run()
    assert result["state"] == "completed"
    assert result["verification"] == "unverified"  # execution was not authorized
    assert set(seen) == {"planner", "coder-metadata", "coder-code", "coder-test", "reviewer"}
    assert set(c.store.all("session")) == set(seen)
    assert all(t["state"] == "completed" for t in c.store.all("task").values())
    assert all((tmp_path / "project" / f).is_file() for f in FILES)
    assert len(c.store.all("attempt")) == 5
    c.close()
    c = Coordinator(tmp_path, lambda *args: pytest.fail("Completed model steps must not be resent"))
    assert c.run()["state"] == "completed"
    c.close()


def test_resource_versions_and_exact_unicode_paging(tmp_path):
    s = Store(tmp_path)
    first = s.resource("design", "一😀二abc")
    second = s.resource("design", "updated")
    assert first["resource"] != second["resource"]
    assert s.read(first["resource"], 0, 2)["text"] == "一😀"
    assert s.read(first["resource"], 2, 8)["text"] == "二abc"
    with pytest.raises(ValueError):
        s.read(first["resource"], -1)
    s.close()


def test_unknown_request_blocks_automatic_resend(tmp_path):
    class Broken:
        api_key = "secret-value"
        usage = []

        def complete(self, *args, **kwargs):
            raise OSError("secret-value network gone")

    c = Coordinator(tmp_path, lambda *args: Broken())
    c.create(DOCUMENTS)
    assert c.run()["state"] == "blocked"
    assert "secret-value" not in (tmp_path / "report.json").read_text()
    calls = len(c.store.all("attempt"))
    c.provider_factory = lambda *args: pytest.fail("Do not resend unknown request")
    assert c.run()["state"] == "blocked"
    assert len(c.store.all("attempt")) == calls
    c.acknowledge_recovery(abandon_unknown=True)
    assert all(a["state"] == "abandoned" for a in c.store.all("attempt").values())
    c.close()


def test_cancel_and_pause_leave_recoverable_state(tmp_path):
    c = Coordinator(tmp_path, lambda *args: pytest.fail("No model call while cancelled"))
    c.create(DOCUMENTS)
    c.cancel.set()
    assert c.run()["state"] == "cancelled"
    c.cancel.clear()
    c.pause_requested.set()
    assert c.run()["state"] == "pending"
    c.close()


def test_merge_rejects_stale_base(tmp_path):
    c = Coordinator(tmp_path, lambda *args: None)
    stage = tmp_path / "stages" / "code"
    stage.mkdir(parents=True)
    (stage / "sum.js").write_text("candidate")
    (c.project / "sum.js").write_text("concurrent change")
    c.store.put("stage", "code", {"hashes": {}})
    with pytest.raises(ValueError, match="Merge conflict"):
        c._merge(TASKS[1])
    assert (c.project / "sum.js").read_text() == "concurrent change"
    c.close()


def test_async_check_rejects_stale_result(tmp_path, monkeypatch):
    started, release = threading.Event(), threading.Event()

    def check(*args, **kwargs):
        started.set()
        release.wait(3)
        return {"status": "passed"}

    monkeypatch.setattr("codeagent.superagent.runtime.validate", check)
    c = Coordinator(tmp_path, lambda *args: None)
    (c.project / "a.js").write_text("1")
    job_id, future = c.submit_check("static")
    assert started.wait(3)
    (c.project / "a.js").write_text("2")
    release.set()
    assert future.result(timeout=3)["state"] == "stale"
    assert c.store.get("job", job_id)["state"] == "stale"
    c.close()


def test_single_owner_lease_requires_explicit_recovery(tmp_path):
    c = Coordinator(tmp_path, lambda *args: None)
    c.create(DOCUMENTS)
    c.store.put("run", "lease", "old-process")
    c.store.put("job", "orphan", {"state": "running", "snapshot": "old-source", "profile": "test"})
    with pytest.raises(RuntimeError, match="owned"):
        c.run()
    c.acknowledge_recovery()
    assert c.store.get("run", "lease") is None
    assert c.store.get("job", "orphan")["state"] == "interrupted"
    assert c.store.get("job", "orphan")["result"]["status"] == "unverified"
    c.close()


def test_reviewer_cannot_write_files(tmp_path):
    seen = []

    class Reviewer(Scripted):
        def complete(self, messages, tools, max_tokens):
            assert {t["function"]["name"] for t in tools} == {"read_resource", "submit_review"}
            if not any(m["role"] == "assistant" for m in messages):
                return call("write_file", {"path": "sum.js", "content": "bad"})
            assert "no write capability" in messages[-1]["content"]
            return call("submit_review", {"approved": True, "issues": [], "advisories": ["Optional operator review"]})

    c = Coordinator(tmp_path, lambda role, cancel: Reviewer(role, seen))
    c.create(DOCUMENTS)
    assert c._review()["approved"]
    assert not (c.project / "sum.js").exists()
    c.close()


def test_planner_rejects_windows_case_aliases(tmp_path):
    class Aliased(Scripted):
        def complete(self, *args, **kwargs):
            tasks = [dict(t, files=list(t["files"])) for t in TASKS]
            tasks[1]["files"] = ["README.MD"]
            return call("submit_plan", {"tasks": tasks, "assumptions": []})

    c = Coordinator(tmp_path, lambda role, cancel: Aliased(role, []))
    c.create(DOCUMENTS)
    result = c.run()
    assert result["state"] == "failed"
    assert c.store.get("run", "plan") is None
    assert not list(c.project.iterdir())
    c.close()


def test_batch_write_does_not_bypass_worker_ownership(tmp_path):
    class Intruder(Scripted):
        def complete(self, messages, tools, max_tokens):
            return call("apply_changes", {"changes": [{"path": "other.js", "content": "module.exports=1"}]})

    c = Coordinator(tmp_path, lambda role, cancel: Intruder(role, []))
    c.create(DOCUMENTS)
    with pytest.raises(RuntimeError, match="单会话轮次上限"):
        c._worker(TASKS[1])
    assert not (tmp_path / "stages" / "code" / "other.js").exists()
    c.close()


def test_retry_keeps_abandoned_request_evidence(tmp_path):
    seen = []
    c = Coordinator(tmp_path, lambda role, cancel: Scripted(role, seen))
    provider = Scripted("reviewer", seen)
    messages = [{"role": "user", "content": "review"}]
    c._call("reviewer", provider, messages, [])
    key, attempt = next(iter(c.store.all("attempt").items()))
    c.store.put("attempt", key, {**attempt, "state": "abandoned", "reason": "operator acknowledged uncertain request"})
    c._call("reviewer", provider, messages, [])
    assert len(c.store.all("attempt")) == 2
    assert any(a["state"] == "abandoned" for a in c.store.all("attempt").values())
    assert any(a["state"] == "completed" for a in c.store.all("attempt").values())
    c.close()


def test_input_credentials_rejected_before_persisting_resources(tmp_path):
    c = Coordinator(tmp_path, lambda *args: None, secrets=("actual-private-token",))
    documents = {"documents": [{"filename": "a.md", "text": "actual-private-token"}]}
    with pytest.raises(ValueError, match="credentials"):
        c.create(documents)
    assert c.store.db.execute("SELECT count(*) FROM resources").fetchone()[0] == 0
    assert c.store.get("run", "state") is None
    assert not (tmp_path / "inputs").exists()
    c.close()


def test_known_truncation_uses_bounded_followup_and_keeps_usage(tmp_path):
    from codeagent.superagent.runtime import REVIEW
    from codeagent.provider import TruncatedOutput

    class Truncating:
        api_key = ""
        usage = []

        def complete(self, messages, tools, max_tokens):
            assert max_tokens == 4096
            if len(self.usage) < 2:
                self.usage.append({"usage": {"prompt_tokens": 10, "completion_tokens": 4096}, "estimated_cny": .1})
                raise TruncatedOutput("known response cut off")
            return call("submit_review", {"approved": True, "issues": []})

    provider = Truncating()
    c = Coordinator(tmp_path, lambda *args: provider)
    def handle(name, args):return args, True
    result = c._dialogue("reviewer", "review", [REVIEW], handle)
    assert result["approved"]
    attempts = c.store.all("attempt")
    assert len(attempts) == 3
    assert sum(a["state"] == "truncated" for a in attempts.values()) == 2
    assert sum(a["state"] == "unknown" for a in attempts.values()) == 0
    assert len({e["details"]["request"] for e in c.store.events() if e["kind"] == "model_started"}) == 3
    c.close()


def test_install_only_ignores_host_derived_root_lockfile(tmp_path, monkeypatch):
    def check(root, *args, **kwargs):
        (root / "package-lock.json").write_text('{}')
        (root / "source.js").write_text('changed during install')
        return {"status": "passed"}

    monkeypatch.setattr("codeagent.superagent.runtime.validate", check)
    c = Coordinator(tmp_path, lambda *args: None)
    (c.project / "source.js").write_text('original')
    _, future = c.submit_check("install")
    assert future.result(timeout=3)["state"] == "stale"
    c.close()


def test_reviewer_cannot_invent_blocking_requirements(tmp_path):
    class Invented(Scripted):
        def complete(self, messages, tools, max_tokens):
            if not any(m["role"] == "assistant" for m in messages):
                return call("submit_review", {"approved": False, "issues": [{
                    "source_resource": c.store.get("run", "inputs")[0]["resource"],
                    "requirement": "You must use a PostgreSQL database", "file": "sum.js",
                    "problem": "No PostgreSQL database", "reproduction": "There is no PostgreSQL configuration"}]})
            assert "literal original requirement" in messages[-1]["content"]
            return call("submit_review", {"approved": True, "issues": [], "advisories": ["A database is optional"]})

    c = Coordinator(tmp_path, lambda role, cancel: Invented(role, []))
    c.create(DOCUMENTS)
    (c.project / "sum.js").write_text('module.exports=(a,b)=>a+b')
    review = c._review()
    assert review["approved"] and review["advisories"]
    c.close()


def test_new_run_uses_unique_children_and_preserves_parent_project(tmp_path):
    existing = tmp_path / "project"
    existing.mkdir()
    (existing / "README.md").write_text("Do not overwrite")
    provider = lambda *args: pytest.fail("Creating a task must not call the model")
    first = Coordinator.new_run(tmp_path, DOCUMENTS, provider)
    second = Coordinator.new_run(tmp_path, DOCUMENTS, provider)
    try:
        assert first.directory != second.directory
        assert first.directory.parent == second.directory.parent == tmp_path
        assert first.store.get("run", "state")["state"] == "pending"
        assert (existing / "README.md").read_text() == "Do not overwrite"
        assert not (tmp_path / "state.sqlite").exists()
    finally:
        first.close()
        second.close()


@pytest.mark.parametrize("existing", ["project", "inputs"])
def test_legacy_create_rejects_existing_product_or_input_bytes(tmp_path, existing):
    c = Coordinator(tmp_path, lambda *args: pytest.fail("No model call"))
    target = tmp_path / existing / "existing.txt"
    target.parent.mkdir(exist_ok=True)
    target.write_bytes(b"original bytes")
    try:
        with pytest.raises(ValueError, match="reuse existing"):
            c.create(DOCUMENTS)
        assert target.read_bytes() == b"original bytes"
        assert c.store.get("run", "state") is None
        assert c.store.resources() == []
    finally:
        c.close()


def test_resume_invalid_paths_do_not_create_or_modify_files(tmp_path):
    import sqlite3

    wrong = tmp_path / "ordinary-folder"
    wrong.mkdir()
    (wrong / "note.txt").write_bytes(b"private note")
    malformed = tmp_path / "unrelated-database"
    malformed.mkdir()
    (malformed / "project").mkdir()
    with sqlite3.connect(malformed / "state.sqlite") as connection:
        connection.execute("CREATE TABLE unrelated(value TEXT)")

    def files():
        return {p.relative_to(tmp_path).as_posix(): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}

    before = files()
    for directory in ("", tmp_path / "missing", wrong, malformed):
        with pytest.raises(ValueError):
            Coordinator.open_existing(directory, lambda *args: pytest.fail("No paid calls on an invalid task"))
        assert files() == before
    assert not (tmp_path / "missing").exists()


def test_resume_rejects_schema_only_database_without_task_metadata(tmp_path):
    c = Coordinator(tmp_path, lambda *args: None)
    c.close()
    before = {p.name: p.read_bytes() for p in tmp_path.iterdir() if p.is_file()}
    with pytest.raises(ValueError, match="任务状态"):
        Coordinator.open_existing(tmp_path, lambda *args: pytest.fail("No model request"))
    assert {p.name: p.read_bytes() for p in tmp_path.iterdir() if p.is_file()} == before


def test_resume_preflight_reads_live_wal_copy_without_touching_original(tmp_path):
    c = Coordinator(tmp_path, lambda *args: None)
    c.create(DOCUMENTS)
    try:
        assert (tmp_path / "state.sqlite-wal").is_file()
        before = {p.name: p.read_bytes() for p in tmp_path.glob("state.sqlite*")}
        assert Store.validate_existing(tmp_path) == tmp_path.resolve()
        assert {p.name: p.read_bytes() for p in tmp_path.glob("state.sqlite*")} == before
    finally:
        c.close()


def test_open_existing_preserves_unknown_attempt_and_lease(tmp_path):
    c = Coordinator(tmp_path, lambda *args: None)
    c.create(DOCUMENTS)
    c.store.put("run", "lease", "old-process")
    c.store.put("attempt", "unknown-request", {"state": "unknown", "usage": []})
    c.close()
    restored = Coordinator.open_existing(tmp_path, lambda *args: pytest.fail("Opening must not contact the provider"))
    try:
        assert restored.store.get("run", "lease") == "old-process"
        assert restored.store.get("attempt", "unknown-request")["state"] == "unknown"
        assert restored.store.get("run", "state")["state"] == "pending"
    finally:
        restored.close()


def test_state_transition_clears_stale_display_but_preserves_history(tmp_path):
    c = Coordinator(tmp_path, lambda *args: None)
    c.create(DOCUMENTS)
    c._state("cancelled", reason="Earlier cancellation", verification="failed", review={"approved": False}, checks=[{"status": "failed"}])
    c.store.put("attempt", "unknown-request", {"state": "unknown"})
    c._state("running")
    state = c.store.get("run", "state")
    assert not {"reason", "verification", "review", "checks"} & state.keys()
    c._state("completed", verification="unverified", checks=[])
    assert "reason" not in c.store.get("run", "state")
    assert any(event["details"].get("reason") == "Earlier cancellation" for event in c.store.events())
    assert c.store.get("attempt", "unknown-request") == {"state": "unknown"}
    c.close()


def test_resource_descriptors_do_not_create_versions_or_expose_full_text(tmp_path):
    s = Store(tmp_path)
    first = s.resource("design", "一😀二abc")
    second = s.resource("design", "new text")
    descriptors = s.resources()
    assert {row["resource"] for row in descriptors} == {first["resource"], second["resource"]}
    assert all(set(row) == {"resource", "version", "summary", "chars"} for row in descriptors)
    assert next(row["chars"] for row in descriptors if row["resource"] == first["resource"]) == 6
    assert s.resources() == descriptors
    assert s.read(first["resource"])["text"] == "一😀二abc"
    s.close()
