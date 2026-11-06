"""Main desktop: a fixed workbench around the existing single controller."""
import json
import os
import queue
import sys
import threading
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from . import __version__
from .budget import Budget, Prices, default_ledger, parse_limit
from .config import user_variable
from .engine import Agent
from .inputs import load_inputs
from .provider import API_ROOT, DeepSeek
from .safety import Redactor
from .ui import Controls, ScrollPanel, TextArea, field, note, setup_dpi, status_label, workbench

PHASE_LABELS = {"initializing": "准备", "planning": "理解与规划", "generation": "项目生成", "verification": "质量验证", "repair": "反馈修复", "replan": "调整修复策略", "finished": "任务结束"}


class Application:
    def __init__(self, root):
        self.root = root
        self.events, self.cancel = queue.Queue(), threading.Event()
        self.busy = self.closing = False
        self.worker = None
        self.result_dir = None
        self.last_report = None
        self.status = tk.StringVar(value="就绪 · 先检查输入，再开始生成")
        self.phase = tk.StringVar(value="尚未开始")
        self.task = tk.StringVar(value="选择两份 Markdown 架构文档")
        self.provider_name = tk.StringVar(value="百炼（第三方）" if user_variable("DASHSCOPE_API_KEY") else "DeepSeek 官方")
        self.api_key, self.base_url, self.model = tk.StringVar(), tk.StringVar(), tk.StringVar()
        self.input_price, self.output_price = tk.StringVar(), tk.StringVar()
        self.budget = tk.StringVar(value=user_variable("DESIGN_CODE_AGENT_BUDGET_CNY") or "50")
        self.pricing_confirmed, self.allow_execution = tk.BooleanVar(), tk.BooleanVar()
        self.acceptance_profile, self.repair_rounds = tk.StringVar(value="generic-node"), tk.StringVar(value="3")
        base = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path.cwd()
        examples = base / "examples" / "inputs"
        if not examples.exists():
            examples = base
        self.architecture = tk.StringVar(value=str(examples / "Architecture_Documentation.md") if (examples / "Architecture_Documentation.md").exists() else "")
        self.views = tk.StringVar(value=str(examples / "Architecture_View.md") if (examples / "Architecture_View.md").exists() else "")
        self.output = tk.StringVar(value=str(Path.home() / "Documents" / "DesignCodeAgent"))
        left, right, footer = workbench(root, f"DesignCodeAgent {__version__} · 设计到代码", "设计到代码工作台")
        self.controls = Controls()
        settings = ttk.Notebook(left)
        settings.pack(fill="both", expand=True)
        project, model = ScrollPanel(settings), ScrollPanel(settings)
        settings.add(project, text="项目")
        settings.add(model, text="模型设置")
        p, m = project.content, model.content
        for label, variable, directory in [("架构文档", self.architecture, False), ("架构视图", self.views, False), ("输出父目录", self.output, True)]:
            field(p, label, variable, self.controls, browse=lambda v=variable, d=directory: self.browse(v, d))
        note(p, "每次生成建立独立任务目录，保留原始输入和检查记录。")
        field(p, "案例补充与验收", self.acceptance_profile, self.controls, values=("generic-node", "space-fractions", "library"))
        note(p, "新文档选 generic-node；原始游戏材料选 space-fractions。案例模式会另载接口补充。")
        field(p, "最多修复轮数（0 表示不修复）", self.repair_rounds, self.controls, values=tuple(str(n) for n in range(11)))
        self.controls.add(ttk.Checkbutton(p, text="允许执行生成项目与 Docker 验收", variable=self.allow_execution)).pack(anchor="w", pady=(15, 0))
        note(p, "需要 Node.js / Docker，以当前用户权限运行，目录边界不是系统沙箱。")
        combo = field(m, "平台", self.provider_name, self.controls, values=("百炼（第三方）", "DeepSeek 官方"))
        combo.bind("<<ComboboxSelected>>", lambda _: self.platform_changed())
        field(m, "模型", self.model, self.controls, values=("deepseek-v4-pro-0813", "deepseek-v4-pro"))
        field(m, "Base URL", self.base_url, self.controls)
        field(m, "API Key", self.api_key, self.controls, secret=True)
        self.controls.add(ttk.Button(m, text="读取环境变量", command=self.read_key)).pack(anchor="w", pady=(7, 0))
        note(m, "密钥仅存于内存；读取对应平台的用户环境变量。")
        for label, variable in [("输入价 · 元 / 百万 tokens", self.input_price), ("输出价 · 元 / 百万 tokens", self.output_price), ("累计预算 · 元，可填写“不限”", self.budget)]:
            field(m, label, variable, self.controls)
        self.controls.add(ttk.Checkbutton(m, text="已核对本地域、模型价格上界", variable=self.pricing_confirmed)).pack(anchor="w", pady=(12, 4))
        self.controls.add(ttk.Button(m, text="查看计价说明", command=self.open_pricing)).pack(anchor="w", pady=4)
        self.connection_button = self.controls.add(ttk.Button(m, text="测试连接（少量付费）", command=lambda: self.start("connection")))
        self.connection_button.pack(anchor="w", pady=4)
        project.bind_wheel()
        model.bind_wheel()
        summary = ttk.Frame(right, padding=(14, 8, 8, 12))
        summary.pack(fill="x")
        ttk.Label(summary, textvariable=self.phase, font=("Microsoft YaHei UI", 12, "bold")).pack(anchor="w")
        ttk.Label(summary, textvariable=self.task, style="Muted.TLabel", wraplength=580).pack(anchor="w", pady=(6, 0))
        self.tabs = ttk.Notebook(right)
        self.tabs.pack(fill="both", expand=True)
        self.activity, self.details, self.results = TextArea(self.tabs), TextArea(self.tabs, code=True), TextArea(self.tabs)
        for area, title in [(self.activity, "执行概况"), (self.details, "详细日志"), (self.results, "结果")]:
            self.tabs.add(area, text=title)
        self.log = self.details.text  # Kept for existing desktop instrumentation.
        self.activity.append("从左侧选择输入。解析预览不调用模型；真实生成需在“模型设置”中确认价格。")
        self.results.append("本次任务的状态、验证结果和目录将在这里显示。未运行的检查不计为通过。")
        self.preview_button = ttk.Button(footer, text="解析预览", command=self.preview)
        self.preview_button.pack(side="left")
        self.run_button = ttk.Button(footer, text="开始生成", style="Primary.TButton", command=lambda: self.start("run"))
        self.run_button.pack(side="left", padx=7)
        self.cancel_button = ttk.Button(footer, text="取消", command=self.request_cancel, state="disabled")
        self.cancel_button.pack(side="left")
        self.output_button = ttk.Button(footer, text="打开结果", command=self.open_output, state="disabled")
        self.output_button.pack(side="right")
        self.progress = ttk.Progressbar(footer, mode="indeterminate", length=90)
        self.progress.pack(side="right", padx=10)
        self.status_bar = ttk.Label(root, textvariable=self.status, style="Muted.TLabel", padding=(16, 5), wraplength=900)
        self.status_bar.pack(side="bottom", fill="x", before=footer)
        self.platform_changed()
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.after(100, self.poll)

    def safe(self, text):
        return Redactor(self.api_key.get()).text(str(text))

    def platform_changed(self):
        bailian = self.provider_name.get().startswith("百炼")
        self.model.set((user_variable("DASHSCOPE_MODEL") or "deepseek-v4-pro-0813") if bailian else "deepseek-v4-pro")
        self.base_url.set((user_variable("DASHSCOPE_BASE_URL") or "https://dashscope.aliyuncs.com/compatible-mode/v1") if bailian else API_ROOT)
        self.input_price.set("12" if bailian else "10.56")
        self.output_price.set("27" if bailian else "31.68")
        self.pricing_confirmed.set(False)
        self.read_key()

    def read_key(self):
        name = "DASHSCOPE_API_KEY" if self.provider_name.get().startswith("百炼") else "DEEPSEEK_API_KEY"
        self.api_key.set(user_variable(name, refresh=True))

    def browse(self, variable, directory=False):
        value = filedialog.askdirectory() if directory else filedialog.askopenfilename(filetypes=[("Markdown", "*.md"), ("所有文件", "*.*")])
        if value:
            variable.set(value)

    def append(self, text):
        self.activity.append(self.safe(text))

    def preview(self):
        try:
            data = load_inputs(Path(self.architecture.get()), Path(self.views.get()))
            self.phase.set("输入解析完成")
            self.task.set(f"{len(data['documents'])} 份文档 · {data['diagram_count']} 个图 · {len(data['issues'])} 条确定性提示")
            self.append(self.task.get())
            for issue in data["issues"]:
                self.append(json.dumps(issue, ensure_ascii=False))
            self.tabs.select(self.activity)
        except Exception as exc:
            messagebox.showerror("输入检查", self.safe(exc))

    def set_busy(self, busy):
        self.busy = busy
        self.controls.enabled(not busy and not self.closing)
        for button in (self.run_button, self.preview_button):
            button.configure(state="disabled" if busy or self.closing else "normal")
        self.cancel_button.configure(state="normal" if busy and not self.closing else "disabled")
        self.output_button.configure(state="normal" if self.result_dir and Path(self.result_dir).is_dir() else "disabled")
        self.progress.start(12) if busy else self.progress.stop()

    def start(self, mode):
        if self.busy or self.closing:
            return
        if mode == "run":
            self.result_dir = self.last_report = None
            self.output_button.configure(state="disabled")
            self.results.replace("正在建立新的独立任务；尚无本次结果。")
        try:
            if mode == "run" and not self.output.get().strip():
                raise ValueError("请选择新任务的输出父目录")
            self.cancel = threading.Event()
            provider = DeepSeek(self.api_key.get(), Budget(default_ledger(), parse_limit(self.budget.get()), Prices(float(self.input_price.get()), float(self.output_price.get()))), self.cancel,
                                pricing_confirmed=self.pricing_confirmed.get(), provider="bailian" if self.provider_name.get().startswith("百炼") else "deepseek", base_url=self.base_url.get(), model=self.model.get())
            arch, views, output = Path(self.architecture.get()), Path(self.views.get()), Path(self.output.get().strip())
            if mode == "run":
                load_inputs(arch, views)
            allow, profile, rounds = self.allow_execution.get(), self.acceptance_profile.get(), int(self.repair_rounds.get())
        except Exception as exc:
            messagebox.showerror("配置检查", self.safe(exc))
            return
        self.set_busy(True)
        self.status.set("连接测试中…" if mode == "connection" else "正在启动任务…")
        redactor = Redactor(provider.api_key)

        def emit(event):
            self.events.put(redactor.value(event))

        def worker():
            try:
                if mode == "connection":
                    emit({"event": "connection", "result": provider.test_connection()})
                else:
                    result_dir, report = Agent(provider, self.cancel, emit, allow_execution=allow, acceptance_profile=profile, max_repair_rounds=rounds).run(arch, views, output)
                    emit({"event": "result", "path": str(result_dir), "status": report["status"], "report": report})
            except Exception as exc:
                emit({"event": "error", "message": redactor.text(str(exc))})
            finally:
                emit({"event": "idle"})
        self.worker = threading.Thread(target=worker, daemon=False, name="design-code-agent")
        self.worker.start()

    def handle_event(self, event):
        kind = event.get("event")
        if kind != "idle":
            self.details.append(self.safe(json.dumps(event, ensure_ascii=False)))
        if kind == "idle":
            self.set_busy(False)
        elif kind == "run_started":
            self.result_dir = event["output"]
            self.output_button.configure(state="normal")
            self.append("任务目录：" + self.result_dir)
        elif kind == "phase_started":
            phase = PHASE_LABELS.get(event.get("phase"), event.get("phase", "执行中"))
            self.phase.set(phase)
            self.task.set(str(event.get("task") or "正在处理本阶段任务"))
            self.status.set(phase)
            self.append(phase + (" · " + str(event["task"]) if event.get("task") else ""))
        elif kind == "tool_result":
            result = event.get("result", {})
            if isinstance(result, dict):
                outcome = result.get("error") or status_label(result.get("status")) if result.get("status") or result.get("error") else "已返回结果"
            else:
                outcome = "已返回结果"
            self.append(f"{event.get('tool', '工具')} · {str(outcome)[:180]}")
        elif kind == "result":
            self.result_dir = event["path"]
            self.last_report = event.get("report", {})
            self.phase.set(status_label(event["status"]))
            self.status.set(self.phase.get())
            checks = self.last_report.get("checks", [])
            lines = [self.phase.get(), "", "任务目录：" + self.result_dir, "", "验证结果"]
            lines += [f"{c.get('profile', 'check')}：{status_label(c.get('status'))}" for c in checks]
            if "run_estimated_cny" in self.last_report:
                lines += ["", f"有效响应用量估算：{self.last_report['run_estimated_cny']:.4f} 元", "结果未知的请求费用仍按账本预留。"]
            self.results.replace(self.safe("\n".join(lines)))
            self.append(self.phase.get())
            self.tabs.select(self.results)
        elif kind == "error":
            self.status.set("执行未完成 · 查看详细日志")
            self.append("错误：" + str(event.get("message", "未知错误")))
        elif kind == "connection":
            self.status.set("连接成功 · " + event["result"]["model"])
            self.append(self.status.get())

    def poll(self):
        try:
            for _ in range(150):
                self.handle_event(self.events.get_nowait())
        except queue.Empty:
            pass
        if self.closing and not self.busy and (self.worker is None or not self.worker.is_alive()):
            self.api_key.set("")
            self.root.destroy()
            return
        self.root.after(100, self.poll)

    def request_cancel(self):
        self.cancel.set()
        self.status.set("正在取消并保存记录；远端请求可能仍收费")

    def open_output(self):
        if self.result_dir and Path(self.result_dir).is_dir():
            try:
                path = Path(self.result_dir).resolve()
                os.startfile(str(path)) if os.name == "nt" else webbrowser.open(path.as_uri())
            except OSError as exc:
                messagebox.showerror("无法打开结果", self.safe(exc))

    def open_pricing(self):
        webbrowser.open("https://help.aliyun.com/zh/model-studio/deepseek-v4-pro" if self.provider_name.get().startswith("百炼") else "https://api-docs.deepseek.com/quick_start/pricing/")

    def close(self):
        self.closing = True
        if self.busy or (self.worker is not None and self.worker.is_alive()):
            self.request_cancel()
            # idle may already be consumed while Thread.run is still unwinding.
            # Preserve busy; poll additionally waits for actual thread exit.
            self.set_busy(self.busy)
        else:
            self.api_key.set("")
            self.root.destroy()


def main():
    setup_dpi()
    root = tk.Tk()
    Application(root)
    root.mainloop()


if __name__ == "__main__":
    main()
