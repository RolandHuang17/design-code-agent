"""Host-validated task graph and immutable, paged design resources.

The graph is implementation guidance, not a semantic proof of design coverage.
Legacy plans without dependency/source fields remain readable and are marked as such.
"""
import hashlib
import json
import re
from pathlib import Path

from .safety import project_files, safe_path
from .evidence import project_snapshot


def source_catalogue(documents):
    resources = []
    for doc in (documents or {}).get("documents", []):
        resources.append({"id": "design:" + doc["sha256"], "document": doc["filename"],
                          "version": doc["sha256"], "origin": doc.get("origin", "original input"),
                          "line_count": doc["line_count"], "headings": doc.get("headings", []),
                          "preview": doc["text"][:320]})
    return resources


def read_source(documents, resource_id, offset=0, limit=12000):
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 16000:
        raise ValueError("offset must be nonnegative characters and limit must be 1–16000")
    for doc in (documents or {}).get("documents", []):
        if resource_id == "design:" + doc["sha256"]:
            text = doc["text"]
            end = min(offset + limit, len(text))
            if offset > len(text):
                raise ValueError("offset exceeds resource length")
            return {"resource_id": resource_id, "version": doc["sha256"], "document": doc["filename"],
                    "origin": doc.get("origin", "original input"), "offset": offset,
                    "offset_unit": "Python Unicode characters", "total_chars": len(text),
                    "next_offset": end if end < len(text) else None, "content": text[offset:end]}
    raise ValueError("unknown design resource_id; use the source catalogue")


def source_reference(source, documents):
    if not isinstance(source, dict):
        raise ValueError("source must identify document and start_line")
    doc = next((d for d in documents.get("documents", []) if d["filename"] == source.get("document")), None)
    start, end = source.get("start_line"), source.get("end_line", source.get("start_line"))
    if not doc or type(start) is not int or type(end) is not int or not 1 <= start <= end <= doc["line_count"]:
        raise ValueError("invalid design source document/line range")
    return {"document": doc["filename"], "start_line": start, "end_line": end,
            "resource_id": "design:" + doc["sha256"], "version": doc["sha256"]}


def validate_plan(plan, root, documents):
    if not isinstance(plan, dict) or not isinstance(plan.get("tasks"), list) or not 1 <= len(plan["tasks"]) <= 60:
        raise ValueError("plan requires 1–60 tasks")
    tasks, ids, owners = [], set(), {}
    for raw in plan["tasks"]:
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), str) or not raw["id"].strip() or raw["id"] in ids:
            raise ValueError("task IDs must be unique nonempty strings")
        task = dict(raw)
        ids.add(task["id"])
        if not isinstance(task.get("files"), list) or not task["files"]:
            raise ValueError("each task requires file targets")
        files = []
        for name in task["files"]:
            safe_path(root, name)
            name = name.replace("\\", "/")
            if name in files or name in owners:
                raise ValueError("file target has multiple owners: " + name)
            owners[name] = task["id"]
            files.append(name)
        task["files"] = files
        dependencies = task.get("depends_on", [])
        if not isinstance(dependencies, list) or any(not isinstance(d, str) for d in dependencies):
            raise ValueError("depends_on must contain task IDs")
        task["depends_on"] = list(dict.fromkeys(dependencies))
        sources = task.get("sources", [])
        if not isinstance(sources, list):
            raise ValueError("sources must be an array")
        task["sources"] = [source_reference(s, documents) for s in sources]
        contracts = task.get("contracts", [])
        if not isinstance(contracts, list) or any(not isinstance(c, dict) for c in contracts):
            raise ValueError("contracts must be objects")
        for contract in contracts:
            if not isinstance(contract.get("description"), str) or not contract["description"].strip():
                raise ValueError("contract requires a description")
            if "source" in contract:
                source_reference(contract["source"], documents)
            elif contract.get("origin") != "assumption":
                raise ValueError("contract requires original source or origin=assumption")
        tasks.append(task)
    for task in tasks:
        if any(d not in ids or d == task["id"] for d in task["depends_on"]):
            raise ValueError("unknown or self task dependency: " + task["id"])
    ordered, pending = [], list(tasks)
    while pending:
        done = {t["id"] for t in ordered}
        ready = [t for t in pending if set(t["depends_on"]) <= done]
        if not ready:
            raise ValueError("cyclic task dependencies")
        ordered.extend(ready)
        pending = [t for t in pending if t not in ready]
    return {**plan, "tasks": ordered, "host_validation": {
        "dependency_order_checked": True, "unique_file_owners": True,
        "tasks_without_source_links": [t["id"] for t in tasks if not t["sources"]],
        "limitation": "Checks structural references, not semantic coverage or interface compatibility"}}


