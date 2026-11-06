import hashlib
import json
import threading

import pytest

from codeagent.engine import Agent, SOURCE_TOOL
from codeagent.planning import (failure_signature, local_context, project_digest, read_source,
                                referenced_file_problems, source_catalogue, task_progress, validate_plan)
from codeagent.prompts import SYSTEM
from codeagent.safety import Redactor
from codeagent.tools import Toolset
from test_checks_engine import ReplayProvider


def documents():
    text = "# Design\n中文 module\nA pure calculation library\n"
    return {"documents": [{"filename": "arch.md", "text": text, "line_count": 3,
                            "sha256": hashlib.sha256(text.encode()).hexdigest(), "headings": []}], "issues": []}


def test_plan_orders_dependencies_and_preserves_exact_source(tmp_path):
    plan = {"tasks": [
        {"id": "tests", "files": ["math.test.js"], "depends_on": ["math"], "sources": [{"document": "arch.md", "start_line": 2, "end_line": 3}]},
        {"id": "math", "files": ["math.js"], "contracts": [{"description": "derived add API", "origin": "assumption"}]}]}
    validated = validate_plan(plan, tmp_path, documents())
    assert [t["id"] for t in validated["tasks"]] == ["math", "tests"]
    source = validated["tasks"][1]["sources"][0]
    assert source["resource_id"] == source_catalogue(documents())[0]["id"]
    context = local_context(documents(), validated["tasks"][1], validated)
    assert "original_input" not in context
    assert context["source_excerpts"][0]["content"] == "中文 module\nA pure calculation library"
    assert len(context["related_tasks"]) == 2


@pytest.mark.parametrize("tasks", [
    [{"id": "a", "files": ["a.js"], "depends_on": ["missing"]}],
    [{"id": "a", "files": ["a.js"], "depends_on": ["b"]}, {"id": "b", "files": ["b.js"], "depends_on": ["a"]}],
    [{"id": "a", "files": ["same.js"]}, {"id": "b", "files": ["same.js"]}],
    [{"id": "a", "files": ["../escape.js"]}],
    [{"id": "a", "files": ["a.js"], "sources": [{"document": "arch.md", "start_line": 4}]}],
    [{"id": "a", "files": ["a.js"], "contracts": [{"description": "unsupported original claim"}]}],
])
def test_plan_rejects_unsafe_or_inconsistent_graph(tmp_path, tasks):
    with pytest.raises(ValueError):
        validate_plan({"tasks": tasks}, tmp_path, documents())


def test_source_paging_reconstructs_unicode_and_rejects_bad_arguments():
    docs = documents()
    resource = source_catalogue(docs)[0]["id"]
    pieces, offset = [], 0
    while True:
        page = read_source(docs, resource, offset, 4)
        pieces.append(page["content"])
        if page["next_offset"] is None:
            break
        offset = page["next_offset"]
    assert "".join(pieces) == docs["documents"][0]["text"]
    for arguments in [("unknown", 0, 3), (resource, True, 3), (resource, 999, 3), (resource, 0, 20000)]:
        with pytest.raises(ValueError):
            read_source(docs, *arguments)


def test_file_existence_is_unverified_and_old_checks_do_not_accept_changes(tmp_path):
    tasks = [{"id": "math", "files": ["math.js"]}]
    assert task_progress(tasks, tmp_path)[0]["state"] == "pending"
    (tmp_path / "math.js").write_text("module.exports=1;")
    assert task_progress(tasks, tmp_path)[0]["state"] == "generated_unverified"
    check = {"profile": "test", "status": "passed", "snapshot_id": project_digest(tmp_path)}
    assert task_progress(tasks, tmp_path, [check])[0]["state"] == "generated_unverified"
    checks = [{**check, "profile": p} for p in ("static", "test", "build", "traceability_links", "plan_references")]
    assert task_progress(tasks, tmp_path, checks)[0]["state"] == "checks_passed_requires_review"
    (tmp_path / "math.js").write_text("module.exports=2;")
    assert task_progress(tasks, tmp_path, [check])[0]["state"] == "generated_unverified"


def test_missing_literal_import_and_planned_target_are_actionable(tmp_path):
    (tmp_path / "consumer.js").write_text("const x = require('./provider'); const fs = require('node:fs');")
    tasks = [{"id": "test", "files": ["consumer.js", "test.js"]}]
    problems = referenced_file_problems(tmp_path, tasks)
    assert {p["reason"] for p in problems} == {"planned file missing", "relative module missing"}
    (tmp_path / "provider.js").write_text("module.exports=1;")
    (tmp_path / "test.js").write_text("// fixture")
    assert referenced_file_problems(tmp_path, tasks) == []


def test_generic_prompt_does_not_force_web_architecture():
    assert "required ONLY when" in SYSTEM
    assert "sources" in SYSTEM and "depends_on" in SYSTEM
    assert "Required root files: package.json (real test/build/start scripts), README.md, compose.yaml" not in SYSTEM


