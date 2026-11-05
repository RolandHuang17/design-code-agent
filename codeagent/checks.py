"""Fixed validation profiles. Execution is opt-in; this is NOT an OS sandbox."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import yaml

from .provider import Cancelled
from .safety import project_files

PROFILES = ("static", "install", "test", "integration", "build", "compose", "auth")


class UniqueKeyLoader(yaml.SafeLoader):
    """Compose rejects duplicate mapping keys; PyYAML's default silently loses data."""
    def construct_mapping(self, node, deep=False):
        seen = set()
        for key_node, value_node in node.value:
            if key_node.tag == "tag:yaml.org,2002:merge":
                continue
            key = self.construct_object(key_node, deep=deep)
            try:
                duplicate = key in seen
            except TypeError:
                raise yaml.constructor.ConstructorError(None, None, "unhashable mapping key", key_node.start_mark) from None
            if duplicate:
                raise yaml.constructor.ConstructorError(None, None, f"duplicate mapping key: {key}", key_node.start_mark)
            seen.add(key)
        return super().construct_mapping(node, deep=deep)


def compose_port_conflicts(data):
    if not isinstance(data, dict) or not isinstance(data.get("services"), dict):
        raise ValueError("Compose 缺少 services 对象")
    bindings = {}
    for service, spec in data["services"].items():
        for port in spec.get("ports", []):
            if isinstance(port, str):
                address, _, protocol = port.partition("/")
                parts = address.split(":")
                if len(parts) < 2:
                    continue  # Random published port, allocated by Docker.
                host_ip = parts[-3] if len(parts) > 2 else "0.0.0.0"
                published = parts[-2]
                protocol = protocol or "tcp"
            elif isinstance(port, dict) and port.get("published"):
                host_ip, published, protocol = port.get("host_ip", "0.0.0.0"), str(port["published"]), port.get("protocol", "tcp")
            else:
                continue
            key = (published, protocol)
            for existing_ip, existing_service in bindings.get(key, []):
                if host_ip == existing_ip or host_ip == "0.0.0.0" or existing_ip == "0.0.0.0":
                    raise ValueError(f"Compose 宿主端口冲突：{existing_service} / {service} 共享 {published}/{protocol}")
            bindings.setdefault(key, []).append((host_ip, service))


def clean_environment():
    keep = {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE",
            "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA", "HOME"}
    env = {k: v for k, v in os.environ.items() if k.upper() in keep}
    env.update(CI="true", NO_COLOR="1", NPM_CONFIG_IGNORE_SCRIPTS="true", NPM_CONFIG_AUDIT="false",
               NPM_CONFIG_FUND="false", NPM_CONFIG_UPDATE_NOTIFIER="false")
    return env


def terminate_tree(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True,
                       creationflags=subprocess.CREATE_NO_WINDOW, timeout=15)
    else:
        import signal
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def run_command(argv, root: Path, cancel: threading.Event, timeout=120, *, extra_env=None, output_limit=32000):
    """Drain pipes continuously, bound memory, terminate child tree on cancel/timeout."""
    kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
    env = clean_environment()
    env.update(extra_env or {})
    process = subprocess.Popen(argv, cwd=root, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, **kwargs)
    output = bytearray()

    def drain():
        while data := process.stdout.read(4096):
            output.extend(data)
            if len(output) > output_limit:
                del output[:-output_limit]

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    started = time.monotonic()
    timed_out = False
    try:
        while process.poll() is None:
            if cancel.wait(0.1):
                terminate_tree(process)
                raise Cancelled("检查已取消")
            if time.monotonic() - started > timeout:
                timed_out = True
                terminate_tree(process)
                break
        process.wait(timeout=15)
    finally:
        terminate_tree(process)
        reader.join(timeout=5)
        process.stdout.close()
    return {"status": "failed" if timed_out or process.returncode else "passed", "exit_code": process.returncode,
            "timed_out": timed_out, "command": argv, "output": output.decode("utf-8", errors="replace")}


