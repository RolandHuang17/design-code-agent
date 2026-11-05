"""Independent HTTP acceptance, kept OUTSIDE the model's generated project.

Run with services/identity provider up and SPACE_USER_TOKEN, SPACE_ADMIN_TOKEN,
SPACE_OTHER_USER_TOKEN configured. These are game access tokens, not model API keys.
Creates one temporary question; does not deploy or install anything.
"""
import argparse
import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote, urlsplit


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:3000")
    parser.add_argument("--report", type=Path, default=Path("acceptance-report.json"))
    args = parser.parse_args()
    parsed = urlsplit(args.base_url)
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password or parsed.query or parsed.fragment:
        parser.error("Invalid base URL")
    tokens = {key: os.environ.get(env) for key, env in (("user", "SPACE_USER_TOKEN"), ("admin", "SPACE_ADMIN_TOKEN"), ("other", "SPACE_OTHER_USER_TOKEN"))}
    if not all(tokens.values()):
        parser.error("Set SPACE_USER_TOKEN, SPACE_ADMIN_TOKEN and SPACE_OTHER_USER_TOKEN (game OIDC tokens)")
    results = []
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(method, path, actor=None, body=None):
        headers = {"Content-Type": "application/json"}
        if actor:
            headers["Authorization"] = "Bearer " + tokens[actor]
        req = urllib.request.Request(args.base_url.rstrip("/") + path,
                                     data=json.dumps(body).encode() if body is not None else None, method=method, headers=headers)
        try:
            with opener.open(req, timeout=15) as response:
                raw = response.read(1_000_000)
                return response.status, json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as exc:
            return exc.code, {}

    def check(name, condition):
        results.append({"check": name, "status": "passed" if condition else "failed"})
        if not condition:
            raise AssertionError(name)

    question = None
    error = None
    try:
        status, _ = request("GET", "/health")
        check("health", status == 200)
        status, _ = request("POST", "/api/games", body={})
        check("missing authentication rejected", status == 401)
        fixture = {"prompt": "Independent acceptance: 1/2 + 1/4 = ?", "options": ["3/4", "1/4", "1/2", "1"], "correctAnswer": "3/4"}
        status, _ = request("POST", "/api/admin/questions", "user", fixture)
        check("ordinary user denied admin mutation", status == 403)
        status, item = request("POST", "/api/admin/questions", "admin", fixture)
        check("admin question creation", status == 201 and bool(item.get("id")))
        question = str(item["id"])
        status, game = request("POST", "/api/games", "user", {"questionIds": [question]})
        check("game creation", status == 201 and bool(game.get("id")))
        check("question answer not exposed", bool(game.get("questions")) and "correctAnswer" not in json.dumps(game))
        game_path = "/api/games/" + quote(str(game["id"]), safe="")
        status, _ = request("GET", game_path, "other")
        check("cross-user game access denied", status in (403, 404))
        status, _ = request("POST", game_path + "/pause", "user", {})
        check("pause", status == 200)
        answer = {"questionId": question, "answer": "3/4"}
        status, _ = request("POST", game_path + "/answers", "user", answer)
        check("paused game rejects answer", status == 409)
        status, _ = request("POST", game_path + "/resume", "user", {})
        check("resume", status == 200)
        status, _ = request("POST", game_path + "/answers", "user", {"questionId": question, "answer": "1/0"})
        check("invalid fraction rejected", status == 400)
        status, answer_result = request("POST", game_path + "/answers", "user", answer)
        check("correct scoring", status == 200 and answer_result.get("correct") is True and answer_result.get("score") == 1)
        status, _ = request("POST", game_path + "/answers", "user", answer)
        check("duplicate answer handled", status in (200, 409))
        status, score = request("GET", game_path + "/score", "user")
        check("score remains one after duplicate", status == 200 and score.get("score") == 1)
        status, _ = request("GET", game_path, "user")
        check("game reload", status == 200)
    except Exception as exc:
        error = type(exc).__name__  # never serialize credential-bearing request objects
    finally:
        if question:
            try:
                status, _ = request("DELETE", "/api/admin/questions/" + quote(question, safe=""), "admin")
                results.append({"check": "cleanup", "status": "passed" if status in (200, 204) else "failed"})
            except Exception:
                results.append({"check": "cleanup", "status": "failed"})
        report = {"kind": "independent_http_acceptance", "status": "failed" if error or any(r["status"] == "failed" for r in results) else "passed",
                  "checks": results, "error_type": error,
                  "limitations": ["Does not prove persistence across service restart", "Does not prove browser usability or production performance"]}
        args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2))
    raise SystemExit(0 if report["status"] == "passed" else 1)


if __name__ == "__main__":
    main()
