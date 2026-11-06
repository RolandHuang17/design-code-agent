"""Run native Tk checks in isolated processes so Tcl GC cannot enter Agent threads."""
import os
from pathlib import Path
import subprocess
import sys

import pytest

from codeagent.ui import PageCursor


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


@pytest.mark.parametrize("scenario", [
    "test_main_current_directory_and_running_configuration",
    "test_main_invalid_new_run_does_not_offer_previous_result",
    "test_close_waits_for_worker_before_destroying_window",
    "test_prototype_binding_pagination_and_log_bounds",
    "test_tree_updates_preserve_selection",
    "test_prototype_close_waits_for_saved_report_and_closes_coordinator",
    "test_prototype_unexpected_worker_error_is_redacted_and_returns_idle",
    "test_main_close_after_idle_still_waits_for_live_thread",
    "test_prototype_close_after_idle_does_not_wait_for_another_idle",
    "test_main_blank_output_rejected_before_provider_or_agent",
    "test_prototype_blank_parent_rejected_before_factory",
    "test_prototype_cleared_key_does_not_silently_use_environment",
])
def test_isolated_native_desktop_scenario(scenario):
    scenario_file = Path(__file__).with_name("gui_workbench_scenarios.py")
    environment = os.environ.copy()
    environment["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
    # Tests use fake providers; no child receives process-level model credentials.
    for name in ("DASHSCOPE_API_KEY", "DEEPSEEK_API_KEY"):
        environment.pop(name, None)
    result = subprocess.run([sys.executable, "-m", "pytest", str(scenario_file) + "::" + scenario,
                             "-q", "-p", "no:cacheprovider"],
                            cwd=scenario_file.parents[1], env=environment, capture_output=True,
                            text=True, encoding="utf8", errors="replace", timeout=30)
    output = result.stdout + result.stderr
    if "1 skipped" in output and os.name != "nt":
        pytest.skip("Tk display unavailable on this non-Windows test host")
    assert result.returncode == 0 and "1 passed" in output, output[-10000:]