def validate(root: Path, profile: str, cancel: threading.Event, allow_execution=False):
    root = root.resolve()
    if profile not in PROFILES:
        raise ValueError("未知检查类型")
    if cancel.is_set():
        raise Cancelled("用户取消")
    if profile == "static":
        results = []
        files = list(project_files(root))
        names = {p.relative_to(root).as_posix() for p in files}
        for required in ("package.json", "README.md", "openapi.yaml", "traceability.json"):
            results.append({"check": f"required:{required}", "status": "passed" if required in names else "failed"})
        for path in files:
            relative = path.relative_to(root).as_posix()
            if path.stat().st_size > 1_000_000:
                results.append({"check": relative, "status": "failed", "error": "文件超过检查上限"})
                continue
            if path.suffix in (".json", ".yaml", ".yml"):
                try:
                    content = path.read_text(encoding="utf-8-sig")
                    if path.suffix == ".json":
                        parsed = json.loads(content)
                        if path.name == "package.json" and not isinstance(parsed, dict):
                            raise ValueError("package.json 必须为对象")
                        if path == root / "package.json":
                            if not isinstance(parsed.get("scripts"), dict) or not parsed["scripts"].get("test"):
                                raise ValueError("根 package.json 缺少 test 脚本")
                            build = parsed["scripts"].get("build", "").strip()
                            if not build or build.lower().startswith(("echo ", "printf ", "exit 0", "true")):
                                raise ValueError("根 build 脚本必须实际检查或构建源码，不能只输出成功信息")
                    else:
                        parsed_yaml = list(yaml.load_all(content, Loader=UniqueKeyLoader))
                        if path == root / "compose.yaml" or path == root / "docker-compose.yml":
                            compose_port_conflicts(parsed_yaml[0])
                    results.append({"check": relative, "status": "passed"})
                except (ValueError, yaml.YAMLError) as exc:
                    results.append({"check": relative, "status": "failed", "error": str(exc)[:2000]})
            if path.suffix in (".js", ".mjs", ".cjs"):
                if node := shutil.which("node"):
                    result = run_command([node, "--check", str(path)], root, cancel, timeout=20)
                    results.append({"check": relative, **result})
                else:
                    results.append({"check": relative, "status": "unverified", "reason": "缺少 Node.js"})
        if not any("test" in p.lower() and p.endswith((".js", ".mjs", ".cjs")) for p in names):
            results.append({"check": "test files", "status": "failed", "reason": "缺少 JavaScript 测试文件"})
        return summarize(profile, results)
    if not allow_execution:
        return {"profile": profile, "status": "unverified", "reason": "尚未允许执行生成项目；此功能会以当前用户权限运行代码"}
    if profile == "auth":
        node = shutil.which("node")
        if not node or not (root / "shared/src/auth.js").exists():
            return {"profile": profile, "status": "unverified", "reason": "缺少 Node.js 或当前案例的 JWT 模块"}
        asset_root = Path(getattr(sys, "_MEIPASS", Path(__file__).parent.parent))
        harness = asset_root / "codeagent/acceptance/auth.cjs"
        if not harness.exists():
            raise ValueError("独立验收资源缺失，请重新安装或打包工具")
        with tempfile.TemporaryDirectory(prefix="design-agent-auth-") as temporary:
            report_path = Path(temporary) / "report.json"
            result = run_command([node, str(harness), str(root), str(report_path)], root, cancel, timeout=30)
            if report_path.exists():
                result["independent_report"] = json.loads(report_path.read_text(encoding="utf-8"))
            return {"profile": profile, **result}
    if profile == "compose":
        if not (root / "compose.yaml").exists() and not (root / "docker-compose.yml").exists():
            return {"profile": profile, "status": "failed", "reason": "缺少 Compose 文件"}
        binary = shutil.which("docker")
        argv = [binary, "compose", "config", "--quiet"] if binary else None
    else:
        npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
        binary = shutil.which("node")
        if profile == "install":
            # Avoid npm.cmd shell dispatch: invoke npm's JS CLI through node.
            npm_cli = Path(npm).parent / "node_modules/npm/bin/npm-cli.js" if npm else Path("__missing__")
            if not npm_cli.exists():
                return {"profile": profile, "status": "unverified", "reason": "未找到标准 Node/npm 安装；请按 README 手动安装依赖"}
            argv = [binary, str(npm_cli), "ci" if (root / "package-lock.json").exists() else "install", "--ignore-scripts", "--no-audit", "--no-fund"] if binary else None
        else:
            manifest = root / "package.json"
            if not manifest.exists():
                return {"profile": profile, "status": "failed", "reason": "缺少 package.json"}
            scripts = json.loads(manifest.read_text(encoding="utf-8"))["scripts"]
            script_name = "test:integration" if profile == "integration" else profile
            # Explicit execution through npm is allowed only after local user opt-in.
            if not scripts.get(script_name):
                return {"profile": profile, "status": "unverified", "reason": f"缺少 {script_name} 脚本"}
            npm_cli = Path(npm).parent / "node_modules/npm/bin/npm-cli.js" if npm else Path("__missing__")
            argv = [binary, str(npm_cli), "run", script_name, "--ignore-scripts"] if binary and npm_cli.exists() else None
    if not argv:
        return {"profile": profile, "status": "unverified", "reason": "缺少 Node.js/npm 或 Docker"}
    return {"profile": profile, **run_command(argv, root, cancel, timeout=180 if profile == "install" else 120)}


def summarize(profile, results):
    status = "failed" if any(r["status"] == "failed" for r in results) else "unverified" if any(r["status"] == "unverified" for r in results) else "passed"
    return {"profile": profile, "status": status, "results": results}
