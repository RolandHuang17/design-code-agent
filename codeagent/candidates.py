"""Validate staged edits before committing. Multi-file commits have a rollback journal.

This protects working sources from malformed edits; it does not sandbox execution.
"""
import hashlib
import json
import os
import shutil
import threading
import uuid
from pathlib import Path

import yaml

from .checks import UniqueKeyLoader, run_command
from .provider import Cancelled
from .safety import safe_path


def content_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


class CandidateRejected(ValueError):
    pass


class Candidates:
    def __init__(self, root, cancel, directory=None):
        self.root, self.cancel = root, cancel
        self.directory = directory or root.parent / "artifacts" / "candidates"
        self.lock = threading.RLock()

    @staticmethod
    def _save(path, value):
        temporary = path.with_suffix(".tmp")
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)

    def recover(self):
        if not self.directory.exists():
            return
        for journal in sorted(self.directory.glob("*/journal.json")):
            record = json.loads(journal.read_text(encoding="utf-8"))
            if record.get("root") != str(self.root.resolve()) or record["status"] != "applying":
                continue
            # Validate the entire rollback before touching any file.
            for item in record["changes"]:
                current = content_hash(safe_path(self.root, item["path"]))
                if current not in (item["before"], item["after"]):
                    raise CandidateRejected("Interrupted edit conflicts with an external change; inspect candidate journal")
            self._rollback(journal.parent, record)
            record["status"] = "recovered_rollback"
            self._save(journal, record)

    def _rollback(self, folder, record):
        for item in reversed(record["changes"]):
            target = safe_path(self.root, item["path"])
            if content_hash(target) == item["before"]:
                continue
            if item["before"] is None:
                target.unlink(missing_ok=True)
            else:
                temporary = target.with_name(target.name + ".rollback-" + uuid.uuid4().hex)
                shutil.copyfile(folder / "before" / item["path"], temporary)
                os.replace(temporary, target)

    def apply(self, changes, observed):
        with self.lock:
            self.recover()
            folder = self.directory / uuid.uuid4().hex
            folder.mkdir(parents=True)
            items, checks = [], []
            # Capture immutable candidates and original bytes before validation.
            for name, content in changes.items():
                path = safe_path(self.root, name)
                before = content_hash(path)
                if before is not None and observed.get(path) != before:
                    raise CandidateRejected("Read each existing file before editing; base content is stale")
                staged = folder / "after" / name
                staged.parent.mkdir(parents=True, exist_ok=True)
                staged.write_text(content, encoding="utf-8", newline="\n")
                if before is not None:
                    backup = folder / "before" / name
                    backup.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(path, backup)
                items.append({"path": name, "before": before, "after": content_hash(staged)})
            # Preserve nearest package module mode without running generated code.
            for item in items:
                source = safe_path(self.root, item["path"])
                parent = source.parent
                while parent.is_relative_to(self.root.resolve()):
                    package = parent / "package.json"
                    name = package.relative_to(self.root).as_posix()
                    if name in changes or package.exists():
                        dest = folder / "after" / name
                        if not dest.exists():
                            dest.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copyfile(package, dest)
                        break
                    if parent == self.root:
                        break
                    parent = parent.parent
            for item in items:
                staged = folder / "after" / item["path"]
                check = {"path": item["path"], "status": "not_applicable", "kind": "syntax_format"}
                try:
                    if staged.suffix == ".json":
                        json.loads(staged.read_text(encoding="utf-8"))
                        check["status"] = "passed"
                    elif staged.suffix in (".yaml", ".yml"):
                        list(yaml.load_all(staged.read_text(encoding="utf-8"), Loader=UniqueKeyLoader))
                        check["status"] = "passed"
                    elif staged.suffix in (".js", ".mjs", ".cjs"):
                        node = shutil.which("node")
                        if node:
                            check.update(run_command([node, "--check", str(staged.resolve())], folder, self.cancel, timeout=20))
                        else:
                            check.update(status="unverified", reason="Node.js unavailable; syntax not verified")
                except (ValueError, yaml.YAMLError) as error:
                    check.update(status="failed", error=str(error)[:3000])
                checks.append(check)
            record = {"root": str(self.root.resolve()), "changes": items, "checks": checks, "status": "prepared"}
            journal = folder / "journal.json"
            if any(c["status"] == "failed" for c in checks):
                record["status"] = "rejected"
                self._save(journal, record)
                raise CandidateRejected("Candidate syntax/format rejected; working files unchanged. " + json.dumps(checks, ensure_ascii=False)[:6500])
            for item in items:
                if content_hash(safe_path(self.root, item["path"])) != item["before"]:
                    record["status"] = "stale"
                    self._save(journal, record)
                    raise CandidateRejected("Working files changed during candidate validation")
            if self.cancel.is_set():
                raise Cancelled("用户取消")
            record["status"] = "applying"
            self._save(journal, record)
            try:
                for item in items:
                    target = safe_path(self.root, item["path"])
                    target.parent.mkdir(parents=True, exist_ok=True)
                    temporary = target.with_name(target.name + ".candidate-" + uuid.uuid4().hex)
                    try:
                        shutil.copyfile(folder / "after" / item["path"], temporary)
                        os.replace(temporary, target)
                    finally:
                        temporary.unlink(missing_ok=True)
            except BaseException:
                self._rollback(folder, record)
                record["status"] = "rolled_back"
                self._save(journal, record)
                raise
            record["status"] = "committed"
            self._save(journal, record)
            return {"candidate_id": folder.name, "checks": checks}
