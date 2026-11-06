"""Desktop lifecycle regression. Fake providers only; no paid requests."""
import gc
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from codeagent.ui import PageCursor, TextArea, update_tree


def test_resource_cursor_cannot_rewind_eof_or_skip_a_new_resource():
    cursor = PageCursor()
    assert cursor.offset("a@version", False) == 0
    cursor.accept({"resource": "a@version", "next_offset": 4000})
    assert cursor.offset("a@version", True) == 4000
    with pytest.raises(ValueError):
        cursor.offset("b@version", True)
    cursor.accept({"resource": "a@version", "next_offset": None})
    with pytest.raises(ValueError):
        cursor.offset("a@version", True)


@pytest.fixture
def desktop(monkeypatch):
    import tkinter as tk
    import codeagent.gui as main
    import codeagent.superagent.gui as prototype
    monkeypatch.setattr(main, "user_variable", lambda *_args, **_kwargs: "")
    monkeypatch.setattr(prototype, "user_variable", lambda *_args, **_kwargs: "")
    try:
        root = tk.Tk()
    except tk.TclError:
        pytest.skip("Tk display is unavailable")
    root.withdraw()
    was_enabled = gc.isenabled()
    gc.disable()  # This isolated scenario owns all Tk objects; collect only on its main thread.
    yield root
    try:
        root.destroy()
    except tk.TclError:
        pass
    gc.collect()
    if was_enabled:
        gc.enable()


def test_main_current_directory_and_running_configuration(desktop, tmp_path):
    from codeagent.gui import Application
    app = Application(desktop)
    app.result_dir = str(tmp_path / "old")
    app.set_busy(True)
    assert all(str(w.cget("state")) == "disabled" for w, _ in app.controls.items)
    app.handle_event({"event": "run_started", "output": str(tmp_path)})
    assert app.result_dir == str(tmp_path)
    app.handle_event({"event": "result", "path": str(tmp_path), "status": "completed_with_gaps", "report": {"checks": [{"profile": "test", "status": "unverified"}]}})
    assert "未验证" in app.results.text.get("1.0", "end")
    app.handle_event({"event": "idle"})
    assert app.busy is False
    assert str(app.run_button.cget("state")) == "normal"


def test_main_invalid_new_run_does_not_offer_previous_result(desktop, tmp_path, monkeypatch):
    import codeagent.gui as gui
    app = gui.Application(desktop)
    app.result_dir = str(tmp_path)
    monkeypatch.setattr(gui.messagebox, "showerror", lambda *_: None)
    app.start("run")  # Empty fake key: local validation only.
    assert app.result_dir is None
    assert str(app.output_button.cget("state")) == "disabled"


def test_close_waits_for_worker_before_destroying_window(desktop):
    from codeagent.gui import Application
    app = Application(desktop)
    app.busy = True
    app.worker = SimpleNamespace(is_alive=lambda: True)
    app.close()
    assert app.closing and app.cancel.is_set()
    assert desktop.winfo_exists()
    assert str(app.run_button.cget("state")) == "disabled"


def test_prototype_binding_pagination_and_log_bounds(desktop, tmp_path):
    from codeagent.superagent.gui import Application
    app = Application(desktop)
    calls = []
    app.coordinator = SimpleNamespace(store=SimpleNamespace(read=lambda key, offset: calls.append((key, offset)) or {"resource": key, "text": "hello", "summary": "sample", "offset": offset, "total_chars": 5, "next_offset": None}))
    app.resource.set("original@hash")
    app.read_resource()
    assert calls == [("original@hash", 0)]
    assert str(app.next_button.cget("state")) == "disabled"
    app.result_dir = tmp_path
    app.path.set(str(tmp_path / "unrelated"))
    opened = []
    app._open = opened.append
    app.open_result()
    assert opened == [tmp_path]
    app.logs.append("bounded\n" * 3000)
    assert int(app.log.index("end-1c").split(".")[0]) <= 1801


def test_tree_updates_preserve_selection(desktop):
    from tkinter import ttk
    tree = ttk.Treeview(desktop)
    update_tree(tree, {"task-a": ("A", ("running",))})
    tree.selection_set("task-a")
    update_tree(tree, {"task-a": ("A", ("completed",)), "task-b": ("B", ("pending",))})
    assert tree.selection() == ("task-a",)
    assert tree.item("task-a", "values") == ("completed",)


def fake_prototype(monkeypatch, tmp_path, *, fail=False):
    import codeagent.superagent.gui as gui

    class FakeCoordinator:
        def __init__(self, cancel):
            self.cancel = cancel
            self.directory = tmp_path / "actual-child"
            self.directory.mkdir()
            self.pause_requested = threading.Event()
            self.state = {"state": "pending"}
            self.closed = False
            self.store = SimpleNamespace(all=lambda _: {}, resources=lambda: [],
                                         get=lambda kind, key, default=None: self.state if key == "state" else default)

        def run(self):
            if fail:
                raise RuntimeError("provider failed: test-secret-for-gui")
            self.cancel.wait(2)
            self.state.update(state="cancelled")
            (self.directory / "report.json").write_text(json.dumps(self.state))

        def close(self):
            self.closed = True

    captured = []

    def new_run(parent, documents, factory, **options):
        coordinator = FakeCoordinator(options["cancel"])
        captured.append(coordinator)
        return coordinator

    monkeypatch.setattr(gui, "Coordinator", SimpleNamespace(new_run=new_run))
    monkeypatch.setattr(gui, "DeepSeek", lambda *_a, **_k: object())
    monkeypatch.setattr(gui, "Budget", lambda *_: object())
    monkeypatch.setattr(gui, "load_inputs", lambda *_: {})
    return gui, captured