def test_repair_priority_follows_dependency_order():
    checks = [{"profile": p, "status": "failed"} for p in ("runtime", "test", "install", "build", "static")]
    assert [g[0]["profile"] for g in Agent.repair_groups(checks)] == ["static", "install", "build", "runtime", "test"]


def test_failure_signature_ignores_snapshot_and_detects_changed_diagnostic():
    a = [{"profile": "runtime", "status": "failed", "snapshot_id": "old", "elapsed_seconds": 2, "error": "bad signature"}]
    b = [{**a[0], "snapshot_id": "new", "elapsed_seconds": 3}]
    assert failure_signature(a) == failure_signature(b)
    b[0]["error"] = "realm unavailable"
    assert failure_signature(a) != failure_signature(b)


def test_replan_is_read_only_and_strategy_persisted(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    provider = ReplayProvider(tmp_path)
    provider.add("write_file", {"path": "bad.js", "content": "const x=1;"})
    provider.done()
    agent = Agent(provider, threading.Event(), max_repair_rounds=10)
    agent.documents = documents()
    agent.run_dir = tmp_path / "run"
    (agent.run_dir / "artifacts").mkdir(parents=True)
    agent.phase_loop("replan", Toolset(project, agent.cancel, Redactor()), 3,
                     [{"profile": "runtime", "status": "failed", "error": "repeat"}])
    assert not (project / "bad.js").exists()
    assert json.loads((agent.run_dir / "artifacts/repair-strategy.json").read_text())["strategy"]
    assert SOURCE_TOOL["function"]["name"] == "read_source"


def test_repair_rounds_rejects_out_of_range(tmp_path):
    for value in (-1, 11, True):
        with pytest.raises(ValueError):
            Agent(ReplayProvider(tmp_path), threading.Event(), max_repair_rounds=value)


def test_repeated_failure_runs_only_one_bounded_replan(tmp_path, monkeypatch):
    architecture, views = tmp_path / "arch.md", tmp_path / "view.md"
    architecture.write_text("# Design\nA library")
    views.write_text("```plantuml\n@startuml\nclass Math\n@enduml\n```")
    seed = tmp_path / "seed"
    seed.mkdir()
    (seed / "plan.json").write_text(json.dumps({"tasks": [{"id": "math", "files": ["math.js"]}]}))
    (seed / "math.js").write_text("module.exports=1;")
    provider = ReplayProvider(tmp_path)
    for _ in range(4):
        provider.done()
    agent = Agent(provider, threading.Event(), max_repair_rounds=3)
    monkeypatch.setattr(agent, "verify", lambda tools: [{"profile": "test", "status": "failed", "output": "same broken behavior"}])
    run, report = agent.run(architecture, views, tmp_path / "runs", seed_project=seed)
    events = [json.loads(line) for line in (run / "artifacts/events.jsonl").read_text().splitlines()]
    assert sum(e["event"] == "repair_replan" for e in events) == 1
    assert report["bounded_replan_used"] is True
    assert report["status"] == "failed_validation"
    assert report["repair_rounds"] == 3
    assert provider.position == 4


def test_model_source_tool_uses_fixed_pages_and_rejects_repeated_page(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    provider = ReplayProvider(tmp_path)
    docs = documents()
    resource = source_catalogue(docs)[0]["id"]
    for _ in range(3):
        provider.add("read_source", {"resource_id": resource})
    provider.done()
    events = []
    agent = Agent(provider, threading.Event(), emit=events.append)
    agent.documents = docs
    agent.run_dir = tmp_path / "run"
    (agent.run_dir / "artifacts").mkdir(parents=True)
    agent.phase_loop("repair", Toolset(project, agent.cancel, Redactor()), 5, [])
    results = [e["result"] for e in events if e["event"] == "tool_result"]
    assert results[0]["content"] == docs["documents"][0]["text"]
    assert results[1]["content"] == results[0]["content"]
    assert "already returned twice" in results[2]["error"]
    assert "limit" not in SOURCE_TOOL["function"]["parameters"]["properties"]


def test_task_context_inlines_supplement_once_without_source_excerpt_duplicate():
    docs = documents()
    supplement = {**docs["documents"][0], "filename": "supplement.md", "kind": "operator_supplement", "origin": "operator supplied, not original design"}
    docs["documents"].append(supplement)
    task = {"id": "config", "files": ["config.js"], "sources": [{"document": "supplement.md", "start_line": 1, "end_line": 3}]}
    context = local_context(docs, task, {"tasks": [task]})
    assert len(context["operator_supplements"]) == 1
    assert context["operator_supplements"][0]["content"] == supplement["text"]
    assert context["source_excerpts"] == []
    assert "original_input" not in context
