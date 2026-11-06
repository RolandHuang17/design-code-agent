"""Independent HTTP/restart acceptance for the small health-service demonstration."""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from codeagent.checks import clean_environment, terminate_tree
from codeagent.provider import NoRedirect
from codeagent.safety import Redactor
from scripts.check_temperature_project import snapshot


def check(project, output):
    project, output = project.resolve(), output.resolve()
    if not project.is_dir() or output.exists() or output.is_relative_to(project):
        raise ValueError('Use an existing project and a new report outside it')
    before = snapshot(project)
    report = {'kind': 'independent_health_http_restart', 'status': 'failed',
              'source_hashes_before': before, 'checks': [], 'cleanup': []}
    node, npm = shutil.which('node'), shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    npm_cli = Path(npm).parent / 'node_modules/npm/bin/npm-cli.js' if npm else Path('__missing__')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        if not node or not npm_cli.is_file():
            report.update(status='unverified', reason='Standard Node/npm unavailable')
            return report
        for restart in range(2):
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0))
                port = reservation.getsockname()[1]
            env = clean_environment()
            env.update(PORT=str(port), HOST='127.0.0.1')
            process = None
            tail = bytearray()
            reader = None
            try:
                process = subprocess.Popen([node, str(npm_cli), 'run', 'start', '--ignore-scripts'],
                    cwd=project, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)

                def drain():
                    while block := process.stdout.read(4096):
                        tail.extend(block)
                        if len(tail) > 32000:
                            del tail[:-32000]

                reader = threading.Thread(target=drain, daemon=True)
                reader.start()
                base = f'http://127.0.0.1:{port}'
                ready = False
                until = time.monotonic() + 30
                while time.monotonic() < until and process.poll() is None:
                    try:
                        with opener.open(base + '/health', timeout=1) as response:
                            ready = response.status == 200
                        if ready:
                            break
                    except OSError:
                        pass
                    time.sleep(.2)
                if not ready:
                    raise RuntimeError('npm start did not expose a healthy server on PORT')
                for route, expected in [('/health', 200), ('/unknown-route', 404), ('/health', 200)]:
                    try:
                        response = opener.open(base + route, timeout=3)
                    except urllib.error.HTTPError as error:
                        response = error
                    with response:
                        status, content_type = response.code, response.headers.get('Content-Type', '')
                        body = json.loads(response.read(32000))
                    passed = status == expected and 'application/json' in content_type and isinstance(body, dict)
                    passed = passed and (body == {'status': 'ok'} if expected == 200 else bool(body.get('error')))
                    report['checks'].append({'restart_index': restart, 'path': route,
                        'http_status': status, 'body': body, 'passed': passed})
                    if not passed:
                        raise RuntimeError('HTTP contract failed: ' + route)
            finally:
                if process is not None:
                    terminate_tree(process)
                    process.wait(timeout=10)
                    if reader:
                        reader.join(timeout=3)
                    with socket.socket() as probe:
                        closed = probe.connect_ex(('127.0.0.1', port)) != 0
                    report['cleanup'].append({'restart_index': restart, 'process_stopped': process.poll() is not None,
                        'port_closed': closed, 'output_tail': Redactor().text(tail.decode('utf-8', errors='replace'))})
        report['status'] = 'passed' if len(report['checks']) == 6 and all(
            c['process_stopped'] and c['port_closed'] for c in report['cleanup']) else 'failed'
    except Exception as error:
        report.update(error_type=type(error).__name__, reason=str(error))
    finally:
        after = snapshot(project)
        report.update(source_hashes_after=after, source_unchanged=before == after)
        if before != after:
            report.update(status='unverified', reason='Source changed during acceptance')
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open('x', encoding='utf-8') as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('project', type=Path)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    result = check(args.project, args.report)
    print(json.dumps({'status': result['status'], 'checks': len(result['checks']), 'source_unchanged': result['source_unchanged']}))
    raise SystemExit(0 if result['status'] == 'passed' else 1)