def test_prototype_close_waits_for_saved_report_and_closes_coordinator(desktop, tmp_path, monkeypatch):
    gui, captured = fake_prototype(monkeypatch, tmp_path)
    app = gui.Application(desktop)
    app.confirm.set(True)
    app.key.set("test-secret-for-gui")
    app.start()
    assert app.worker.daemon is False
    assert app.busy
    assert app.result_dir == captured[0].directory
    app.close()
    assert app.cancel.is_set() and desktop.winfo_exists()
    app.worker.join(timeout=3)
    assert not app.worker.is_alive()
    assert (captured[0].directory / "report.json").is_file()
    app.poll()
    assert captured[0].closed
    assert app.coordinator is None


def test_prototype_unexpected_worker_error_is_redacted_and_returns_idle(desktop, tmp_path, monkeypatch):
    gui, captured = fake_prototype(monkeypatch, tmp_path, fail=True)
    app = gui.Application(desktop)
    app.confirm.set(True)
    app.key.set("test-secret-for-gui")
    app.start()
    app.worker.join(timeout=3)
    app.poll()
    assert app.busy is False
    assert "异常" in app.status.get()
    assert "test-secret-for-gui" not in app.log.get("1.0", "end")
    assert "[REDACTED]" in app.log.get("1.0", "end")
    app.close()
    assert captured[0].closed


def test_main_close_after_idle_still_waits_for_live_thread(desktop):
    from codeagent.gui import Application
    app = Application(desktop)
    alive = [True]
    app.worker = SimpleNamespace(is_alive=lambda: alive[0])
    app.close()
    assert app.cancel.is_set() and desktop.winfo_exists()
    assert app.closing and not app.busy
    alive[0] = False
    app.poll()  # No second idle event is needed to finish closing.


def test_prototype_close_after_idle_does_not_wait_for_another_idle(desktop):
    from codeagent.superagent.gui import Application
    app = Application(desktop)
    alive = [True]
    app.worker = SimpleNamespace(is_alive=lambda: alive[0])
    app.close()
    assert app.cancel.is_set() and desktop.winfo_exists()
    assert app.closing and not app.busy
    alive[0] = False
    app.poll()


def test_main_blank_output_rejected_before_provider_or_agent(desktop, monkeypatch):
    import codeagent.gui as gui
    app = gui.Application(desktop)
    errors = []
    app.output.set("   ")
    monkeypatch.setattr(gui.messagebox, "showerror", lambda *args: errors.append(args))
    monkeypatch.setattr(gui, "DeepSeek", lambda *_a, **_k: pytest.fail("blank output must precede provider construction"))
    monkeypatch.setattr(gui, "Agent", lambda *_a, **_k: pytest.fail("blank output must not create a run"))
    app.start("run")
    assert errors and "输出父目录" in errors[0][1]
    assert app.worker is None and app.result_dir is None


def test_prototype_blank_parent_rejected_before_factory(desktop, monkeypatch):
    import codeagent.superagent.gui as gui
    app = gui.Application(desktop)
    errors = []
    app.path.set(" ")
    monkeypatch.setattr(gui.messagebox, "showerror", lambda *args: errors.append(args))
    monkeypatch.setattr(gui, "DeepSeek", lambda *_a, **_k: pytest.fail("blank parent must precede provider construction"))
    monkeypatch.setattr(gui, "Coordinator", SimpleNamespace(new_run=lambda *_a, **_k: pytest.fail("blank parent must not create a task")))
    app.start()
    assert errors and "输出父目录" in errors[0][1]
    assert app.worker is None and app.coordinator is None


def test_prototype_cleared_key_does_not_silently_use_environment(desktop, monkeypatch):
    import codeagent.superagent.gui as gui
    app = gui.Application(desktop)
    app.key.set("")
    app.confirm.set(True)
    errors = []
    monkeypatch.setattr(gui, "user_variable", lambda *_a, **_k: "hidden-environment-key")
    monkeypatch.setattr(gui.messagebox, "showerror", lambda *args: errors.append(args))
    monkeypatch.setattr(gui, "DeepSeek", lambda *_a, **_k: pytest.fail("cleared key must be rejected locally"))
    monkeypatch.setattr(gui, "Coordinator", SimpleNamespace(new_run=lambda *_a, **_k: pytest.fail("cleared key must not start model work")))
    app.start()
    assert errors and "API Key" in errors[0][1]
    assert app.worker is None and app.coordinator is None
