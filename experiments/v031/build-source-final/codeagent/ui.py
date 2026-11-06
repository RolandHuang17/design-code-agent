"""Shared, dependency-free desktop presentation. No credentials are persisted."""
import os
import tkinter as tk
from dataclasses import dataclass
from tkinter import ttk

BG, PANEL, BORDER = "#f4f5f7", "#ffffff", "#dbe0e7"
TEXT, MUTED, BLUE = "#202a37", "#657182", "#245d9e"
STATUS_LABELS = {
    "pending": "待执行 / 已暂停", "running": "执行中", "waiting_check": "等待检查",
    "completed": "处理结束", "cancelled": "已取消", "failed": "失败", "blocked": "受阻",
    "passed": "通过", "unverified": "未验证", "not_applicable": "不适用",
    "checks_passed_requires_review": "自动检查通过，仍需审阅",
    "completed_with_gaps": "生成结束，部分检查未验证", "stale": "结果已过期",
    "unknown": "请求结果未知", "abandoned": "未知请求已保留", "truncated": "响应截断",
}


def status_label(value):
    return STATUS_LABELS.get(value, value or "尚无记录")


def setup_dpi():
    if os.name == "nt":
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except (AttributeError, OSError):
            pass


def protect_secret(entry):
    """Prevent Windows IME composition from exposing an ASCII API key."""
    if os.name != "nt":
        return
    import ctypes
    associate = ctypes.windll.imm32.ImmAssociateContext
    associate.argtypes = (ctypes.c_void_p, ctypes.c_void_p)
    associate.restype = ctypes.c_void_p
    state = {"active": False, "context": None}

    def focus_in(_):
        if not state["active"]:
            state.update(active=True, context=associate(entry.winfo_id(), None))

    def focus_out(_):
        if state["active"]:
            associate(entry.winfo_id(), state["context"])
            state.update(active=False, context=None)

    entry.bind("<FocusIn>", focus_in, add="+")
    entry.bind("<FocusOut>", focus_out, add="+")


def workbench(root, title, subtitle):
    root.title(title)
    width, height = min(1180, root.winfo_screenwidth() - 70), min(820, root.winfo_screenheight() - 90)
    root.geometry(f"{width}x{height}")
    root.minsize(min(900, width), min(600, height))
    root.configure(background=BG)
    style = ttk.Style(root)
    style.theme_use("clam")
    style.configure(".", font=("Microsoft YaHei UI", 10), foreground=TEXT, background=BG)
    style.configure("TFrame", background=BG)
    style.configure("Panel.TFrame", background=PANEL)
    style.configure("TLabel", background=BG)
    style.configure("Muted.TLabel", foreground=MUTED)
    style.configure("Title.TLabel", font=("Microsoft YaHei UI", 15, "bold"))
    style.configure("TButton", padding=(10, 6), borderwidth=1)
    style.configure("Primary.TButton", background=BLUE, foreground="white")
    style.map("Primary.TButton", background=[("disabled", "#dce2e9"), ("pressed", "#194779"), ("active", "#316eaf")],
              foreground=[("disabled", "#788391")])
    style.configure("TEntry", fieldbackground=PANEL, padding=5)
    style.configure("TCombobox", padding=4)
    style.configure("TNotebook", background=BG, borderwidth=0)
    style.configure("TNotebook.Tab", padding=(12, 7))
    style.configure("Treeview", background=PANEL, fieldbackground=PANEL, rowheight=29, borderwidth=0)
    style.configure("Treeview.Heading", font=("Microsoft YaHei UI", 9, "bold"), padding=6)
    style.map("Treeview", background=[("selected", "#dce9f7")], foreground=[("selected", TEXT)])
    header = ttk.Frame(root, padding=(18, 12))
    header.pack(fill="x")
    ttk.Label(header, text=title.split(" · ")[0], style="Title.TLabel").pack(side="left")
    ttk.Label(header, text=subtitle, style="Muted.TLabel").pack(side="left", padx=16)
    ttk.Separator(root).pack(fill="x")
    footer = ttk.Frame(root, padding=(14, 10))
    footer.pack(side="bottom", fill="x")
    ttk.Separator(root).pack(side="bottom", fill="x")
    panes = ttk.Panedwindow(root, orient="horizontal")
    panes.pack(fill="both", expand=True, padx=14, pady=12)
    left, right = ttk.Frame(panes, width=320), ttk.Frame(panes)
    panes.add(left, weight=0)
    panes.add(right, weight=1)
    root.after_idle(lambda: panes.sashpos(0, 320))
    return left, right, footer


