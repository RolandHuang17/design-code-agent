"""Fixed validation profiles. Execution is opt-in; this is NOT an OS sandbox."""
import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

import yaml

from .provider import Cancelled
from .safety import project_files

PROFILES = ("static", "install", "test", "build", "compose")


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


def run_command(argv, root: Path, cancel: threading.Event, timeout=120):
    """Drain pipes continuously, bound memory, terminate child tree on cancel/timeout."""
    kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
    process = subprocess.Popen(argv, cwd=root, env=clean_environment(), stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, **kwargs)
    output = bytearray()

    def drain():
        while data := process.stdout.read(4096):
            output.extend(data)
            if len(output) > 32_000:
                del output[:-32_000]

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
        for required in ("package.json", "README.md", "openapi.yaml", "internal.proto", "traceability.json"):
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
                        if path.name == "package.json" and (not isinstance(parsed, dict) or not isinstance(parsed.get("scripts"), dict) or not parsed["scripts"].get("test")):
                            raise ValueError("package.json 缺少 test 脚本")
                    else:
                        list(yaml.safe_load_all(content))
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
            # Explicit execution through npm is allowed only after local user opt-in.
            if not scripts.get(profile):
                return {"profile": profile, "status": "unverified", "reason": f"缺少 {profile} 脚本"}
            npm_cli = Path(npm).parent / "node_modules/npm/bin/npm-cli.js" if npm else Path("__missing__")
            argv = [binary, str(npm_cli), "run", profile, "--ignore-scripts"] if binary and npm_cli.exists() else None
    if not argv:
        return {"profile": profile, "status": "unverified", "reason": "缺少 Node.js/npm 或 Docker"}
    return {"profile": profile, **run_command(argv, root, cancel, timeout=180 if profile == "install" else 120)}


def summarize(profile, results):
    status = "failed" if any(r["status"] == "failed" for r in results) else "unverified" if any(r["status"] == "unverified" for r in results) else "passed"
    return {"profile": profile, "status": status, "results": results}
