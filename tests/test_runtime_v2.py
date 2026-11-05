import copy
import json
import threading
from pathlib import Path

import pytest

from codeagent.cases import supplement
from codeagent.engine import Agent
from codeagent.prompts import SYSTEM
from codeagent.provider import Cancelled
from codeagent.runtime import ComposeSession, EnvironmentUnavailable, isolate_compose, validate_raw_scope, validate_runtime
from codeagent.safety import Redactor
from codeagent.tools import Toolset


def test_domain_is_explicit_supplement_not_generic_system():
    assert "Space Fractions" not in SYSTEM
    assert "space-fractions-client" not in SYSTEM
    path, doc = supplement("space-fractions")
    assert path.is_file() and doc["kind"] == "operator_supplement"
    assert "not original" in doc["origin"]
    assert "Space Fractions" in doc["text"]
    assert supplement("generic-node") == (None, None)
    assert "Space Fractions" not in supplement("library")[1]["text"]


def test_runtime_isolates_names_ports_and_bind_mounts_without_source_mutation(tmp_path):
    (tmp_path / "sql").mkdir()
    raw = {"name": "user-demo", "services": {"gateway": {"container_name": "shared-name", "build": {"context": str(tmp_path)},
            "ports": [3000], "volumes": [{"type": "bind", "source": str(tmp_path / "sql"), "target": "/sql"}]},
            "postgres": {"ports": [5432]}, "keycloak": {"environment": {"KC_HOSTNAME": "localhost", "KC_HOSTNAME_PORT": "8080"}}},
           "volumes": {"data": {"name": "user-demo_data"}}, "networks": {"default": {"name": "user-demo_default"}}}
    before = copy.deepcopy(raw)
    isolated = isolate_compose(raw, tmp_path, 31001, 31002)
    assert raw == before
    assert "name" not in isolated and "container_name" not in isolated["services"]["gateway"]
    assert isolated["services"]["postgres"]["ports"] == []
    assert isolated["services"]["gateway"]["ports"][0]["host_ip"] == "127.0.0.1"
    assert isolated["services"]["keycloak"]["environment"]["KC_HOSTNAME_URL"] == "http://localhost:31002"
    assert "KC_HOSTNAME" not in isolated["services"]["keycloak"]["environment"]
    assert isolated["services"]["keycloak"]["environment"]["KEYCLOAK_ADMIN_PASSWORD"] == "admin"
    assert isolated["services"]["gateway"]["volumes"][0]["bind"]["create_host_path"] is False
    assert "name" not in isolated["volumes"]["data"]
    raw["services"]["gateway"]["volumes"][0]["source"] = str(tmp_path.parent / "private")
    with pytest.raises(ValueError, match="bind mount"):
        isolate_compose(raw, tmp_path, 31001, 31002)


def test_missing_bind_config_fails_before_docker_can_create_directory(tmp_path):
    missing = tmp_path / "prometheus.yml"
    config = {"services": {"gateway": {"volumes": [{"type": "bind", "source": str(missing), "target": "/config.yml"}]}}}
    with pytest.raises(ValueError, match="Missing bind source prometheus.yml"):
        isolate_compose(config, tmp_path, 31001, 31002)
    assert not missing.exists()


def test_deployment_fixture_overrides_placeholder_bootstrap_credentials_without_repairing_roles(tmp_path):
    raw = {"services": {"gateway": {}, "keycloak": {"environment": {"KEYCLOAK_ADMIN": "custom", "KEYCLOAK_ADMIN_PASSWORD": "CHANGE_ME"}}}}
    fixed = isolate_compose(raw, tmp_path, 31001, 31002)
    env = fixed["services"]["keycloak"]["environment"]
    assert env["KEYCLOAK_ADMIN"] == env["KEYCLOAK_ADMIN_PASSWORD"] == "admin"
    assert raw["services"]["keycloak"]["environment"]["KEYCLOAK_ADMIN_PASSWORD"] == "CHANGE_ME"
    assert "volumes" not in fixed["services"]["keycloak"]  # No realm, role or business-data replacement.


@pytest.mark.parametrize("spec", [{"privileged": True}, {"network_mode": "host"}, {"devices": ["/dev/x"]}, {"cap_add": ["SYS_ADMIN"]}])
def test_runtime_refuses_host_access_modes(tmp_path, spec):
    with pytest.raises(ValueError):
        isolate_compose({"services": {"gateway": spec}}, tmp_path, 31001, 31002)


@pytest.mark.parametrize("content", ["services: {gateway: {env_file: ../private.env}}", "include: ../compose.yaml", "services: {gateway: {build: {context: ..}}}",
                                    "services: {gateway: {env_file: '${HOME}/private.env'}}"])
def test_compose_cannot_read_outside_inputs_before_render(tmp_path, content):
    (tmp_path / "compose.yaml").write_text(content)
    with pytest.raises(ValueError):
        validate_raw_scope(tmp_path)


def test_runtime_missing_engine_is_unverified_and_never_passed(tmp_path, monkeypatch):
    def unavailable(self):
        raise EnvironmentUnavailable("engine absent")
    monkeypatch.setattr(ComposeSession, "start", unavailable)
    result = validate_runtime(tmp_path, "library", tmp_path / "evidence", threading.Event())
    assert result["status"] == "unverified"
    assert result["cleanup"] == "not_started"
    assert (tmp_path / "evidence/runtime-report.json").is_file()