class ScrollPanel(ttk.Frame):
    def __init__(self, parent):
        super().__init__(parent)
        canvas = tk.Canvas(self, bg=BG, highlightthickness=0, width=280)
        bar = ttk.Scrollbar(self, orient="vertical", command=canvas.yview)
        bar.pack(side="right", fill="y")
        canvas.pack(fill="both", expand=True)
        canvas.configure(yscrollcommand=bar.set)
        self.content = ttk.Frame(canvas, padding=(10, 10, 12, 12))
        window = canvas.create_window((0, 0), window=self.content, anchor="nw")
        canvas.bind("<Configure>", lambda e: canvas.itemconfigure(window, width=e.width))
        self.content.bind("<Configure>", lambda _: canvas.configure(scrollregion=canvas.bbox("all")))

        def wheel(event):
            if canvas.winfo_exists() and canvas.winfo_height() < self.content.winfo_reqheight():
                canvas.yview_scroll(-int(event.delta / 120) if event.delta else 0, "units")
                return "break"

        def bind_children(widget):
            widget.bind("<MouseWheel>", wheel, add="+")
            for child in widget.winfo_children():
                bind_children(child)
        self.bind_wheel = lambda: bind_children(self)


class Controls:
    def __init__(self):
        self.items = []

    def add(self, widget, state="normal"):
        self.items.append((widget, state))
        return widget

    def enabled(self, enabled):
        for widget, state in self.items:
            widget.configure(state=state if enabled else "disabled")


def field(parent, label, variable, controls, *, browse=None, values=None, secret=False):
    ttk.Label(parent, text=label).pack(anchor="w", pady=(10, 4))
    row = ttk.Frame(parent)
    row.pack(fill="x")
    if values:
        entry = ttk.Combobox(row, textvariable=variable, values=values, state="readonly", width=12)
        controls.add(entry, "readonly")
    else:
        entry = controls.add(ttk.Entry(row, textvariable=variable, show="●" if secret else "", width=12))
    entry.pack(side="left", fill="x", expand=True)
    if secret:
        protect_secret(entry)
    if browse:
        controls.add(ttk.Button(row, text="选择", command=browse, width=5)).pack(side="left", padx=(5, 0))
    return entry


def note(parent, text):
    ttk.Label(parent, text=text, style="Muted.TLabel", wraplength=270, justify="left").pack(anchor="w", pady=(7, 2))


class TextArea(ttk.Frame):
    def __init__(self, parent, *, code=False):
        super().__init__(parent)
        self.text = tk.Text(self, width=1, height=1, wrap="word", background=PANEL, foreground=TEXT,
                            font=("Consolas", 10) if code else ("Microsoft YaHei UI", 10),
                            relief="flat", borderwidth=0, padx=14, pady=12, state="disabled", takefocus=True)
        scroll = ttk.Scrollbar(self, orient="vertical", command=self.text.yview)
        scroll.pack(side="right", fill="y")
        self.text.configure(yscrollcommand=scroll.set)
        self.text.pack(fill="both", expand=True)

    def append(self, text):
        widget = self.text
        bottom = widget.yview()[1] >= .98
        widget.configure(state="normal")
        widget.insert("end", str(text)[:16000] + "\n")
        lines = int(widget.index("end-1c").split(".")[0])
        if lines > 1800:
            widget.delete("1.0", f"{lines - 1500}.0")
        if int(widget.count("1.0", "end", "chars")[0]) > 220000:
            widget.delete("1.0", "end-160000c")
        if bottom:
            widget.see("end")
        widget.configure(state="disabled")

    def replace(self, text):
        self.text.configure(state="normal")
        self.text.delete("1.0", "end")
        self.text.configure(state="disabled")
        self.append(text)


@dataclass
class PageCursor:
    resource: str = ""
    next_offset: int | None = None

    def reset(self):
        self.resource, self.next_offset = "", None

    def offset(self, resource, continuation):
        if not continuation:
            return 0
        if resource != self.resource or self.next_offset is None:
            raise ValueError("请选择资源并读取首页；当前已到末页或资源已改变")
        return self.next_offset

    def accept(self, result):
        self.resource, self.next_offset = result["resource"], result.get("next_offset")


def update_tree(tree, rows):
    """Stable IDs preserve selection and scroll while background events arrive."""
    old = set(tree.get_children())
    for key, (text, values) in rows.items():
        if key in old:
            tree.item(key, text=text, values=values)
        else:
            tree.insert("", "end", iid=key, text=text, values=values)
    for key in old - rows.keys():
        tree.delete(key)


def tree_panel(parent, columns, headings, widths):
    frame = ttk.Frame(parent)
    tree = ttk.Treeview(frame, columns=columns, show="headings", height=7)
    for key, label, width in zip(columns, headings, widths):
        tree.heading(key, text=label)
        tree.column(key, width=width, minwidth=70, stretch=key == columns[-1])
    tree.grid(row=0, column=0, sticky="nsew")
    ttk.Scrollbar(frame, command=tree.yview).grid(row=0, column=1, sticky="ns")
    ybar = frame.grid_slaves(row=0, column=1)[0]
    xbar = ttk.Scrollbar(frame, orient="horizontal", command=tree.xview)
    xbar.grid(row=1, column=0, sticky="ew")
    tree.configure(yscrollcommand=ybar.set, xscrollcommand=xbar.set)
    frame.rowconfigure(0, weight=1)
    frame.columnconfigure(0, weight=1)
    return frame, tree
