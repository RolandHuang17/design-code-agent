import json
import os
import shutil
import threading

import pytest

from codeagent.candidates import Candidates, content_hash
from codeagent.checks import assess_test_output
from codeagent.evidence import project_snapshot, bind_check
from codeagent.safety import Redactor
from codeagent.tools import Toolset


def tools_at(root):
    root.mkdir(exist_ok=True)
    return Toolset(root, threading.Event(), Redactor("private-key-value"))


def call(tools, name, **args):
    return tools.execute(name, json.dumps(args))


@pytest.mark.skipif(not shutil.which("node"), reason="Node syntax checker required")
def test_bad_edit_retains_valid_source_and_rejection_evidence(tmp_path):
    tools = tools_at(tmp_path / "project")
    assert "written" in call(tools, "write_file", path="auth.js", content="'use strict';\nmodule.exports = 1;")
    before = project_snapshot(tools.root)
    rejected = call(tools, "edit_file", path="auth.js", old="'use strict';", new="''use strict';")
    assert "error" in rejected
    assert project_snapshot(tools.root) == before
    journals = [json.loads(p.read_text()) for p in tools.candidates.directory.glob("*/journal.json")]
    assert any(j["status"] == "rejected" for j in journals)


def test_related_changes_validate_all_before_accepting_any(tmp_path):
    tools = tools_at(tmp_path / "project")
    call(tools, "write_file", path="a.json", content='{"old":1}')
    before = project_snapshot(tools.root)
    assert "error" in call(tools, "apply_changes", changes=[{"path":"a.json","content":"{}"}, {"path":"b.json","content":"{"}])
    assert project_snapshot(tools.root) == before
    accepted = call(tools, "apply_changes", changes=[{"path":"a.json","content":"{}"}, {"path":"b.json","content":"[]"}])
    assert accepted["written"] == ["a.json", "b.json"]
    assert project_snapshot(tools.root) == accepted["snapshot_id"]


@pytest.mark.skipif(os.name != "nt", reason="Windows case insensitive file identities")
def test_windows_case_aliases_are_not_two_changes(tmp_path):
    tools = tools_at(tmp_path / "project")
    result = call(tools, "apply_changes", changes=[{"path":"a.json","content":"{}"}, {"path":"A.json","content":"[]"}])
    assert "error" in result
    assert not list(tools.root.iterdir())


def test_commit_failure_rolls_back_related_files(tmp_path, monkeypatch):
    import codeagent.candidates as module
    tools = tools_at(tmp_path / "project")
    call(tools, "write_file", path="a.json", content="[]")
    original = project_snapshot(tools.root)
    replace = module.os.replace
    def fail_second(src, dst):
        if str(dst).endswith("b.json"):
            raise OSError("injected disk failure")
        return replace(src, dst)
    monkeypatch.setattr(module.os, "replace", fail_second)
    assert "error" in call(tools, "apply_changes", changes=[{"path":"a.json","content":"{}"}, {"path":"b.json","content":"[]"}])
    assert project_snapshot(tools.root) == original


def test_snapshot_invalidates_changed_sources(tmp_path):
    tools = tools_at(tmp_path / "project")
    call(tools,"write_file",path="a.txt",content="one")
    before = project_snapshot(tools.root)
    call(tools,"write_file",path="a.txt",content="two")
    check = bind_check({"profile":"test","status":"passed"},before,project_snapshot(tools.root))
    assert check["stale"] and check["status"] == "unverified"


@pytest.mark.parametrize("output", ["# tests 0\n# skipped 0\n", "ℹ tests 0\n", "# tests 2\n# skipped 2\n"])
def test_empty_or_all_skipped_tests_do_not_pass(output):
    assert assess_test_output({"status":"passed","output":output})["status"] != "passed"


def test_real_node_test_totals_and_unknown_output():
    assert assess_test_output({"status":"passed","output":"# tests 3\n# skipped 1\n"})["test_count"] == 3
    assert assess_test_output({"status":"passed","output":"success"})["status"] == "unverified"


def test_missing_node_is_explicit(tmp_path, monkeypatch):
    tools = tools_at(tmp_path / "project")
    monkeypatch.setattr("codeagent.candidates.shutil.which",lambda _: None)
    result = call(tools,"write_file",path="a.js",content="const x=1;")
    assert result["checks"][0]["status"] == "unverified"


def test_recovery_rolls_back_partially_applied_journal(tmp_path):
    tools = tools_at(tmp_path / "project")
    call(tools,"write_file",path="a.txt",content="before")
    folder = tools.candidates.directory / "interrupted"
    (folder / "before").mkdir(parents=True)
    (folder / "before/a.txt").write_text("before")
    target = tools.root / "a.txt"
    before = content_hash(target)
    target.write_text("after")
    record = {"root":str(tools.root.resolve()),"status":"applying","changes":[{"path":"a.txt","before":before,"after":content_hash(target)}]}
    (folder / "journal.json").write_text(json.dumps(record))
    tools.candidates.recover()
    assert target.read_text() == "before"
    assert json.loads((folder / "journal.json").read_text())["status"] == "recovered_rollback"