@pytest.mark.parametrize("cancelled", [False, True])
def test_partial_start_failure_or_cancel_always_cleans_its_project(tmp_path, monkeypatch, cancelled):
    cleaned = []
    def start(self):
        self.started = True
        raise Cancelled("cancelled") if cancelled else RuntimeError("build failed")
    def close(self):
        cleaned.append(self.project)
        return "passed"
    monkeypatch.setattr(ComposeSession, "start", start)
    monkeypatch.setattr(ComposeSession, "close", close)
    if cancelled:
        with pytest.raises(Cancelled):
            validate_runtime(tmp_path, "library", tmp_path / "evidence", threading.Event())
    else:
        result = validate_runtime(tmp_path, "library", tmp_path / "evidence", threading.Event())
        assert result["status"] == "failed"
    assert len(cleaned) == 1 and cleaned[0].startswith("dca-")


def test_duplicate_reads_are_measured_and_fail_with_actionable_error(tmp_path):
    (tmp_path / "source.js").write_text("const x = 1;")
    tools = Toolset(tmp_path, threading.Event(), Redactor())
    for _ in range(2):
        assert "content" in tools.execute("read_file", '{"path":"source.js"}')
    assert "next_offset" in tools.execute("read_file", '{"path":"source.js"}')["error"]
    assert tools.metrics["repeated_reads"] == 2


def test_runtime_failure_feedback_retains_sql_log_and_prioritizes_it():
    runtime = {"profile": "runtime", "status": "failed", "error": "answer500", "stages": [
        {"stage": ["config"], "status": "passed", "output": "x" * 40000},
        {"stage": ["logs"], "status": "passed", "output": 'SQLSTATE42P01 invalid reference EXCLUDED'}]}
    bounded = Agent.bounded_checks([runtime])[0]["details_excerpt"]
    assert "42P01" in bounded and "x" * 100 not in bounded
    groups = Agent.repair_groups([{"profile": "integration", "status": "failed", "output": "401"}, runtime])
    assert groups[0][0]["profile"] == "runtime"


def test_generation_defers_test_feedback_for_both_experiment_groups(tmp_path, monkeypatch):
    called = []
    monkeypatch.setattr("codeagent.tools.validate", lambda *args: called.append(args[1]) or {"profile": args[1], "status": "passed"})
    tools = Toolset(tmp_path, threading.Event(), Redactor(), allow_execution=True)
    tools.phase = "generation"
    assert tools.execute("run_check", '{"profile":"test"}')["status"] == "unverified"
    assert called == []
    tools.phase = "verification"
    assert tools.execute("run_check", '{"profile":"test"}')["status"] == "passed"
    assert called == ["test"]


def test_generation_cannot_silently_substitute_a_different_target_path(tmp_path):
    tools = Toolset(tmp_path, threading.Event(), Redactor())
    tools.phase = "generation"
    tools.focus_path = "healthcheck.js"
    result = tools.execute("write_file", json.dumps({"path":"scripts/healthcheck.js","content":"const x=1;"}))
    assert "error" in result and not (tmp_path / "scripts/healthcheck.js").exists()
    assert tools.execute("write_file", json.dumps({"path":"healthcheck.js","content":"const x=1;"}))["written"] == "healthcheck.js"


def test_shared_import_failure_is_one_group_and_keeps_root_cause():
    check = {"profile":"test", "status":"failed", "output":"src/db.js:1\nSyntaxError: pg does not provide an export named Pool\n"
             "test at test/a.test.js:1:1\nfailed\ntest at test/b.test.js:1:1\nfailed\n"}
    groups = Agent.repair_groups([check])
    assert len(groups) == 1
    assert len(groups[0][0]["targets"]) == 2
    assert "export named Pool" in groups[0][0]["output"]


def test_lockfile_is_host_derived_and_model_cannot_fabricate_it(tmp_path, monkeypatch):
    snapshots = []
    tools = Toolset(tmp_path, threading.Event(), Redactor(), allow_execution=True,
                    on_write=lambda *args: snapshots.append(args))
    result = tools.execute("write_file", json.dumps({"path": "package-lock.json", "content": "{}"}))
    assert "host npm" in result["error"] and not (tmp_path / "package-lock.json").exists()
    def install(*args):
        (tmp_path / "package-lock.json").write_text('{"lockfileVersion":3}')
        return {"profile": "install", "status": "passed"}
    monkeypatch.setattr("codeagent.tools.validate", install)
    result = tools.execute("run_check", '{"profile":"install"}')
    assert result["derived_artifact"]["origin"].startswith("npm")
    assert snapshots == [("package-lock.json", '{"lockfileVersion":3}', 1)]
    assert tools.metrics["host_derived_writes"] == 1


def test_install_resolves_lock_before_reproducible_ci(tmp_path, monkeypatch):
    from codeagent.checks import validate
    cli = tmp_path / "node_modules/npm/bin/npm-cli.js"
    cli.parent.mkdir(parents=True)
    cli.write_text("// fixture")
    monkeypatch.setattr("codeagent.checks.shutil.which", lambda name: str(tmp_path / name))
    commands = []
    def command(argv, *args, **kwargs):
        commands.append(argv)
        return {"status": "passed", "exit_code": 0}
    monkeypatch.setattr("codeagent.checks.run_command", command)
    assert validate(tmp_path, "install", threading.Event(), True)["status"] == "passed"
    assert commands[0][2:4] == ["install", "--package-lock-only"]
    assert commands[1][2] == "ci"
    assert all("--ignore-scripts" in argv for argv in commands)
