import sys
from types import SimpleNamespace

from codeagent import config


class RegistryKey:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


def registry(monkeypatch, value):
    fake = SimpleNamespace(HKEY_CURRENT_USER=object(),
        OpenKey=lambda *args: RegistryKey(), QueryValueEx=lambda *args: (value, 1))
    monkeypatch.setitem(sys.modules, "winreg", fake)
    monkeypatch.setattr(config, "os", SimpleNamespace(name="nt", environ={"EXAMPLE_KEY": "process-value"}))
    return fake


def test_default_lookup_keeps_explicit_process_override(monkeypatch):
    fake = registry(monkeypatch, "registry-value")
    fake.OpenKey = lambda *args: (_ for _ in ()).throw(AssertionError("Registry must not override default CLI lookup"))
    assert config.user_variable("EXAMPLE_KEY") == "process-value"


def test_explicit_refresh_reads_current_windows_user_value(monkeypatch):
    registry(monkeypatch, "registry-value")
    assert config.user_variable("EXAMPLE_KEY", refresh=True) == "registry-value"


def test_explicit_refresh_honors_cleared_user_value(monkeypatch):
    registry(monkeypatch, "")
    assert config.user_variable("EXAMPLE_KEY", refresh=True) == ""


def test_missing_registry_and_non_windows_refresh_fall_back_to_process(monkeypatch):
    fake = registry(monkeypatch, "not-used")
    fake.OpenKey = lambda *args: (_ for _ in ()).throw(OSError("User value absent"))
    assert config.user_variable("EXAMPLE_KEY", refresh=True) == "process-value"
    monkeypatch.setattr(config, "os", SimpleNamespace(name="posix", environ={"EXAMPLE_KEY": "shell-value"}))
    assert config.user_variable("EXAMPLE_KEY", refresh=True) == "shell-value"
