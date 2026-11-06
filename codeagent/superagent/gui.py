"""Durable prototype workbench; UI state never substitutes for persisted evidence."""
import json
import os
import queue
import sys
import threading
import time
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from .. import __version__
from ..budget import Budget, Prices, default_ledger, parse_limit
from ..config import user_variable
from ..inputs import load_inputs
from ..provider import DeepSeek
from ..safety import Redactor
from ..ui import Controls, PageCursor, ScrollPanel, TextArea, field, note, setup_dpi, status_label, tree_panel, update_tree, workbench
from .runtime import Coordinator


class Application:
    def __init__(self, root):
        self.root = root
        self.events = queue.Queue()
        self.coordinator = self.worker = None
        self.cancel = threading.Event()
        self.busy = self.closing = False
        self.result_dir = None
        self.worker_error = None
        self.redactor = Redactor()
        self.dirty, self.last_refresh = False, 0.0
        self.path = tk.StringVar(value=str(Path.home() / "Documents" / "DesignCodeAgent-Superagent"))
        self.restore_path, self.active_path = tk.StringVar(), tk.StringVar(value="尚未选择任务")
        base = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path.cwd()
        example = base / ("examples" if getattr(sys, "frozen", False) else "benchmarks") / "superagent-health"
        self.architecture = tk.StringVar(value=str(example / "Architecture_Documentation.md") if (example / "Architecture_Documentation.md").is_file() else "")
        self.views = tk.StringVar(value=str(example / "Architecture_View.md") if (example / "Architecture_View.md").is_file() else "")
        self.base = tk.StringVar(value=user_variable("DASHSCOPE_BASE_URL") or "https://dashscope.aliyuncs.com/compatible-mode/v1")
        self.key = tk.StringVar()
        self.input_price, self.output_price = tk.StringVar(value="12"), tk.StringVar(value="27")
        self.budget, self.confirm, self.execute = tk.StringVar(value="不限"), tk.BooleanVar(), tk.BooleanVar()
        self.status = tk.StringVar(value="就绪 · 新建任务或选择已有任务恢复")
        self.summary = tk.StringVar(value="独立模型会话 / 两个代码执行者 / 持久化任务记录")
        left, right, footer = workbench(root, f"DesignCodeAgent-Superagent {__version__} · 架构原型", "多会话架构原型")
        self.controls = Controls()
        settings = ttk.Notebook(left)
        settings.pack(fill="both", expand=True)
        project, model = ScrollPanel(settings), ScrollPanel(settings)
        settings.add(project, text="项目与恢复")
        settings.add(model, text="模型设置")
        p, m = project.content, model.content
        field(p, "架构文档", self.architecture, self.controls, browse=lambda: self._file(self.architecture))
        field(p, "架构视图", self.views, self.controls, browse=lambda: self._file(self.views))
        field(p, "新任务输出父目录", self.path, self.controls, browse=lambda: self._directory(self.path))
        note(p, "新建时自动建立唯一子目录，不覆盖已有任务。")
        ttk.Separator(p).pack(fill="x", pady=12)
        field(p, "恢复已有任务目录", self.restore_path, self.controls, browse=lambda: self._directory(self.restore_path))
        note(p, "选择含 state.sqlite 的任务目录。未知请求会保留费用，并在恢复前要求确认。")
        self.controls.add(ttk.Checkbutton(p, text="允许安装、测试及构建生成项目", variable=self.execute)).pack(anchor="w", pady=(12, 0))
        note(p, "使用当前用户权限；执行者目录隔离不是系统沙箱。原型与主工具分别验收。")
        ttk.Label(m, text="百炼 · deepseek-v4-pro-0813").pack(anchor="w", pady=(5, 0))
        field(m, "Base URL", self.base, self.controls)
        field(m, "API Key", self.key, self.controls, secret=True)
        self.controls.add(ttk.Button(m, text="读取环境变量", command=self.read_key)).pack(anchor="w", pady=(7, 0))
        note(m, "读取 DASHSCOPE_API_KEY。密钥仅在内存使用，不写入任务数据库。")
        for label, variable in [("输入价 · 元 / 百万 tokens", self.input_price), ("输出价 · 元 / 百万 tokens", self.output_price), ("累计预算 · 元，可填写“不限”", self.budget)]:
            field(m, label, variable, self.controls)
        self.controls.add(ttk.Checkbutton(m, text="已核对当前模型、地域价格上界", variable=self.confirm)).pack(anchor="w", pady=(12, 0))
        note(m, "真实模型请求会付费，结果未知的请求保留费用预留。")
        project.bind_wheel()
        model.bind_wheel()
        info = ttk.Frame(right, padding=(12, 7, 8, 10))
        info.pack(fill="x")
        ttk.Label(info, textvariable=self.summary, font=("Microsoft YaHei UI", 11, "bold"), wraplength=600).pack(anchor="w")
        ttk.Label(info, textvariable=self.active_path, style="Muted.TLabel", wraplength=600).pack(anchor="w", pady=(6, 0))
        self.tabs = ttk.Notebook(right)
        self.tabs.pack(fill="both", expand=True)
        for attr, title, columns, headings, widths in [
            ("tasks", "工作项", ("id", "state", "dependencies", "files"), ("工作项", "状态", "依赖", "目标文件"), (125, 135, 100, 230)),
            ("sessions", "会话", ("role", "state", "cost", "request"), ("执行角色", "请求状态", "有效响应估算 / 元", "请求标识"), (150, 125, 135, 260)),
            ("checks", "检查", ("profile", "state", "result", "snapshot"), ("检查", "作业状态", "实际结果", "代码快照"), (110, 110, 135, 200))]:
            frame, tree = tree_panel(self.tabs, columns, headings, widths)
            setattr(self, attr, tree)
            self.tabs.add(frame, text=title)
        resources = ttk.Frame(self.tabs, padding=10)
        self.tabs.add(resources, text="资源")
        self.resource = tk.StringVar()
        self.cursor = PageCursor()
        ttk.Label(resources, text="资源 ID（包含不可变版本）").pack(anchor="w", pady=(0, 6))
        self.resource_choice = ttk.Combobox(resources, textvariable=self.resource, width=20)
        self.resource_choice.pack(fill="x")
        self.resource.trace_add("write", self.resource_changed)
        resource_actions = ttk.Frame(resources)
        resource_actions.pack(fill="x", pady=8)
        ttk.Button(resource_actions, text="读取首页", command=self.read_resource).pack(side="left")
        self.next_button = ttk.Button(resource_actions, text="下一页", command=lambda: self.read_resource(True), state="disabled")
        self.next_button.pack(side="left", padx=6)
        self.resource_info = tk.StringVar(value="资源摘要、原文及读取位置在此显示")
        ttk.Label(resources, textvariable=self.resource_info, style="Muted.TLabel", wraplength=590).pack(anchor="w", pady=(0, 7))
        self.resource_text = TextArea(resources, code=True)
        self.resource_text.pack(fill="both", expand=True)
        self.logs = TextArea(self.tabs, code=True)
        self.tabs.add(self.logs, text="日志")
        self.log = self.logs.text
        self.start_button = ttk.Button(footer, text="新建并运行", style="Primary.TButton", command=self.start)
        self.start_button.pack(side="left")
        self.resume_button = ttk.Button(footer, text="恢复任务", command=self.resume)
        self.resume_button.pack(side="left", padx=6)
        self.pause_button = ttk.Button(footer, text="暂停", command=self.pause, state="disabled")
        self.pause_button.pack(side="left")
        self.cancel_button = ttk.Button(footer, text="取消", command=self.request_cancel, state="disabled")
        self.cancel_button.pack(side="left", padx=6)
        self.report_button = ttk.Button(footer, text="查看报告", command=self.report, state="disabled")
        self.report_button.pack(side="right")
        self.output_button = ttk.Button(footer, text="打开结果", command=self.open_result, state="disabled")
        self.output_button.pack(side="right", padx=6)
        ttk.Label(root, textvariable=self.status, style="Muted.TLabel", padding=(15, 5), wraplength=900).pack(side="bottom", fill="x", before=footer)
        self.read_key()
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.after(100, self.poll)

    def read_key(self):
        self.key.set(user_variable("DASHSCOPE_API_KEY", refresh=True))

    def _file(self, variable):
        value = filedialog.askopenfilename(filetypes=[("Markdown", "*.md"), ("所有文件", "*.*")])
        if value:
            variable.set(value)

    def _directory(self, variable=None):
        value = filedialog.askdirectory()
        if value:
            (variable or self.path).set(value)

    def set_busy(self, busy):
        self.busy = busy
        self.controls.enabled(not busy and not self.closing)
        for button in (self.start_button, self.resume_button):
            button.configure(state="disabled" if busy or self.closing else "normal")
        stopping = self.cancel.is_set() or self.closing
        self.pause_button.configure(state="normal" if busy and not stopping and not (self.coordinator and self.coordinator.pause_requested.is_set()) else "disabled")
        self.cancel_button.configure(state="normal" if busy and not stopping else "disabled")
        self.output_button.configure(state="normal" if self.result_dir and self.result_dir.is_dir() else "disabled")
        self.report_button.configure(state="normal" if self.result_dir and (self.result_dir / "report.json").is_file() else "disabled")

    def _launch(self, fresh):
        if self.busy or self.closing:
            return
        self.result_dir = None
        self.worker_error = None
        self.active_path.set("正在检查新任务配置" if fresh else "正在检查恢复目录")
        self.set_busy(False)
        key = self.key.get().strip()
        self.redactor = Redactor(key)
        try:
            if fresh and not self.path.get().strip():
                raise ValueError("请选择新任务的输出父目录")
            if not key:
                raise ValueError("请填写 API Key，或点击“读取环境变量”")
            if not self.confirm.get():
                raise ValueError("请在模型设置中核对价格并勾选确认")
            budget = Budget(default_ledger(), parse_limit(self.budget.get()), Prices(float(self.input_price.get()), float(self.output_price.get())))
            self.cancel = threading.Event()
            base = self.base.get().strip()
            DeepSeek(key, budget, self.cancel, pricing_confirmed=True, provider="bailian", base_url=base, model="deepseek-v4-pro-0813")
            documents = load_inputs(Path(self.architecture.get()), Path(self.views.get())) if fresh else None
            provider_factory = lambda role, cancel: DeepSeek(key, budget, cancel, pricing_confirmed=True, provider="bailian", base_url=base, model="deepseek-v4-pro-0813")
            if self.coordinator:
                self.coordinator.close()
                self.coordinator = None
            try:
                while True:
                    self.events.get_nowait()
            except queue.Empty:
                pass
            options = {"cancel": self.cancel, "allow_execution": self.execute.get(), "on_event": lambda kind, details: self.events.put((kind, self.redactor.value(details))), "secrets": (key,)}
            if fresh:
                self.coordinator = Coordinator.new_run(Path(self.path.get().strip()), documents, provider_factory, **options)
            else:
                if not self.restore_path.get().strip():
                    raise ValueError("请在项目与恢复页选择已有任务目录")
                self.coordinator = Coordinator.open_existing(Path(self.restore_path.get()), provider_factory, **options)
            self.result_dir = self.coordinator.directory.resolve()
            self.active_path.set(str(self.result_dir))
            self.logs.append("任务目录：" + str(self.result_dir))
            self.restore_path.set(str(self.result_dir))
            self.cursor.reset()
            self.resource.set("")
            if not fresh:
                unknown = any(a["state"] in ("pending", "unknown") for a in self.coordinator.store.all("attempt").values())
                if unknown or self.coordinator.store.get("run", "lease"):
                    if not messagebox.askyesno("中断恢复确认", "请确认旧程序已经退出。未完成请求可能已经收费。继续会保留原记录和费用预留，并允许再次发送未知请求，可能再次收费。是否继续？"):
                        self.status.set("已取消恢复，原始记录保持")
                        self.dirty = True
                        self.set_busy(False)
                        return
                    self.coordinator.acknowledge_recovery(abandon_unknown=True)
            self.set_busy(True)
            self.status.set("运行中 · 状态与证据持续保存到任务目录")
            coordinator, redactor = self.coordinator, self.redactor

            def work():
                try:
                    coordinator.run()
                except Exception as exc:
                    self.events.put(("ui_error", {"message": redactor.text(str(exc))}))
                finally:
                    self.events.put(("ui_idle", {}))
            self.worker = threading.Thread(target=work, daemon=False, name="superagent-coordinator")
            self.worker.start()
            self.dirty = True
        except Exception as exc:
            self.status.set("未启动 · 请检查配置")
            messagebox.showerror("无法启动", self.redactor.text(str(exc)))
            self.set_busy(False)

    def start(self):
        self._launch(True)

    def resume(self):
        self._launch(False)

    def pause(self):
        if self.busy and self.coordinator:
            self.coordinator.pause_requested.set()
            self.status.set("请求暂停 · 当前调用完成后在安全点保存")
            self.pause_button.configure(state="disabled")

    def request_cancel(self):
        self.cancel.set()
        self.status.set("正在取消并保存记录；远端请求费用仍可能发生")

    def refresh_view(self):
        if not self.coordinator:
            return
        store = self.coordinator.store
        tasks, attempts, jobs = store.all("task"), store.all("attempt"), store.all("job")
        update_tree(self.tasks, {k: ("", (k, "已合入" if t["state"] == "completed" else status_label(t["state"]), ", ".join(t.get("depends_on", [])), ", ".join(t["files"]))) for k, t in tasks.items()})
        known_cost = lambda t: sum(float(u.get("estimated_cny", 0)) for u in t.get("usage", []))
        update_tree(self.sessions, {k: ("", (t.get("role", ""), "响应已记录" if t["state"] == "completed" else status_label(t["state"]), f"{known_cost(t):.4f}" if t.get("usage") else "未知 / 保留预留" if t["state"] in ("pending", "unknown", "abandoned") else "未记录", k)) for k, t in attempts.items()})
        update_tree(self.checks, {k: ("", (t.get("profile", ""), status_label(t["state"]), status_label(t.get("result", {}).get("status")), t.get("snapshot", ""))) for k, t in jobs.items()})
        resources = store.resources()
        self.resource_choice.configure(values=[r["resource"] for r in resources])
        if not self.resource.get() and resources:
            self.resource.set(resources[0]["resource"])
        state = store.get("run", "state", {})
        label = status_label(state.get("state"))
        verification = state.get("verification")
        unknown = sum(t["state"] in ("pending", "unknown", "abandoned") for t in attempts.values())
        self.summary.set(label + (" · " + status_label(verification) if verification else "") + f" · {len(tasks)} 个工作项 / {len(attempts)} 次请求记录\n有效响应估算 {sum(known_cost(t) for t in attempts.values()):.4f} 元 · {unknown} 项未确认请求保留费用")
        if not self.busy:
            self.status.set("执行发生异常 · 详情见日志与已有任务记录" if self.worker_error else label + (" · " + status_label(verification) if verification else ""))
        self.set_busy(self.busy)

    def poll(self):
        try:
            for _ in range(150):
                kind, details = self.events.get_nowait()
                details = self.redactor.value(details)
                if kind == "ui_idle":
                    self.set_busy(False)
                else:
                    self.logs.append(kind + " " + json.dumps(details, ensure_ascii=False))
                    if kind == "ui_error":
                        self.worker_error = details.get("message", "未知异常")
                        self.status.set("执行发生异常 · 详情见日志与已有任务记录")
                self.dirty = True
        except queue.Empty:
            pass
        if self.dirty and time.monotonic() - self.last_refresh >= .25:
            try:
                self.refresh_view()
            except Exception as exc:
                self.logs.append("界面读取状态失败：" + self.redactor.text(str(exc)))
            self.dirty, self.last_refresh = False, time.monotonic()
        if self.closing and not self.busy and (self.worker is None or not self.worker.is_alive()):
            self.finish_close()
            return
        self.root.after(100, self.poll)

    def resource_changed(self, *_):
        self.cursor.reset()
        self.next_button.configure(state="disabled")

    def read_resource(self, continuation=False):
        if not self.coordinator:
            return
        try:
            resource = self.resource.get().strip()
            result = self.coordinator.store.read(resource, self.cursor.offset(resource, continuation))
            self.cursor.accept(result)
            self.resource_text.replace(self.redactor.text(result["text"]))
            self.resource_info.set(self.redactor.text(f"{result['summary']}\n字符位置 {result['offset']} / {result['total_chars']} · " + ("已到末页" if result['next_offset'] is None else "可继续读取")))
            self.next_button.configure(state="normal" if self.cursor.next_offset is not None else "disabled")
        except Exception as exc:
            messagebox.showerror("资源读取失败", self.redactor.text(str(exc)))

    def _open(self, path):
        try:
            os.startfile(str(path)) if os.name == "nt" else webbrowser.open(path.as_uri())
        except OSError as exc:
            messagebox.showerror("无法打开", self.redactor.text(str(exc)))

    def open_result(self):
        if self.result_dir and self.result_dir.is_dir():
            self._open(self.result_dir)

    def report(self):
        if self.result_dir and (self.result_dir / "report.json").is_file():
            self._open(self.result_dir / "report.json")

    def finish_close(self):
        if self.coordinator:
            self.coordinator.close()
            self.coordinator = None
        self.key.set("")
        self.root.destroy()

    def close(self):
        self.closing = True
        if self.busy or (self.worker and self.worker.is_alive()):
            self.request_cancel()
            self.set_busy(self.busy)
        else:
            self.finish_close()


def main():
    setup_dpi()
    root = tk.Tk()
    Application(root)
    root.mainloop()


if __name__ == "__main__":
    main()
