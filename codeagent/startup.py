"""Fixed local HTTP startup probe. Executes opted-in generated code, not an OS sandbox."""
import json
import os
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from .checks import clean_environment, terminate_tree
from .evidence import bind_check, project_snapshot
from .provider import Cancelled, NoRedirect
from .safety import Redactor


def _probe(root, cancel, allow_execution, endpoint, timeout):
    result = {"profile": "startup", "status": "unverified", "endpoint": endpoint,
              "meaning": "Local HTTP listener readiness only; not domain correctness"}
    if not allow_execution:
        return {**result, "reason": "Generated project execution was not enabled"}
    try:
        manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
        start = manifest.get("scripts", {}).get("start")
        if not isinstance(start, str) or not start.strip():
            return {**result, "status": "failed", "reason": "package.json must declare a nonempty scripts.start"}
    except (OSError, ValueError, AttributeError) as error:
        return {**result, "status": "failed", "reason": "Cannot read a valid package.json startup declaration", "error_type": type(error).__name__}
    node = shutil.which("node")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    npm_cli = Path(npm).parent / "node_modules/npm/bin/npm-cli.js" if npm else Path("__missing__")
    if not node or not npm_cli.is_file():
        return {**result, "reason": "Standard Node.js/npm runtime is unavailable"}
    if cancel.is_set():
        raise Cancelled("启动检查已取消")
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    env = clean_environment()
    env.update(PORT=str(port), HOST="127.0.0.1")
    command = [node, str(npm_cli), "run", "start", "--ignore-scripts"]
    result.update(status="failed", command=command, base_url=f"http://127.0.0.1:{port}", http_observations=[])
    process = None
    reader = None
    output = bytearray()
    kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
    try:
        process = subprocess.Popen(command, cwd=root, env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kwargs)

        def drain():
            while block := process.stdout.read(4096):
                output.extend(block)
                if len(output) > 32_000:
                    del output[:-32_000]

        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        deadline = time.monotonic() + timeout
        consecutive = 0
        while time.monotonic() < deadline:
            if cancel.is_set():
                raise Cancelled("启动检查已取消")
            if process.poll() is not None:
                result.update(reason="npm start exited before stable HTTP readiness", exit_code=process.returncode)
                break
            status = None
            try:
                with opener.open(result["base_url"] + endpoint, timeout=min(1, max(0.05, deadline - time.monotonic()))) as response:
                    status = response.status
            except urllib.error.HTTPError as error:
                status = error.code  # An HTTP 404/405 still proves a listener exists; it does not prove functionality.
                error.close()
            except (OSError, ValueError):
                pass
            if status is not None:
                consecutive += 1
                result["http_observations"].append({"status": status, "consecutive": consecutive})
            else:
                consecutive = 0
            if consecutive >= 2 and process.poll() is None:
                result.update(status="passed", reason="Two consecutive local HTTP responses observed")
                break
            if cancel.wait(0.15):
                raise Cancelled("启动检查已取消")
        else:
            result.update(reason="No stable local HTTP listener before startup deadline", timed_out=True)
    except Cancelled:
        raise
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        result.update(status="failed", reason="Unable to start or probe the generated HTTP application", error_type=type(error).__name__)
    finally:
        if process is not None:
            try:
                terminate_tree(process)
                process.wait(timeout=10)
            except (OSError, subprocess.SubprocessError):
                try:
                    process.kill()
                    process.wait(timeout=5)
                except (OSError, subprocess.SubprocessError):
                    pass
            if reader is not None:
                reader.join(timeout=3)
            if process.stdout and (reader is None or not reader.is_alive()):
                process.stdout.close()
            with socket.socket() as connection:
                connection.settimeout(0.2)
                port_closed = connection.connect_ex(("127.0.0.1", port)) != 0
            result["cleanup"] = {"process_stopped": process.poll() is not None, "port_closed": port_closed}
            if process.poll() is None or not port_closed:
                result.update(status="failed", reason="Startup check cleanup could not establish that its process and listener stopped")
        result["output"] = Redactor().text(bytes(output).decode("utf-8", errors="replace"))
    return result


def probe_startup(root, cancel, allow_execution=False, *, endpoint="/", timeout=30):
    """Run the fixed npm start probe and bind its evidence to source snapshots.

    Only '/' and '/health' can be selected. Any HTTP status establishes readiness;
    callers must use separate protected acceptance for actual behavior.
    """
    if endpoint not in ("/", "/health") or not 0 < timeout <= 180:
        raise ValueError("Startup probe requires a fixed endpoint and a timeout of 0–180 seconds")
    root = Path(root).resolve()
    before = project_snapshot(root)
    result = _probe(root, cancel, allow_execution, endpoint, timeout)
    return bind_check(result, before, project_snapshot(root))
