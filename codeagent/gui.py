import json
import os
import queue
import sys
import threading
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from .budget import Budget, Prices, default_ledger
from .config import user_variable
from .engine import Agent
from .inputs import load_inputs
from .provider import API_ROOT, DeepSeek
from .safety import Redactor

PHASE_LABELS = {"initializing": "准备", "planning": "理解与规划", "generation": "项目生成", "verification": "质量验证", "repair": "反馈修复", "finished": "任务结束"}


class Application:
    def __init__(self, root):
        self.root = root
        root.title("DesignCodeAgent · 设计到代码")
        root.geometry("1080x850")
        root.minsize(940, 760)
        root.configure(bg="#f2f5f9")
        self.events = queue.Queue()
        self.cancel = threading.Event()
        self.busy = False
        self.result_dir = None
        self.status = tk.StringVar(value="就绪 · 选择输入文档，开始生成")
        self.provider_name = tk.StringVar(value="百炼（第三方）" if user_variable("DASHSCOPE_API_KEY") else "DeepSeek 官方")
        self.api_key = tk.StringVar()
        self.base_url = tk.StringVar()
        self.model = tk.StringVar(value="deepseek-v4-pro")
        self.input_price = tk.StringVar()
        self.output_price = tk.StringVar()
        self.budget = tk.StringVar(value="50")
        self.pricing_confirmed = tk.BooleanVar(value=False)
        self.allow_execution = tk.BooleanVar(value=False)
        base = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path.cwd()
        examples = base / "examples" / "inputs"
        if not examples.exists():
            examples = base
        self.architecture = tk.StringVar(value=str(examples / "Architecture_Documentation.md") if (examples / "Architecture_Documentation.md").exists() else "")
        self.views = tk.StringVar(value=str(examples / "Architecture_View.md") if (examples / "Architecture_View.md").exists() else "")
        self.output = tk.StringVar(value=str(Path.home() / "Documents" / "DesignCodeAgent"))
        style = ttk.Style(root)
        style.theme_use("clam")
        style.configure("TFrame", background="#f2f5f9")
        style.configure("TLabel", background="#f2f5f9", foreground="#24334b", font=("Microsoft YaHei UI", 10))
        style.configure("TLabelframe", background="#f2f5f9")
        style.configure("TLabelframe.Label", background="#f2f5f9", foreground="#19334f", font=("Microsoft YaHei UI", 11, "bold"))
        style.configure("TButton", font=("Microsoft YaHei UI", 10), padding=(12, 6))
        style.configure("Primary.TButton", background="#176b70", foreground="white")
        style.configure("TCheckbutton", background="#f2f5f9", font=("Microsoft YaHei UI", 9))
        header = tk.Frame(root, bg="#142c48", padx=24, pady=16)
        header.pack(fill="x")
        tk.Label(header, text="DesignCodeAgent", bg="#142c48", fg="white", font=("Segoe UI", 22, "bold")).pack(anchor="w")
        tk.Label(header, text="架构理解  /  工具调用  /  测试反馈  /  可追溯交付", bg="#142c48", fg="#b7d4df", font=("Microsoft YaHei UI", 10)).pack(anchor="w", pady=(4, 0))
        body = ttk.Frame(root, padding=(22, 12))
        body.pack(fill="both", expand=True)
        body.columnconfigure(0, weight=1)
        body.rowconfigure(3, weight=1)
        account = ttk.LabelFrame(body, text="01  模型连接与预算", padding=10)
        account.grid(row=0, column=0, sticky="ew")
        account.columnconfigure(1, weight=1)
        account.columnconfigure(3, weight=1)
        ttk.Label(account, text="平台").grid(row=0, column=0, sticky="w", padx=(0, 8))
        combo = ttk.Combobox(account, textvariable=self.provider_name, values=("DeepSeek 官方", "百炼（第三方）"), state="readonly", width=21)
        combo.grid(row=0, column=1, sticky="ew")
        combo.bind("<<ComboboxSelected>>", lambda _: self.platform_changed())
        ttk.Label(account, text="模型").grid(row=0, column=2, padx=10)
        ttk.Combobox(account, textvariable=self.model, values=("deepseek-v4-pro", "deepseek-v4-pro-0813"), state="readonly", width=28).grid(row=0, column=3, sticky="ew")
        self.entry_row(account, "Base URL", self.base_url, 1, columnspan=3)
        ttk.Label(account, text="API Key").grid(row=2, column=0, sticky="w", pady=5)
        ttk.Entry(account, textvariable=self.api_key, show="●").grid(row=2, column=1, columnspan=2, sticky="ew")
        ttk.Button(account, text="读取环境变量", command=self.read_key).grid(row=2, column=3, sticky="e")
        price = ttk.Frame(account)
        price.grid(row=3, column=0, columnspan=4, sticky="ew", pady=5)
        for label, variable, width in (("输入 元/百万 tokens", self.input_price, 8), ("输出 元/百万 tokens", self.output_price, 8), ("累计上限 元（≤50）", self.budget, 6)):
            ttk.Label(price, text=label).pack(side="left", padx=(0, 6))
            ttk.Entry(price, textvariable=variable, width=width).pack(side="left", padx=(0, 16))
        ttk.Checkbutton(account, text="已核对当前官方计价；上述单价为本地域 / 模型价格的上界（不扣优惠）", variable=self.pricing_confirmed).grid(row=4, column=0, columnspan=4, sticky="w")
        ttk.Button(account, text="查看计价说明", command=self.open_pricing).grid(row=5, column=0, columnspan=2, sticky="w")
        self.connection_button = ttk.Button(account, text="测试连接（少量付费）", command=lambda: self.start("connection"))
        self.connection_button.grid(row=5, column=2, columnspan=2, sticky="e")
        inputs = ttk.LabelFrame(body, text="02  输入与输出", padding=10)
        inputs.grid(row=1, column=0, sticky="ew", pady=10)
        inputs.columnconfigure(1, weight=1)
        for row, (label, variable) in enumerate((("架构文档", self.architecture), ("架构视图", self.views), ("输出目录", self.output))):
            ttk.Label(inputs, text=label).grid(row=row, column=0, padx=(0, 10), pady=4)
            ttk.Entry(inputs, textvariable=variable).grid(row=row, column=1, sticky="ew", padx=(0, 8))
            ttk.Button(inputs, text="选择…", command=lambda v=variable, d=row == 2: self.browse(v, d)).grid(row=row, column=2)
        ttk.Checkbutton(inputs, text="允许执行生成项目的依赖安装和测试脚本（当前用户权限，非沙箱；项目运行另需 Node.js / Docker）", variable=self.allow_execution).grid(row=3, column=0, columnspan=3, sticky="w", pady=(6, 0))
        actions = ttk.Frame(body)
        actions.grid(row=2, column=0, sticky="ew", pady=(0, 10))
        self.run_button = ttk.Button(actions, text="开始生成", style="Primary.TButton", command=lambda: self.start("run"))
        self.run_button.pack(side="left")
        self.preview_button = ttk.Button(actions, text="解析预览（免费）", command=self.preview)
        self.preview_button.pack(side="left", padx=8)
        self.cancel_button = ttk.Button(actions, text="取消任务", command=self.request_cancel, state="disabled")
        self.cancel_button.pack(side="left")
        ttk.Button(actions, text="打开结果目录", command=self.open_output).pack(side="right")
        self.progress = ttk.Progressbar(actions, mode="indeterminate", length=130)
        self.progress.pack(side="right", padx=12)
        logframe = ttk.LabelFrame(body, text="03  执行记录", padding=8)
        logframe.grid(row=3, column=0, sticky="nsew")
        self.log = tk.Text(logframe, bg="#182b42", fg="#d4e5f1", insertbackground="white", font=("Consolas", 10), wrap="word", height=9, relief="flat", padx=10, pady=8, state="disabled")
        scrollbar = ttk.Scrollbar(logframe, command=self.log.yview)
        scrollbar.pack(side="right", fill="y")
        self.log.configure(yscrollcommand=scrollbar.set)
        self.log.pack(fill="both", expand=True)
        ttk.Label(body, textvariable=self.status).grid(row=4, column=0, sticky="w", pady=(8, 0))
        self.platform_changed()
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.after(100, self.poll)

    def entry_row(self, parent, label, variable, row, columnspan=1):
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", pady=5)
        ttk.Entry(parent, textvariable=variable).grid(row=row, column=1, columnspan=columnspan, sticky="ew")

    def platform_changed(self):
        bailian = self.provider_name.get().startswith("百炼")
        self.model.set(user_variable("DASHSCOPE_MODEL") or "deepseek-v4-pro-0813" if bailian else "deepseek-v4-pro")
        self.base_url.set(user_variable("DASHSCOPE_BASE_URL") or "https://dashscope.aliyuncs.com/compatible-mode/v1" if bailian else API_ROOT)
        self.input_price.set("12" if bailian else "10.56")
        self.output_price.set("27" if bailian else "31.68")
        self.pricing_confirmed.set(False)
        self.read_key()

    def read_key(self):
        self.api_key.set(user_variable("DASHSCOPE_API_KEY" if self.provider_name.get().startswith("百炼") else "DEEPSEEK_API_KEY"))

    def browse(self, variable, directory):
        value = filedialog.askdirectory() if directory else filedialog.askopenfilename(filetypes=[("Markdown", "*.md"), ("所有文件", "*.*")])
        if value:
            variable.set(value)

    def append(self, text):
        self.log.configure(state="normal")
        self.log.insert("end", text + "\n")
        if int(self.log.index("end-1c").split(".")[0]) > 1200:
            self.log.delete("1.0", "300.0")
        self.log.see("end")
        self.log.configure(state="disabled")

    def preview(self):
        try:
            data = load_inputs(Path(self.architecture.get()), Path(self.views.get()))
            self.append(f"解析完成：{len(data['documents'])} 份文档，{data['diagram_count']} 个图，{len(data['issues'])} 条确定性提示。")
            for issue in data["issues"]:
                self.append(json.dumps(issue, ensure_ascii=False))
        except Exception as exc:
            messagebox.showerror("输入检查", str(exc))

    def start(self, mode):
        if self.busy:
            return
        try:
            self.cancel.clear()
            provider = DeepSeek(self.api_key.get(), Budget(default_ledger(), float(self.budget.get()), Prices(float(self.input_price.get()), float(self.output_price.get()))), self.cancel,
                                pricing_confirmed=self.pricing_confirmed.get(), provider="bailian" if self.provider_name.get().startswith("百炼") else "deepseek",
                                base_url=self.base_url.get(), model=self.model.get())
            arch, views, output = Path(self.architecture.get()), Path(self.views.get()), Path(self.output.get())
            if mode == "run":
                load_inputs(arch, views)
            allow = self.allow_execution.get()
        except Exception as exc:
            messagebox.showerror("配置检查", str(exc))
            return
        self.busy = True
        for button in (self.run_button, self.connection_button, self.preview_button):
            button.configure(state="disabled")
        self.cancel_button.configure(state="normal")
        self.progress.start(12)
        self.status.set("连接测试中…" if mode == "connection" else "正在启动 Agent…")
        redactor = Redactor(provider.api_key)

        def worker():
            try:
                if mode == "connection":
                    result = provider.test_connection()
                    self.events.put({"event": "connection", "result": redactor.value(result)})
                else:
                    agent = Agent(provider, self.cancel, self.events.put, allow_execution=allow)
                    result_dir, report = agent.run(arch, views, output)
                    self.events.put({"event": "result", "path": str(result_dir), "status": report["status"]})
            except Exception as exc:
                self.events.put({"event": "error", "message": redactor.text(str(exc))})
            finally:
                self.events.put({"event": "idle"})
        threading.Thread(target=worker, daemon=False).start()

    def poll(self):
        try:
            while True:
                event = self.events.get_nowait()
                kind = event["event"]
                if kind == "idle":
                    self.busy = False
                    self.progress.stop()
                    for button in (self.run_button, self.connection_button, self.preview_button):
                        button.configure(state="normal")
                    self.cancel_button.configure(state="disabled")
                elif kind == "phase_started":
                    self.status.set(PHASE_LABELS.get(event["phase"], event["phase"]) + (" · " + event["task"] if event.get("task") else ""))
                    self.append("→ " + self.status.get())
                elif kind == "tool_result":
                    self.append(f"  {event['tool']}  {json.dumps(event['result'], ensure_ascii=False)[:450]}")
                elif kind == "assistant":
                    if event["message"].get("content"):
                        self.append(event["message"]["content"][:600])
                elif kind == "result":
                    self.result_dir = event["path"]
                    self.status.set("任务结束 · " + event["status"])
                    self.append("结果：" + event["path"] + "\n状态：" + event["status"])
                elif kind == "error":
                    self.status.set("执行未完成 · 查看错误信息")
                    self.append("错误：" + event["message"])
                elif kind == "connection":
                    self.status.set("连接成功 · " + event["result"]["model"])
                    self.append(json.dumps(event["result"], ensure_ascii=False))
                elif kind != "run_finished":
                    self.append(json.dumps(event, ensure_ascii=False)[:500])
        except queue.Empty:
            pass
        self.root.after(100, self.poll)

    def request_cancel(self):
        self.cancel.set()
        self.status.set("正在取消… 网络请求最长可能需 90 秒结束；已产生的用量会保留")

    def open_output(self):
        path = Path(self.result_dir or self.output.get())
        if path.exists():
            os.startfile(str(path)) if os.name == "nt" else webbrowser.open(path.as_uri())

    def open_pricing(self):
        webbrowser.open("https://help.aliyun.com/zh/model-studio/deepseek-v4-pro" if self.provider_name.get().startswith("百炼") else "https://api-docs.deepseek.com/quick_start/pricing/")

    def close(self):
        if self.busy:
            self.request_cancel()
            self.append("请等待任务取消后再关闭，以确保费用和结果写入完成。")
        else:
            self.api_key.set("")
            self.root.destroy()


def main():
    root = tk.Tk()
    Application(root)
    root.mainloop()


if __name__ == "__main__":
    main()
