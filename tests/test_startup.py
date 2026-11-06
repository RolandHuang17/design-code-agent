import json
import os
import shutil
import threading
from pathlib import Path

import pytest

from codeagent.provider import Cancelled
from codeagent.startup import probe_startup


def project(tmp_path, source, suffix="cjs", start=None):
    (tmp_path / f"server.{suffix}").write_text(source, encoding="utf-8")
    (tmp_path / "package.json").write_text(json.dumps({"scripts": {"start": start or f"node server.{suffix}"}}), encoding="utf-8")
    return tmp_path


def available():
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    return bool(shutil.which("node") and npm and (Path(npm).parent / "node_modules/npm/bin/npm-cli.js").is_file())


def test_startup_requires_execution_and_declared_start(tmp_path):
    assert probe_startup(tmp_path, threading.Event())["status"] == "unverified"
    result = probe_startup(tmp_path, threading.Event(), True)
    assert result["status"] == "failed"
    assert result["snapshot_id"] == result["snapshot_after"]
    (tmp_path / "package.json").write_text('{"scripts": {}}')
    assert probe_startup(tmp_path, threading.Event(), True)["status"] == "failed"


def test_startup_missing_runtime_is_unverified(tmp_path, monkeypatch):
    project(tmp_path, "")
    monkeypatch.setattr("codeagent.startup.shutil.which", lambda _: None)
    assert probe_startup(tmp_path, threading.Event(), True)["status"] == "unverified"


@pytest.mark.skipif(not available(), reason="Standard Node/npm runtime unavailable")
def test_startup_accepts_two_404s_and_cleans_up_without_forwarding_api_key(tmp_path, monkeypatch):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "must-not-reach-generated-process")
    source = """const http=require('node:http');
if(process.env.DASHSCOPE_API_KEY) throw new Error('credential environment inherited');
http.createServer((req,res)=>{res.statusCode=404;res.end('not found');}).listen(Number(process.env.PORT),process.env.HOST);"""
    result = probe_startup(project(tmp_path, source), threading.Event(), True, timeout=5)
    assert result["status"] == "passed"
    assert [item["status"] for item in result["http_observations"]] == [404, 404]
    assert result["cleanup"] == {"process_stopped": True, "port_closed": True}
    assert result["stale"] is False


@pytest.mark.skipif(os.name != "nt" or not available(), reason="Windows file-URL regression requires Node on Windows")
def test_startup_catches_real_windows_file_url_entry_guard_bug(tmp_path):
    source = """import {createServer} from 'node:http';
if(process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\\\/g,'/')}`){
createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT));}
"""
    result = probe_startup(project(tmp_path, source, "mjs"), threading.Event(), True, timeout=5)
    assert result["status"] == "failed"
    assert result["exit_code"] == 0
    assert result["http_observations"] == []
    assert result["cleanup"]["process_stopped"] is True


@pytest.mark.skipif(not available(), reason="Standard Node/npm runtime unavailable")
def test_startup_rejects_crash_after_first_response(tmp_path):
    source = """const http=require('node:http');
http.createServer((req,res)=>{res.end('ok');setTimeout(()=>process.exit(0),20);}).listen(Number(process.env.PORT),'127.0.0.1');"""
    result = probe_startup(project(tmp_path, source), threading.Event(), True, timeout=4)
    assert result["status"] == "failed"
    assert len(result["http_observations"]) == 1
    assert result["cleanup"] == {"process_stopped": True, "port_closed": True}


@pytest.mark.skipif(not available(), reason="Standard Node/npm runtime unavailable")
def test_startup_cancellation_stops_the_process(tmp_path):
    cancel = threading.Event()
    source = "setInterval(()=>{},1000);"
    timer = threading.Timer(0.4, cancel.set)
    timer.start()
    try:
        with pytest.raises(Cancelled):
            probe_startup(project(tmp_path, source), cancel, True, timeout=5)
    finally:
        timer.cancel()


def test_startup_refuses_arbitrary_probe_endpoints(tmp_path):
    with pytest.raises(ValueError, match="fixed endpoint"):
        probe_startup(tmp_path, threading.Event(), True, endpoint="/arbitrary")
