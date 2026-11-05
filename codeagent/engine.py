import hashlib
import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .inputs import load_inputs
from .prompts import PHASES, SYSTEM
from .provider import Cancelled
from .safety import Redactor, project_files, safe_path
from .tools import TOOL_SCHEMAS, Toolset


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
        plan = toolset.root / "plan.json"
        if plan.exists():
            state["saved_plan"] = plan.read_text(encoding="utf-8")[:16000]
        return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": json.dumps(state, ensure_ascii=False)}]

    @staticmethod
    def bounded_checks(checks):
        return [{"profile": c.get("profile"), "status": c.get("status"),
                 "details_excerpt": json.dumps(c, ensure_ascii=False)[:6000]} for c in checks]

    def phase_loop(self, name, toolset, limit, feedback=None):
        self.phase = name
        self.event("phase_started")
        instruction = PHASES[name] + (json.dumps(self.bounded_checks(feedback), ensure_ascii=False) if feedback is not None else "")
        messages = self.context(toolset) + [{"role": "user", "content": instruction}]
        for _ in range(limit):
            if self.cancel.is_set():
                raise Cancelled("用户取消")
            if self.turns >= 130:
                raise RuntimeError("达到 130 次模型轮次上限")
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
            # Drop complete exchanges only. Files, plan and host observations reconstruct state.
            if len(json.dumps(messages, ensure_ascii=False).encode("utf-8")) > 140_000 or len(messages) > 30:
                self.event("context_compacted", reason="bounded complete tool exchanges; state retained on disk")
                messages = self.context(toolset) + [{"role": "user", "content": instruction + "\nContinue from files already written. Do not rewrite completed modules unnecessarily."}]
        raise RuntimeError(f"{name} 达到阶段轮次上限；已保留文件，可查看日志定位未完成任务")

    def run(self, architecture: Path, views: Path, output: Path):
        output = output.resolve()
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
        self.artifact("run-config.json", {"provider": self.provider.provider, "base_url": self.provider.base_url,
                                           "model": self.provider.model, "official_api_compliant": self.provider.provider == "deepseek",
                                           "allow_project_execution": self.allow_execution, "max_repair_rounds": 3,
                                           "max_turns": 130, "input_hashes": [d["sha256"] for d in self.documents["documents"]]})

        def snapshot(name, content, revision):
            path = safe_path(self.run_dir / "artifacts/revisions" / f"{revision:04}", name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")

        tools = Toolset(project, self.cancel, self.redactor, self.allow_execution, snapshot)
        report = {"status": "failed", "provider": self.provider.provider, "model": self.provider.model,
                  "official_api_compliant": self.provider.provider == "deepseek", "real_api_run": self.provider.provider in ("deepseek", "bailian"),
                  "checks": [], "repair_rounds": 0}
        try:
            self.event("run_started", output=str(self.run_dir), diagrams=self.documents["diagram_count"])
            self.phase_loop("planning", tools, 8)
            plan = project / "plan.json"
            if not plan.exists() or not isinstance(json.loads(plan.read_text(encoding="utf-8")).get("tasks"), list):
                raise RuntimeError("规划阶段未产出有效 plan.json")
            self.phase_loop("generation", tools, 80)
            for round_number in range(4):
                self.phase = "verification"
                self.event("phase_started", round=round_number)
                checks = self.verify(tools)
                self.artifact(f"checks-{round_number}.json", checks)
                report["checks"] = checks
                if not any(c["status"] == "failed" for c in checks):
                    break
                if round_number == 3:
                    break
                report["repair_rounds"] = round_number + 1
                self.phase_loop("repair", tools, 12, checks)
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
