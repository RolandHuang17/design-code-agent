"""IMM association policy tests use fake handles and dummy values, never credentials."""
from types import SimpleNamespace

from codeagent.ui import _SecretImeGuard


class FakeEntry:
    def __init__(self):
        self.jobs = {}
        self.focused = self

    def winfo_id(self):
        return 10

    def winfo_toplevel(self):
        return SimpleNamespace(winfo_id=lambda: 20)

    def focus_get(self):
        return self.focused

    def after_idle(self, callback):
        self.jobs["idle"] = callback
        return "idle"

    def after(self, delay, callback):
        assert delay == 40
        self.jobs["timer"] = callback
        return "timer"

    def after_cancel(self, job):
        self.jobs.pop(job, None)


class FakeIme:
    def __init__(self):
        self.contexts = {10: 0, 20: 200, 30: 300, 90: 900}
        self.parents = {10: 20, 20: 30, 30: 0, 90: 0}
        self.focused = 20
        self.cancelled = []

    def owned(self, window):
        return window in (10, 20, 30)

    def focus(self):
        return self.focused

    def root(self, window):
        return 30 if window in (10, 20, 30) else 90

    def parent(self, window):
        return self.parents[window]

    def associate(self, window, context):
        previous = self.contexts[window]
        self.contexts[window] = context
        return previous

    def cancel_composition(self, context):
        self.cancelled.append(context)


def test_secret_guard_detaches_native_client_wrapper_and_entry_then_restores():
    entry, api = FakeEntry(), FakeIme()
    original = dict(api.contexts)
    guard = _SecretImeGuard(entry, api)
    guard.focus_in()
    assert api.contexts == {10: 0, 20: 0, 30: 0, 90: 900}
    assert guard.saved == {10: 0, 20: 200, 30: 300}
    assert api.cancelled == [200, 300]
    guard.focus_in()  # Repeated focus notifications cannot overwrite original contexts.
    guard.restore()
    assert api.contexts == original
    assert not guard.saved and not guard.active and not entry.jobs


def test_secret_guard_reasserts_without_losing_original_and_restores_on_focus_loss():
    entry, api = FakeEntry(), FakeIme()
    guard = _SecretImeGuard(entry, api)
    guard.focus_in()
    api.contexts[20] = 299  # A later native focus transition re-associated the client.
    entry.jobs.pop("idle")()
    assert api.contexts[20] == 0
    assert guard.saved[20] == 200
    assert "timer" in entry.jobs
    api.focused = 90  # A foreign root must never be modified.
    entry.focused = None
    entry.jobs.pop("timer")()
    assert api.contexts == {10: 0, 20: 200, 30: 300, 90: 900}
    assert not guard.active
