"""Start a generated npm project on a temporary port, independently check it, and stop it.

This executes generated code as the current user, not in an OS sandbox. Dependencies
must already be installed by the separately recorded installation check.
"""
import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from codeagent.checks import clean_environment, terminate_tree
from codeagent.safety import Redactor, project_files
from scripts.check_temperature import evaluate


def snapshot(root):
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in project_files(root)}


def check_project(project, report_path, startup_timeout=60):
    project, report_path = project.resolve(), report_path.resolve()
    if not project.is_dir() or report_path.exists() or report_path.is_relative_to(project):
        raise ValueError('Use an existing project and a NEW report outside the generated project')
    before = snapshot(project)
    node = shutil.which('node')
    npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    npm_cli = Path(npm).parent / 'node_modules/npm/bin/npm-cli.js' if npm else Path('__missing__')
    report = {'kind': 'operator_temperature_process_acceptance', 'status': 'unverified',
              'project': str(project), 'source_hashes_before': before, 'checks': []}
    process = None
    reader = None
    tail = bytearray()
    try:
        if not node or not npm_cli.is_file():
            report['reason'] = 'Standard Node/npm runtime unavailable'
        else:
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0))
                port = reservation.getsockname()[1]
            env = clean_environment()
            env.update(PORT=str(port), HOST='127.0.0.1')
            command = [node, str(npm_cli), 'run', 'start', '--ignore-scripts']
            report.update(command=command, base_url=f'http://127.0.0.1:{port}')
            process = subprocess.Popen(command, cwd=project, env=env, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            def drain():
                while block := process.stdout.read(4096):
                    tail.extend(block)
                    if len(tail) > 200_000:
                        del tail[:-200_000]
            reader = threading.Thread(target=drain, daemon=True)
            reader.start()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            started = time.monotonic()
            ready = False
            while time.monotonic() - started < startup_timeout and process.poll() is None:
                try:
                    with opener.open(report['base_url'] + '/health', timeout=1) as response:
                        ready = response.status == 200
                    if ready:
                        break
                except OSError:
                    pass
                time.sleep(0.25)
            if ready:
                acceptance = evaluate(report['base_url'])
                report.update(status=acceptance['status'], checks=acceptance['checks'], limitations=acceptance['limitations'])
            else:
                report.update(status='failed', reason='Generated server did not become healthy before timeout', exit_code=process.poll())
    except Exception as error:
        report.update(status='failed', error_type=type(error).__name__)
    finally:
        if process is not None:
            terminate_tree(process)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            if reader is not None:
                reader.join(timeout=5)
            report['cleanup'] = {'process_stopped': process.poll() is not None}
        after = snapshot(project)
        report.update(source_hashes_after=after, source_unchanged=before == after)
        if before != after:
            report.update(status='unverified', reason='Project files changed during acceptance; inspect changes and retest')
        report['server_output_tail'] = Redactor().text(tail.decode('utf-8', errors='replace'))
        report_path.parent.mkdir(parents=True, exist_ok=True)
        with report_path.open('x', encoding='utf-8') as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--startup-timeout', type=int, default=60)
    args = parser.parse_args()
    if not 1 <= args.startup_timeout <= 180:
        parser.error('Startup timeout must be 1–180 seconds')
    result = check_project(args.project, args.report, args.startup_timeout)
    print(json.dumps({key: value for key, value in result.items() if key not in ('source_hashes_before', 'source_hashes_after', 'server_output_tail')}, ensure_ascii=True))
    raise SystemExit(result['status'] != 'passed')
