"""Exercise the external HTTP harness against a deliberately minimal contract fixture.
This checks the harness, not Space Fractions or model generation.
"""
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from codeagent.checks import clean_environment


def test_independent_harness_detects_duplicate_score_bug(tmp_path):
    class Handler(BaseHTTPRequestHandler):
        paused = False
        score = 0
        def log_message(self, *args):
            pass
        def handle_api(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
            actor = self.headers.get("Authorization")
            status, result = 200, {}
            if self.path == "/health":
                pass
            elif not actor:
                status = 401
            elif actor == "Bearer invalid.jwt.signature":
                status = 401
            elif self.path.startswith("/api/admin/"):
                if actor != "Bearer admin":
                    status = 403
                elif self.command == "POST":
                    status, result = 201, {"id": "q1"}
                else:
                    status = 204
            elif self.path == "/api/games":
                status, result = 201, {"id": "g1", "questions": [{"id": "q1", "prompt": "fixture", "options": ["3/4"]}]}
            elif actor == "Bearer other":
                status = 403
            elif self.path.endswith("/pause"):
                Handler.paused = True
            elif self.path.endswith("/resume"):
                Handler.paused = False
            elif self.path.endswith("/answers"):
                if Handler.paused:
                    status = 409
                elif body["answer"] == "1/0":
                    status = 400
                else:
                    Handler.score += 1  # Deliberate bug: duplicates increase score.
                    result = {"correct": True, "score": Handler.score}
            elif self.path.endswith("/score"):
                result = {"score": Handler.score}
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            if status != 204:
                self.wfile.write(json.dumps(result).encode())
        do_GET = do_POST = do_DELETE = handle_api

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        env = clean_environment()
        env.update(SPACE_USER_TOKEN="user", SPACE_ADMIN_TOKEN="admin", SPACE_OTHER_USER_TOKEN="other")
        path = tmp_path / "report.json"
        process = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / "scripts/evaluate_project.py"),
                                  "--base-url", f"http://127.0.0.1:{server.server_port}", "--report", str(path)],
                                 env=env, capture_output=True, timeout=20)
        assert process.returncode == 1
        report = json.loads(path.read_text(encoding="utf-8"))
        assert {"check": "score remains one after duplicate", "status": "failed"} in report["checks"]
        assert {"check": "cleanup", "status": "passed"} in report["checks"]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