def task_progress(tasks, root, checks=()):
    """Only full current-snapshot checks can provide an acceptance state."""
    digest = project_digest(root)
    statuses = []
    active = [c for c in checks if c.get("snapshot_id") == digest and c.get("status") != "not_applicable"]
    for task in tasks:
        missing = [f for f in task["files"] if not safe_path(root, f).is_file()]
        state = "pending" if missing else "generated_unverified"
        if not missing and active:
            state = "validation_failed" if any(c.get("status") == "failed" for c in active) else "generated_unverified"
            required = {"static", "test", "build", "traceability_links", "plan_references"}
            applicable = [c for c in checks if c.get("status") != "not_applicable"]
            if required <= {c.get("profile") for c in active} and applicable and all(c.get("status") == "passed" and c.get("snapshot_id") == digest for c in applicable):
                state = "checks_passed_requires_review"
        statuses.append({"id": task["id"], "state": state, "missing": missing, "snapshot_id": digest,
                         "evidence_scope": "whole-project checks; not per-task semantic proof"})
    return statuses


def project_digest(root):
    return project_snapshot(root)


def local_context(documents, task, plan):
    """Keep source pointers and bounded exact excerpts; never summarize away provenance."""
    result = {"source_catalogue": source_catalogue(documents), "issues": (documents or {}).get("issues", [])}
    if not task:
        result["original_input"] = documents
        return result
    related = {task["id"], *task.get("depends_on", [])}
    result["related_tasks"] = [t for t in plan.get("tasks", []) if t["id"] in related]
    refs = [s for t in result["related_tasks"] for s in t.get("sources", [])]
    excerpts, available = [], 18000
    for source in refs:
        doc = next((d for d in documents.get("documents", []) if d["filename"] == source["document"]), None)
        if not doc:
            continue
        lines = doc["text"].splitlines()
        text = "\n".join(lines[source["start_line"]-1:source.get("end_line", source["start_line"])])
        shown = text[:available]
        excerpts.append({"source": source, "content": shown, "truncated": len(shown) < len(text)})
        available -= len(shown)
        if not available:
            break
    # Legacy plans have no links: preserve their full source instead of guessing relevance.
    if not refs:
        result["original_input"] = documents
    result["source_excerpts"] = excerpts
    return result


def failure_signature(checks):
    """Ignore timing/temporary run IDs while preserving actual diagnostic evidence."""
    failed = []
    for check in checks:
        if check.get("status") != "failed":
            continue
        detail = {k: v for k, v in check.items() if k not in {
            "snapshot_id", "revision", "elapsed_seconds", "duration", "time", "runtime_id", "directory"}}
        value = json.dumps(detail, sort_keys=True, ensure_ascii=False)
        value = re.sub(r"run-\d{8}-\d{6}-[a-f0-9]+", "run-ID", value)
        failed.append(value)
    return hashlib.sha256("\n".join(sorted(failed)).encode()).hexdigest()


def referenced_file_problems(root, tasks):
    """Find definite missing local targets, not speculative dependency names.

    Bare package imports, dynamic paths and shell semantics are left to real checks.
    """
    problems = []
    for task in tasks:
        for name in task["files"]:
            if Path(name).name != "package-lock.json" and not safe_path(root, name).is_file():
                problems.append({"task": task["id"], "path": name, "reason": "planned file missing"})
    for path in project_files(root):
        if path.suffix not in (".js", ".mjs", ".cjs"):
            continue
        text = path.read_text(encoding="utf-8")
        references = re.findall(r"(?:require\s*\(\s*|from\s+|import\s*\(\s*|import\s+)[\"'](\.{1,2}/[^\"']+)[\"']", text)
        for reference in references:
            if "?" in reference or "#" in reference:
                reference = re.split(r"[?#]", reference)[0]
            target = (path.parent / reference).resolve()
            if not target.is_relative_to(root.resolve()):
                problems.append({"path": path.relative_to(root).as_posix(), "reference": reference, "reason": "relative import escapes project"})
                continue
            candidates = [target, *(Path(str(target) + suffix) for suffix in (".js", ".cjs", ".mjs", ".json")),
                          *(target / name for name in ("index.js", "index.cjs", "index.mjs", "package.json"))]
            if not any(p.is_file() for p in candidates):
                problems.append({"path": path.relative_to(root).as_posix(), "reference": reference, "reason": "relative module missing"})
    return problems
