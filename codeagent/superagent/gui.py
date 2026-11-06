"""Standalone prototype desktop. Credentials stay in memory, not SQLite."""
import json
import os
import queue
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from ..budget import Budget, Prices, default_ledger, parse_limit
from ..config import user_variable
from ..inputs import load_inputs
from ..provider import DeepSeek
from .runtime import Coordinator


class Application:
    def __init__(self, root):
        self.root = root
        root.title("DesignCodeAgent-Superagent · 架构原型")
        root.geometry("1100x820")
        self.events = queue.Queue()
        self.coordinator = None
        self.worker = None
        self.cancel = threading.Event()
        self.path = tk.StringVar(value=str(Path.home() / "Documents" / "DesignCodeAgent-Superagent"))
        self.architecture = tk.StringVar()
        self.views = tk.StringVar()
        self.base = tk.StringVar(value=user_variable("DASHSCOPE_BASE_URL") or "https://dashscope.aliyuncs.com/compatible-mode/v1")
        self.key = tk.StringVar()
        self.input_price = tk.StringVar(value="12")
        self.output_price = tk.StringVar(value="27")
        self.budget = tk.StringVar(value="不限")
        self.confirm = tk.BooleanVar(value=False)
        self.execute = tk.BooleanVar(value=False)
        self.status = tk.StringVar(value="原型：真实独立模型会话，目录隔离不是系统沙箱；与正式工具分别验收")
        frame = ttk.Frame(root, padding=12)
        frame.pack(fill="both", expand=True)
        frame.columnconfigure(1, weight=1)
        row = 0

        def field(label, variable, browse=None, secret=False):
            nonlocal row
            ttk.Label(frame, text=label).grid(row=row, column=0, sticky="w", pady=3)
            ttk.Entry(frame, textvariable=variable, show="•" if secret else "").grid(row=row, column=1, sticky="ew", pady=3)
            if browse:
                ttk.Button(frame, text="选择", command=browse).grid(row=row, column=2)
            row += 1

        field("百炼 Base URL", self.base)
        field("API Key（英文粘贴）", self.key, secret=True)
        ttk.Button(frame, text="读取 DASHSCOPE_API_KEY", command=lambda: self.key.set(user_variable("DASHSCOPE_API_KEY"))).grid(row=row, column=1, sticky="w")
        row += 1
        ttk.Label(frame, text="固定模型：deepseek-v4-pro-0813").grid(row=row, column=1, sticky="w")
        row += 1
        field("输入价 元/百万tokens", self.input_price)
        field("输出价 元/百万tokens", self.output_price)
        field("累计预算（可填不限）", self.budget)
        ttk.Checkbutton(frame, text="已核对当前价格上界；真实调用会付费", variable=self.confirm).grid(row=row, column=1, sticky="w")
        row += 1
        field("架构文档", self.architecture, lambda: self._file(self.architecture))
        field("架构视图", self.views, lambda: self._file(self.views))
        field("新任务目录／恢复目录", self.path, self._directory)
        ttk.Checkbutton(frame, text="允许执行生成项目的固定安装、测试及构建（当前用户权限）", variable=self.execute).grid(row=row, column=1, sticky="w")
        row += 1
        controls = ttk.Frame(frame)
        controls.grid(row=row, column=0, columnspan=3, sticky="ew", pady=8)
        for label, action in [("新建并运行", self.start), ("恢复所选目录", self.resume), ("暂停", self.pause),
                              ("取消", self.cancel.set), ("打开结果", self.open_result), ("查看报告", self.report)]:
            ttk.Button(controls, text=label, command=action).pack(side="left", padx=3)
        row += 1
        ttk.Label(frame, textvariable=self.status, wraplength=1000).grid(row=row, column=0, columnspan=3, sticky="w")
        row += 1
        self.tasks = ttk.Treeview(frame, columns=("state", "dependencies", "files"), height=7)
        self.tasks.heading("#0", text="任务／角色")
        for key, label in [("state", "状态"), ("dependencies", "依赖"), ("files", "目标文件")]:
            self.tasks.heading(key, text=label)
        self.tasks.grid(row=row, column=0, columnspan=3, sticky="nsew")
        row += 1
        resource = ttk.Frame(frame)
        resource.grid(row=row, column=0, columnspan=3, sticky="ew")
        self.resource = tk.StringVar()
        self.offset = tk.IntVar(value=0)
        ttk.Entry(resource, textvariable=self.resource, width=90).pack(side="left", fill="x", expand=True)
        ttk.Button(resource, text="读取资源", command=self.read_resource).pack(side="left")
        ttk.Button(resource, text="下一页", command=lambda: self.read_resource(True)).pack(side="left")
        row += 1
        self.log = tk.Text(frame, height=12, wrap="word")
        self.log.grid(row=row, column=0, columnspan=3, sticky="nsew")
        frame.rowconfigure(row, weight=1)
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.after(150, self.poll)

    def _file(self, variable):
        value = filedialog.askopenfilename(filetypes=[("Markdown", "*.md"), ("All", "*.*")])
        if value:
            variable.set(value)

    def _directory(self):
        value = filedialog.askdirectory()
        if value:
            self.path.set(value)

    def _launch(self, fresh):
        if self.worker and self.worker.is_alive():
            messagebox.showinfo("任务进行中", "请等待当前任务结束或取消")
            return
        try:
            if not self.confirm.get():
                raise ValueError("请先核对价格并勾选确认")
            key = self.key.get().strip() or user_variable("DASHSCOPE_API_KEY")
            base = self.base.get().strip()
            budget = Budget(default_ledger(), parse_limit(self.budget.get()), Prices(float(self.input_price.get()), float(self.output_price.get())))
            self.cancel = threading.Event()
            # Validate credentials/configuration before persisting any task.
            DeepSeek(key, budget, self.cancel, pricing_confirmed=True, provider="bailian", base_url=base, model="deepseek-v4-pro-0813")
            documents = load_inputs(Path(self.architecture.get()), Path(self.views.get())) if fresh else None
            if self.coordinator:
                self.coordinator.close()
            self.coordinator = Coordinator(Path(self.path.get()), lambda role, cancel: DeepSeek(key, budget, cancel,
                pricing_confirmed=True, provider="bailian", base_url=base, model="deepseek-v4-pro-0813"), self.cancel,
                self.execute.get(), lambda kind, details: self.events.put((kind, details)))
            if fresh:
                self.coordinator.create(documents)
            else:
                if not self.coordinator.store.get("run", "state"):
                    raise ValueError("所选目录没有原型任务")
                unknown = any(a["state"] in ("pending", "unknown") for a in self.coordinator.store.all("attempt").values())
                lease = self.coordinator.store.get("run", "lease")
                if unknown or lease:
                    if not messagebox.askyesno("中断恢复确认", "请确认旧程序已经退出。存在未完成状态；请求可能已经收费。继续将保留原记录与费用预留，并允许重新发送未知请求，可能再次收费。是否继续？"):
                        return
                    self.coordinator.acknowledge_recovery(abandon_unknown=True)
            self.worker = threading.Thread(target=self.coordinator.run, daemon=True)
            self.worker.start()
            self.status.set("运行中：规划 → 隔离执行 → 宿主集成 → 只读审查 → 固定验证")
        except Exception as exc:
            messagebox.showerror("无法启动", str(exc))

    def start(self):
        self._launch(True)

    def resume(self):
        self._launch(False)

    def pause(self):
        if self.coordinator:
            self.coordinator.pause_requested.set()
            self.status.set("请求暂停：当前模型请求返回后，在下一安全点暂停")

    def poll(self):
        try:
            while True:
                kind, details = self.events.get_nowait()
                self.log.insert("end", kind + " " + json.dumps(details, ensure_ascii=False) + "\n")
                self.log.see("end")
                if kind == "created" and details.get("resources"):
                    self.resource.set(details["resources"][0]["resource"])
                if kind == "state":
                    self.status.set(details["state"] + " " + details.get("verification", details.get("reason", "")))
                if self.coordinator:
                    self.tasks.delete(*self.tasks.get_children())
                    for key, task in self.coordinator.store.all("task").items():
                        self.tasks.insert("", "end", text=key, values=(task["state"], ", ".join(task.get("depends_on", [])), ", ".join(task["files"])))
        except queue.Empty:
            pass
        self.root.after(150, self.poll)

    def read_resource(self, continuation=False):
        if not self.coordinator:
            return
        try:
            result = self.coordinator.store.read(self.resource.get(), self.offset.get() if continuation else 0)
            self.offset.set(result["next_offset"] or 0)
            self.log.insert("end", json.dumps(result, ensure_ascii=False, indent=2) + "\n")
            self.log.see("end")
        except Exception as exc:
            messagebox.showerror("资源读取失败", str(exc))

    def open_result(self):
        if Path(self.path.get()).is_dir():
            os.startfile(str(Path(self.path.get()).resolve()))

    def report(self):
        report = Path(self.path.get()) / "report.json"
        if report.is_file():
            os.startfile(str(report.resolve()))

    def close(self):
        if self.worker and self.worker.is_alive():
            self.cancel.set()
        self.root.destroy()


def main():
    root = tk.Tk()
    Application(root)
    root.mainloop()


if __name__ == "__main__":
    main()
