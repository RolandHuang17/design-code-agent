"""Fixed Docker/WSL runtime lifecycle. Never grants the model a shell tool."""
import hashlib
import json
import os
import shutil
import socket
import sys
import threading
import time
import yaml
from pathlib import Path
from uuid import uuid4

from .checks import UniqueKeyLoader, run_command
from .provider import Cancelled
from .safety import Redactor


class EnvironmentUnavailable(RuntimeError):
    pass


def wsl_path(path):
    path = Path(path).resolve()
    if not path.drive or len(path.drive) != 2:
        raise ValueError("WSL 后端仅支持本机盘符路径")
    return "/mnt/" + path.drive[0].lower() + path.as_posix()[2:]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def local_reference(root, name, base=None):
    if not isinstance(name, str) or "$" in name or "://" in name:
        raise ValueError("Compose 文件引用必须是固定的项目内路径")
    path = ((base or root) / name).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("Compose 文件引用越界")
    return path


def validate_raw_scope(root):
    """Check before `compose config`, which itself reads env_file/secrets/includes."""
    from .checks import compose_file
    data = yaml.load(compose_file(root).read_text(encoding="utf-8"), Loader=UniqueKeyLoader)
    if not isinstance(data, dict) or data.get("include"):
        raise ValueError("运行检查不支持 Compose include")
    for spec in data.get("services", {}).values():
        if spec.get("extends"):
            raise ValueError("运行检查不支持 Compose extends")
        files = spec.get("env_file", [])
        for item in files if isinstance(files, list) else [files]:
            local_reference(root, item.get("path") if isinstance(item, dict) else item)
        build = spec.get("build")
        if build:
            build = {"context": build} if isinstance(build, str) else build
            context = local_reference(root, build.get("context", "."))
            if build.get("additional_contexts"):
                raise ValueError("运行检查不支持 additional_contexts")
            local_reference(root, build.get("dockerfile", "Dockerfile"), context)
    for section in ("configs", "secrets"):
        for spec in (data.get(section) or {}).values():
            if spec.get("external"):
                raise ValueError("运行检查不支持外部 secret/config")
            if spec.get("file"):
                local_reference(root, spec["file"])


def isolate_compose(data, root, gateway_port, oidc_port):
    """Normalize only deployment details, outside generated source. Keep an audit copy."""
    data = json.loads(json.dumps(data))
    if not isinstance(data.get("services"), dict) or "gateway" not in data["services"]:
        raise ValueError("Compose 必须包含 gateway 服务")
    data.pop("name", None)
    for section in ("volumes", "networks"):
        for spec in (data.get(section) or {}).values():
            if spec.get("external") or spec.get("driver_opts") or spec.get("driver", "local" if section == "volumes" else "bridge") not in ("local", "bridge"):
                raise ValueError("运行检查禁止使用外部数据卷或网络")
            spec.pop("name", None)
    for name, spec in data["services"].items():
        if (spec.get("privileged") or spec.get("network_mode") or spec.get("pid") or spec.get("ipc")
                or spec.get("devices") or spec.get("cap_add") or spec.get("volumes_from")):
            raise ValueError("运行检查禁止 privileged、host namespace、devices、cap_add 或 volumes_from")
        spec.pop("container_name", None)
        spec["ports"] = []
        for mount in spec.get("volumes", []):
            if mount.get("type") == "bind":
                source = mount.get("source", "")
                # docker compose config has already resolved relative paths.
                allowed = wsl_path(root) if source.startswith("/mnt/") else str(root.resolve()).replace("\\", "/")
                candidate = source.replace("\\", "/")
                if candidate != allowed and not candidate.startswith(allowed.rstrip("/") + "/"):
                    raise ValueError("运行检查禁止项目外 bind mount")
                if "docker.sock" in candidate:
                    raise ValueError("运行检查禁止 Docker socket")
                relative = candidate[len(allowed):].lstrip("/")
                local_source = (root / relative).resolve()
                if not local_source.is_relative_to(root.resolve()):
                    raise ValueError("运行检查禁止项目外 bind mount（链接目标越界）")
                if not local_source.exists():
                    raise ValueError(f"Missing bind source {relative or '.'}: generate this config/file/directory before runtime. Docker must not create it automatically.")
                mount.setdefault("bind", {})["create_host_path"] = False
        if name in ("gateway", "keycloak"):
            port, target = (gateway_port, 3000) if name == "gateway" else (oidc_port, 8080)
            spec["ports"] = [{"target": target, "published": str(port), "host_ip": "127.0.0.1", "protocol": "tcp"}]
        if name == "keycloak":
            env = spec.setdefault("environment", {})
            env.pop("KC_HOSTNAME", None)  # Keycloak24 rejects hostname + hostname-url together.
            env.pop("KC_HOSTNAME_PORT", None)
            env.update(KC_HOSTNAME_URL=f"http://localhost:{oidc_port}", KC_HOSTNAME_STRICT="false", KC_HTTP_PORT="8080",
                       KEYCLOAK_ADMIN="admin", KEYCLOAK_ADMIN_PASSWORD="admin")
    return data


