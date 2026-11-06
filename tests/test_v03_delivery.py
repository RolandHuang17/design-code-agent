import json
import shutil
import socket
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from scripts.check_temperature import evaluate
from scripts.evidence_v03 import render, summarize
from scripts.package_v03 import package
from scripts.check_temperature_project import check_project


def test_evidence_index_keeps_failures_and_unreadable_reports_and_escapes_html(tmp_path):
    (tmp_path / 'failed').mkdir()
    (tmp_path / 'failed/report.json').write_text(json.dumps({'status': '<script>failed</script>', 'checks': [{'profile': 'test', 'status': 'failed'}]}))
    (tmp_path / 'broken').mkdir()
    (tmp_path / 'broken/report.json').write_text('{')
    data = summarize(tmp_path)
    assert len(data['reports']) == 2
    assert {r['status'] for r in data['reports']} == {'unreadable', '<script>failed</script>'}
    assert '<script>failed</script>' not in render(data)
    assert '&lt;script&gt;' in render(data)
    assert data['reports'][1]['checks'][0]['status'] == 'failed'


def setup_package(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr('scripts.package_v03.user_variable', lambda _: '')
    monkeypatch.setattr('scripts.package_v03.subprocess.check_output', lambda *a, **k: 'fixture-commit\n')
    for folder in ('dist/main', 'dist/prototype', 'docs', 'benchmarks/temperature-converter'):
        Path(folder).mkdir(parents=True)
    for name in ('README.md', 'LICENSE', 'NOTICE.md', 'Architecture_Documentation.md', 'Architecture_View.md'):
        Path(name).write_bytes(b'original\r\nbytes')
    Path('dist/main/app.exe').write_bytes(b'main executable fixture')
    Path('dist/prototype/app.exe').write_bytes(b'prototype executable fixture')


def test_dual_package_hashes_and_preserves_two_separate_programs(tmp_path, monkeypatch):
    setup_package(tmp_path, monkeypatch)
    package(Path('dist/main/app.exe'), Path('dist/prototype/app.exe'), Path('dist/bundle.zip'))
    with zipfile.ZipFile('dist/bundle.zip') as archive:
        manifest = json.loads(archive.read('BUNDLE-MANIFEST.json'))
        assert archive.read('README.md') == b'original\r\nbytes'
        assert 'main/DesignCodeAgent.exe' in manifest['files']
        assert 'prototype/DesignCodeAgent-Superagent.exe' in manifest['files']
        assert 'prototype/examples/inputs/Architecture_View.md' in manifest['files']
    with pytest.raises(ValueError, match='NEW archive'):
        package(Path('dist/main/app.exe'), Path('dist/prototype/app.exe'), Path('dist/bundle.zip'))


def test_dual_package_stops_before_archive_for_configured_secret(tmp_path, monkeypatch):
    setup_package(tmp_path, monkeypatch)
    monkeypatch.setattr('scripts.package_v03.user_variable', lambda _: 'credential-fixture-value')
    Path('docs/leak.json').write_text('credential-fixture-value')
    with pytest.raises(ValueError, match='content not printed') as error:
        package(Path('dist/main/app.exe'), Path('dist/prototype/app.exe'), Path('dist/bundle.zip'))
    assert 'credential-fixture-value' not in str(error.value)
    assert not Path('dist/bundle.zip').exists()


def test_independent_checker_detects_wrong_conversion_and_keeps_all_checks():
    class WrongApplication(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html' if self.path == '/' else 'application/json')
            self.end_headers()
            self.wfile.write(b'<html></html>' if self.path == '/' else b'{"status":"ok"}')

        def do_POST(self):
            self.rfile.read(int(self.headers.get('Content-Length', 0)))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"value":32,"unit":"F"}')

    server = ThreadingHTTPServer(('127.0.0.1', 0), WrongApplication)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        result = evaluate(f'http://127.0.0.1:{server.server_port}')
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    assert result['status'] == 'failed'
    assert len(result['checks']) == 17
    assert result['checks'][2]['status'] == 'passed'  # A single passing example cannot hide later failures.
    assert result['checks'][-1]['status'] == 'failed'


def test_independent_checker_refuses_nonlocal_targets():
    with pytest.raises(ValueError, match='local HTTP'):
        evaluate('https://example.com')


def test_project_checker_records_missing_runtime_as_unverified(tmp_path, monkeypatch):
    project = tmp_path / 'project'
    project.mkdir()
    monkeypatch.setattr('scripts.check_temperature_project.shutil.which', lambda _: None)
    report = check_project(project, tmp_path / 'report.json')
    assert report['status'] == 'unverified'
    assert report['source_unchanged'] is True
    with pytest.raises(ValueError, match='NEW report'):
        check_project(project, tmp_path / 'report.json')


@pytest.mark.skipif(not shutil.which('node'), reason='Node runtime unavailable')
def test_project_checker_stops_real_generated_server_and_does_not_edit_sources(tmp_path):
    project = tmp_path / 'project'
    project.mkdir()
    (project / 'package.json').write_text(json.dumps({'scripts': {'start': 'node app.cjs'}}))
    (project / 'app.cjs').write_text("""const http = require('node:http');
http.createServer((req,res)=>{req.resume();req.on('end',()=>{
res.setHeader('Content-Type',req.url==='/'?'text/html':'application/json');
res.end(req.url==='/'?'<html></html>':req.url==='/health'?'{"status":"ok"}':'{"value":32,"unit":"F"}');
});}).listen(Number(process.env.PORT),'127.0.0.1');""")
    report = check_project(project, tmp_path / 'report.json', startup_timeout=10)
    assert report['status'] == 'failed'  # The deliberately wrong application is rejected.
    assert report['source_unchanged'] is True
    assert report['cleanup']['process_stopped'] is True
    assert len(report['checks']) == 17
    from urllib.parse import urlsplit
    port = urlsplit(report['base_url']).port
    with socket.socket() as connection:
        connection.settimeout(0.3)
        assert connection.connect_ex(('127.0.0.1', port)) != 0
