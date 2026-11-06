"""Operator-authored Docker diagnostic smoke; no generated/model source involved."""
import hashlib
import json
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from codeagent.engine import Agent
from codeagent.runtime import ComposeSession
from codeagent.safety import Redactor

import tempfile
base = Path(tempfile.mkdtemp(prefix="dca-diagnostics-reproduction-"))
fixture = base / "fixture"
fixture.mkdir(exist_ok=True)
source = """services:
  keycloak:
    image: node:22-alpine
    command: ["node", "-e", "setInterval(()=>{},1000)"]
    healthcheck:
      test: ["CMD-SHELL", "echo DCA_OPERATOR_HEALTHCHECK_FAILURE >&2; exit 1"]
      interval: 1s
      timeout: 1s
      retries: 2
  gateway:
    image: node:22-alpine
    command: ["node", "-e", "setInterval(()=>{},1000)"]
    depends_on:
      keycloak:
        condition: service_healthy
"""
compose = fixture / "compose.yaml"
compose.write_text(source, encoding="utf-8")
session = ComposeSession(fixture, base / "evidence", threading.Event(), Redactor(), backend="wsl")
result = {"profile": "runtime", "status": "failed", "origin": "operator-authored fixture; no model calls or generated source",
          "fixture_path": str(compose), "fixture_source": source,
          "fixture_sha256": hashlib.sha256(compose.read_bytes()).hexdigest(), "project": session.project}
try:
    session.start()
    result["unexpected_start_success"] = True
except Exception as exc:
    result["error"] = str(exc)
finally:
    result["cleanup"] = session.close()
    remaining = session.command(["ps", "--all", "--format", "json"], timeout=10)
    result["remaining_owned_ps"] = remaining
    result["no_owned_containers_remain"] = remaining["status"] == "passed" and remaining.get("output", "").strip() in ("", "[]")
    result["stages"] = session.stages
    feedback = Agent.bounded_checks([result])[0]["details_excerpt"]
    result["bounded_feedback"] = feedback
    result["marker_visible_in_feedback"] = "DCA_OPERATOR_HEALTHCHECK_FAILURE" in feedback
    result["actual_inspect_stage_present"] = any(s.get("stage", [""])[0] == "inspect" for s in session.stages)
    (base / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: result[key] for key in ("project", "cleanup", "no_owned_containers_remain", "marker_visible_in_feedback", "actual_inspect_stage_present", "error", "fixture_sha256")}, ensure_ascii=False))
