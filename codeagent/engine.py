import hashlib
import json
import re
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .inputs import load_inputs
from .prompts import PHASES, SYSTEM
from .provider import Cancelled
from .safety import Redactor, project_files, safe_path
from .tools import TOOL_SCHEMAS, Toolset

MAX_TURNS = 300


class Agent:
    def __init__(self, provider, cancel: threading.Event, emit=None, *, allow_execution=False):
        self.provider, self.cancel = provider, cancel
        self.redactor = Redactor(provider.api_key)
        self.emit = emit or (lambda event: None)
        self.allow_execution = allow_execution
        self.run_dir = None
        self.turns = 0
        self.phase = "initializing"
        self.documents = None

    def event(self, kind, **data):
        event = self.redactor.value({"time": datetime.now(timezone.utc).isoformat(), "event": kind, "phase": self.phase, **data})
        if self.run_dir:
            with (self.run_dir / "artifacts/events.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(event, ensure_ascii=False) + "\n")
        self.emit(event)

    def artifact(self, name, value):
        (self.run_dir / "artifacts" / name).write_text(json.dumps(self.redactor.value(value), ensure_ascii=False, indent=2), encoding="utf-8")

    def context(self, toolset):
        state = {"input": self.documents, "files": [p.relative_to(toolset.root).as_posix() for p in project_files(toolset.root)],
                 "host_observation": "Files on disk are authoritative. Read files needed for remaining tasks. This is a fresh context, not a claim about completion.",
                 "recent_checks": self.bounded_checks(toolset.check_history[-5:])}
        interfaces = {}
        available = 20_000
        for path in project_files(toolset.root):
            if path.suffix not in (".js", ".cjs", ".mjs") or "test" in path.parts:
                continue
            text = path.read_text(encoding="utf-8")
            signatures = re.findall(r"(?:async\s+)?function\s+\w+\s*\([^)]{0,180}\)", text)
            exports = re.findall(r"module\.exports\s*=\s*\{([^}]{0,1000})\}", text)
            summary = ("; ".join(signatures) + "; exports: " + ",".join(exports))[:700]
            if len(summary) > available:
                break
            interfaces[path.relative_to(toolset.root).as_posix()] = summary
            available -= len(summary)
        state["interface_index"] = interfaces
        plan = toolset.root / "plan.json"
        if plan.exists():
            state["saved_plan"] = plan.read_text(encoding="utf-8")[:16000]
            try:
                tasks = json.loads(state["saved_plan"])["tasks"]
                state["task_file_progress"] = [{"id": t["id"], "missing": [f for f in t["files"] if not safe_path(toolset.root, f).is_file()]} for t in tasks]
            except (ValueError, KeyError, TypeError):
                pass
        return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": json.dumps(state, ensure_ascii=False)}]

    @staticmethod
    def bounded_checks(checks):
        return [{"profile": c.get("profile"), "status": c.get("status"),
                 "details_excerpt": json.dumps(c, ensure_ascii=False)[:6000]} for c in checks]

    @staticmethod
    def repair_groups(checks):
        """Keep a repair focused on one failure cluster, not the entire repository."""
        groups = []
        auth = next((c for c in checks if c.get("profile") == "auth" and c.get("status") == "failed"), None)
        auth_grouped = False
        for check in checks:
            if check.get("status") != "failed" or check.get("profile") == "auth":
                continue
            if check.get("profile") == "static" and check.get("results"):
                groups.extend([{"profile": "static", "status": "failed", "target": r.get("check"), "details": r}]
                              for r in check["results"] if r.get("status") == "failed")
            elif check.get("profile") == "test" and re.search(r"(?m)^test at .+:\d+:\d+", check.get("output", "")):
                chunks = re.split(r"(?m)^test at (.+?):\d+:\d+\s*$", check["output"])
                files = {}
                for index in range(1, len(chunks), 2):
                    files.setdefault(chunks[index], []).append(chunks[index + 1])
                for filename, failures in files.items():
                    group = [{"profile": "test", "status": "failed", "target": filename, "output": "\n".join(failures)[:18000]}]
                    if auth and "auth.test" in filename:
                        group.append(auth)
                        auth_grouped = True
                    groups.append(group)
            else:
                groups.append([check])
        if auth and not auth_grouped:
            groups.append([auth])
        return groups

    def phase_loop(self, name, toolset, limit, feedback=None, task=None):
        self.phase = name
        toolset.read_limit = 8 if task or name == "repair" else None
        toolset.phase_reads = 0
        self.event("phase_started", task=task.get("id") if task else None)
        instruction = PHASES[name] + (json.dumps(self.bounded_checks(feedback), ensure_ascii=False) if feedback is not None else "")
        if name == "repair":
            instruction += ("\nFix ONLY this check group and its direct dependencies. Do not re-read the whole repository. "
                            "Use the interface index; after at most eight reads, apply a concrete repair. "
                            "Preserve test scenarios; replace unsigned JWT fixtures with signed JWKS fixtures if signature validation is added. "
                            "Do not repair unrelated groups now; the host schedules them separately.")
        if task:
            instruction = ("CURRENT TASK ONLY: " + json.dumps(task, ensure_ascii=False) +
                           "\nImplement these files now, then finish this phase. The host schedules other tasks separately. "
                           "Only write the focus target; reuse existing helpers. Do not re-read all files or repeat the saved plan. "
                           "File inventory, task progress and interface signatures are already provided. Read only necessary dependencies, at most eight reads before writing. "
                           "Do not run full-repository checks while other tasks are still missing. "
                           "Existing file presence is not proof of correctness; final host checks follow all tasks.")
        messages = self.context(toolset) + [{"role": "user", "content": instruction}]
        for _ in range(limit):
            if self.cancel.is_set():
                raise Cancelled("用户取消")
            if self.turns >= MAX_TURNS:
                raise RuntimeError(f"达到 {MAX_TURNS} 次模型轮次上限")
            self.turns += 1
            message = self.provider.complete(messages, TOOL_SCHEMAS)
            self.artifact("usage.json", {"requests": self.provider.usage, "cumulative_budget": self.provider.budget.snapshot()})
            self.event("assistant", turn=self.turns, message=message)
            calls = message.get("tool_calls") or []
            if not calls:
                return
            if len(calls) > 16:
                raise RuntimeError("单轮工具调用超过 16 个，停止异常响应")
            messages.append(message)
            for call in calls:
                if not isinstance(call, dict) or not call.get("id") or not isinstance(call.get("function"), dict):
                    raise RuntimeError("模型工具调用格式无效")
                function = call["function"]
                result = toolset.execute(function.get("name"), function.get("arguments", ""))
                self.event("tool_result", tool=function.get("name"), arguments=function.get("arguments"), result=result)
                messages.append({"role": "tool", "tool_call_id": call["id"], "content": json.dumps(self.redactor.value(result), ensure_ascii=False)})
            # A scoped generation task ends on observable file completion, not an
            # extra paid summary request. Execute the entire tool batch first.
            if task and all(safe_path(toolset.root, f).is_file() for f in task["files"]):
                self.event("task_files_generated", task=task.get("id"))
                return
            # Drop complete exchanges only. Files, plan and host observations reconstruct state.
            if len(json.dumps(messages, ensure_ascii=False).encode("utf-8")) > 190_000:
                self.event("context_compacted", reason="bounded complete tool exchanges; state retained on disk")
                positions = [i for i, m in enumerate(messages) if m["role"] == "assistant"]
                tail = []
                for index in reversed(positions[-3:]):
                    candidate = messages[index:]
                    if len(json.dumps(candidate, ensure_ascii=False).encode("utf-8")) <= 60000:
                        tail = candidate
                    else:
                        break
                messages = self.context(toolset) + [{"role": "user", "content": instruction + "\nContinue from files already written. Do not rewrite completed modules unnecessarily."}] + tail
        if task or name == "repair":
            self.event("phase_turn_limit", note="Return current progress to the host for remaining-file scheduling or verification")
            return
        raise RuntimeError(f"{name} 达到阶段轮次上限；已保留文件，可查看日志定位未完成任务")

    def run(self, architecture: Path, views: Path, output: Path, seed_project: Path | None = None, review_feedback: list | None = None):
        output = output.resolve()
        if review_feedback is not None and (not isinstance(review_feedback, list) or any(not isinstance(c, dict) for c in review_feedback)):
            raise ValueError("外部反馈必须为检查对象组成的 JSON 数组")
        review_feedback = self.redactor.value(review_feedback or [])
        self.documents = load_inputs(architecture, views)
        # Refuse to upload a document that appears to contain the currently configured credential.
        if any(self.redactor.text(d["text"]) != d["text"] for d in self.documents["documents"]):
            raise ValueError("输入文件疑似含 API 密钥，请先移除")
        output.mkdir(parents=True, exist_ok=True)
        self.run_dir = output / (datetime.now().strftime("run-%Y%m%d-%H%M%S-") + uuid4().hex[:8])
        self.run_dir.mkdir(exist_ok=False)
        project = self.run_dir / "project"
        project.mkdir()
        (self.run_dir / "artifacts").mkdir()
        (self.run_dir / "inputs").mkdir()
        for index, path in enumerate((architecture, views), 1):
            (self.run_dir / "inputs" / f"{index}-{path.name}").write_bytes(path.read_bytes())
        self.artifact("structured-input.json", self.documents)
        if review_feedback:
            self.artifact("external-feedback.json", review_feedback)
        seed_manifest = []
        if seed_project:
            seed_project = seed_project.resolve()
            if not (seed_project / "plan.json").is_file():
                raise ValueError("续跑起点缺少 plan.json")
            seed_files = list(project_files(seed_project))
            if len(seed_files) > 300 or sum(p.stat().st_size for p in seed_files) > 8_000_000:
                raise ValueError("续跑起点超过文件数量或大小限制")
            for original in seed_files:
                name = original.relative_to(seed_project).as_posix()
                content = original.read_bytes()
                if self.redactor.text(content.decode("utf-8")) != content.decode("utf-8"):
                    raise ValueError("续跑起点疑似含 API 密钥")
                target = safe_path(project, name)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(original, target)
                seed_manifest.append({"path": name, "sha256": hashlib.sha256(content).hexdigest()})
            self.artifact("seed-manifest.json", {"source_project": str(seed_project), "files": seed_manifest})
        self.artifact("run-config.json", {"provider": self.provider.provider, "base_url": self.provider.base_url,
                                           "model": self.provider.model, "official_api_compliant": self.provider.provider == "deepseek",
                                           "allow_project_execution": self.allow_execution, "max_repair_rounds": 3,
                                           "max_turns": MAX_TURNS, "input_hashes": [d["sha256"] for d in self.documents["documents"]],
                                           "seed_project": str(seed_project) if seed_project else None,
                                           "agent_source_hashes": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(__file__).parent.glob("*.py")}})

        def snapshot(name, content, revision):
            path = safe_path(self.run_dir / "artifacts/revisions" / f"{revision:04}", name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")

        tools = Toolset(project, self.cancel, self.redactor, self.allow_execution, snapshot)
        report = {"status": "failed", "provider": self.provider.provider, "model": self.provider.model,
                  "official_api_compliant": self.provider.provider == "deepseek", "real_api_run": self.provider.provider in ("deepseek", "bailian"),
                  "checks": [], "repair_rounds": 0}
        self.artifact("report.json", {**report, "status": "running", "note": "If this status remains after the process exits, the process was externally interrupted."})
        try:
            self.event("run_started", output=str(self.run_dir), diagrams=self.documents["diagram_count"])
            if not seed_project:
                self.phase_loop("planning", tools, 8)
            plan = project / "plan.json"
            if not plan.exists() or not isinstance(json.loads(plan.read_text(encoding="utf-8")).get("tasks"), list):
                raise RuntimeError("规划阶段未产出有效 plan.json")
            tasks = json.loads(plan.read_text(encoding="utf-8"))["tasks"]
            if not 1 <= len(tasks) <= 60:
                raise ValueError("任务数必须为 1 至 60")
            for task in tasks:
                if not isinstance(task.get("files"), list) or not task["files"]:
                    raise ValueError("每个规划任务必须列出目标文件")
                missing = [f for f in task["files"] if not safe_path(project, f).is_file()]
                if not missing:
                    self.event("task_files_present", task=task.get("id"), note="file presence only; final validation still required")
                    continue
                self.event("task_started", task=task.get("id"), missing=missing)
                for target in missing:
                    if safe_path(project, target).is_file():
                        continue
                    focused_task = {**task, "files": [target], "focus_file": target}
                    self.phase_loop("generation", tools, 10, task=focused_task)
                    if not safe_path(project, target).is_file():
                        self.phase_loop("generation", tools, 5, task=focused_task)
                if any(not safe_path(project, f).is_file() for f in task["files"]):
                    raise RuntimeError(f"任务 {task.get('id')} 未完成目标文件；停止并保留结果")
            for round_number in range(4):
                self.phase = "verification"
                self.event("phase_started", round=round_number)
                checks = self.verify(tools)
                if review_feedback:
                    if round_number == 0:
                        checks += [{**c, "status": "failed", "origin": "external_review"} for c in review_feedback]
                    else:
                        checks.append({"profile": "external_review_retest", "status": "unverified",
                                       "reason": "外部反馈已用于修复，但必须由独立验收重新验证；不能根据模型文字判为通过"})
                self.artifact(f"checks-{round_number}.json", checks)
                report["checks"] = checks
                if not any(c["status"] == "failed" for c in checks):
                    break
                if round_number == 3:
                    break
                report["repair_rounds"] = round_number + 1
                for group in self.repair_groups(checks):
                    self.phase_loop("repair", tools, 8, group)
            if any(c["status"] == "failed" for c in report["checks"]):
                report["status"] = "failed_validation"
            elif any(c["status"] == "unverified" for c in report["checks"]):
                report["status"] = "completed_with_gaps"
            else:
                report["status"] = "checks_passed_requires_review"
            report["limitation"] = "Checks do not establish semantic architecture fidelity, production readiness or performance. Review traceability and run independent acceptance tests."
        except Cancelled as exc:
            report.update(status="cancelled", error=str(exc))
        except Exception as exc:
            report.update(status="failed", error=self.redactor.text(str(exc)))
        finally:
            self.phase = "finished"
            report["turns"] = self.turns
            report["budget"] = self.provider.budget.snapshot()
            report["usage"] = self.provider.usage
            report["valid_api_responses"] = len(self.provider.usage)
            report["files"] = [{"path": p.relative_to(project).as_posix(), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in project_files(project)]
            self.artifact("report.json", report)
            (self.run_dir / "artifacts/report.md").write_text(self.report_markdown(report), encoding="utf-8")
            self.event("run_finished", status=report["status"], output=str(self.run_dir))
        return self.run_dir, report

    def verify(self, tools):
        checks = [tools.execute("run_check", json.dumps({"profile": p})) for p in ("static", "install", "test", "build", "compose")]
        if (tools.root / "shared/src/auth.js").exists():
            checks.append(tools.execute("run_check", '{"profile":"auth"}'))
        checks.append(self.verify_traceability(tools.root))
        for item in checks:
            if "status" not in item:
                item["status"] = "failed"
        return checks

    def verify_traceability(self, project):
        problems = []
        try:
            data = json.loads((project / "traceability.json").read_text(encoding="utf-8"))
            items = data["items"]
            if not items:
                raise ValueError("追溯条目为空")
            docs = {d["filename"]: d for d in self.documents["documents"]}
            ids = set()
            for item in items:
                source = item["source"]
                if item["id"] in ids:
                    problems.append("追溯 ID 重复")
                ids.add(item["id"])
                if source["document"] not in docs or type(source["start_line"]) is not int or not 1 <= source["start_line"] <= docs[source["document"]]["line_count"]:
                    problems.append(f"无效来源：{item['id']}")
                for name in item["files"] + item["tests"]:
                    if not safe_path(project, name).is_file():
                        problems.append(f"缺失追溯文件：{name}")
                if item["status"] not in ("implemented", "partial", "unimplemented"):
                    problems.append(f"无效追溯状态：{item['id']}")
                if item["status"] == "implemented" and (not item["files"] or not item["tests"]):
                    problems.append(f"已实现条目缺少代码或测试：{item['id']}")
        except (OSError, KeyError, TypeError, ValueError) as exc:
            problems.append(str(exc))
        return {"profile": "traceability_links", "status": "failed" if problems else "passed", "problems": problems,
                "limitation": "只检查链接和来源范围；语义覆盖需要独立审查"}

    @staticmethod
    def report_markdown(report):
        lines = ["# 生成验证报告", "", f"状态：`{report['status']}`", f"平台：{report['provider']}；模型：{report['model']}",
                 f"官方 API 要求：{'满足平台条件' if report['official_api_compliant'] else '不满足：本次使用第三方百炼平台'}", "",
                 "| 检查 | 状态 |", "| --- | --- |"]
        lines += [f"| {c.get('profile', 'check')} | {c.get('status', 'failed')} |" for c in report["checks"]]
        lines += ["", f"修复轮次：{report['repair_rounds']}；模型轮次：{report['turns']}",
                  f"累计保守计费：{report['budget']['charged_cny']:.4f} 元（含其他任务和不确定预留）", "",
                  "这些检查不证明架构语义完全一致、云部署成功、生产安全或性能目标达标。详细命令、输出和用量见 report.json。"]
        if report.get("error"):
            lines += ["", "错误：" + report["error"]]
        return "\n".join(lines) + "\n"