class ComposeSession:
    def __init__(self, root, artifacts, cancel, redactor, backend="auto", emit=None):
        self.root, self.artifacts = Path(root).resolve(), Path(artifacts).resolve()
        self.cancel, self.redactor = cancel, redactor
        self.emit = emit or (lambda *args, **kwargs: None)
        self.backend = backend
        self.project = "dca-" + uuid4().hex[:12]
        self.port, self.oidc_port = free_port(), free_port()
        while self.port == self.oidc_port:
            self.oidc_port = free_port()
        self.base = f"http://localhost:{self.port}"
        self.issuer = f"http://localhost:{self.oidc_port}/realms/space-fractions"
        self.variables = {"GATEWAY_PORT": str(self.port), "OIDC_PORT": str(self.oidc_port),
                          "PUBLIC_ORIGIN": self.base, "OIDC_PUBLIC_ORIGIN": f"http://localhost:{self.oidc_port}",
                          "OIDC_ISSUER": self.issuer}
        self.stages = []
        self.started = False
        self.config = self.artifacts / "compose.isolated.json"
        self.services = []

    def argv(self, args, compose=True, original=False):
        from .checks import compose_file
        selected = compose_file(self.root) if original else self.config
        variables = [f"{k}={v}" for k, v in self.variables.items()]
        if self.backend == "wsl":
            prefix = [shutil.which("wsl.exe") or "wsl.exe", "-d", "Ubuntu", "-u", "root", "--", "env", *variables, "docker"]
            source = wsl_path(selected)
            directory = wsl_path(self.root)
        else:
            # Inject only fixed fixture configuration, through `docker --...` subprocess env.
            prefix = [shutil.which("docker") or "docker"]
            source = str(selected)
            directory = str(self.root)
        return prefix + (["compose", "--project-directory", directory, "-p", self.project, "-f", source] if compose else []) + args

    def command(self, args, *, compose=True, original=False, timeout=180, cleanup=False):
        argv = self.argv(args, compose, original)
        self.emit("runtime_stage", stage=" ".join(args[:3]), project=self.project)
        result = run_command(argv, self.root, threading.Event() if cleanup else self.cancel,
                             timeout=timeout, extra_env=self.variables, output_limit=256000 if args[:1] == ["config"] else 32000)
        self.stages.append({"stage": args, **self.redactor.value(result)})
        return result

    def start(self):
        self.artifacts.mkdir(parents=True, exist_ok=True)
        validate_raw_scope(self.root)
        choices = (["docker", "wsl"] if os.name == "nt" else ["docker"]) if self.backend == "auto" else [self.backend]
        selected = None
        for choice in choices:
            if choice == "docker" and not shutil.which("docker"):
                continue
            if choice == "wsl" and not shutil.which("wsl.exe"):
                continue
            self.backend = choice
            if self.command(["version", "--format", "{{.Server.Version}}"], compose=False, timeout=20)["status"] == "passed":
                selected = choice
                break
        if not selected:
            raise EnvironmentUnavailable("未找到可用 Docker 引擎（已检查本机 CLI / WSL Ubuntu）")
        rendered = self.command(["config", "--format", "json"], original=True, timeout=30)
        if rendered["status"] != "passed":
            raise RuntimeError("Compose 配置解析失败，见 runtime 命令输出")
        original = json.loads(rendered["output"])
        isolated = isolate_compose(original, self.root, self.port, self.oidc_port)
        self.services = [name for name, spec in isolated["services"].items() if spec.get("build")]
        self.config.write_text(json.dumps(isolated, ensure_ascii=False, indent=2), encoding="utf-8")
        self.started = True  # partial up failures must also be cleaned up
        up = self.command(["up", "-d", "--build"], timeout=600)
        if up["status"] != "passed":
            raise RuntimeError("容器构建或启动失败，见 runtime 命令输出")

    def restart(self):
        if not self.services:
            raise RuntimeError("没有可重启的项目构建服务")
        result = self.command(["restart", *self.services], timeout=90)
        if result["status"] != "passed":
            raise RuntimeError("项目服务重启失败")

    def close(self):
        if self.started:
            self.command(["logs", "--no-color", "--tail", "40"], timeout=30, cleanup=True)
            result = self.command(["down", "--volumes", "--remove-orphans"], timeout=90, cleanup=True)
            return result["status"]
        return "not_started"


def validate_runtime(root, profile, artifacts, cancel, redactor=None, backend="auto", emit=None):
    from .acceptance.http_checks import exercise
    redactor = redactor or Redactor()
    session = ComposeSession(root, artifacts, cancel, redactor, backend, emit)
    result = {"profile": "runtime", "acceptance_profile": profile, "status": "failed"}
    try:
        session.start()
        result.update(exercise(session, profile))
    except EnvironmentUnavailable as exc:
        result.update(status="unverified", reason=str(exc))
    except Cancelled:
        result.update(status="cancelled")
        raise
    except Exception as exc:
        result.update(status="failed", error=redactor.text(str(exc)))
    finally:
        result["cleanup"] = session.close()
        if result["cleanup"] == "failed":
            result["status"] = "failed"
        result.update(backend=session.backend, project=session.project, stages=session.stages,
                      source_modified_by_host=False,
                      isolation_note="Owned Compose project and loopback ports; Docker execution is not an OS security sandbox")
        session.artifacts.mkdir(parents=True, exist_ok=True)
        (session.artifacts / "runtime-report.json").write_text(json.dumps(redactor.value(result), ensure_ascii=False, indent=2), encoding="utf-8")
    return result
