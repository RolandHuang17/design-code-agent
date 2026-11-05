"""Prepublication checks without printing matched secret contents."""
import argparse
import re
import subprocess
from pathlib import Path

from codeagent.config import user_variable


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--staged", action="store_true")
    args = parser.parse_args()
    command = ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"] if args.staged else ["git", "ls-files"]
    names = subprocess.check_output(command, text=True, encoding="utf-8").splitlines()
    secrets = [user_variable(name).encode() for name in ("DASHSCOPE_API_KEY", "DEEPSEEK_API_KEY") if user_variable(name)]
    findings = []
    for name in names:
        path = Path(name)
        if not path.is_file():
            continue
        data = path.read_bytes()
        if any(secret in data for secret in secrets):
            findings.append((name, "configured API key found"))
        if re.search(rb"\bsk-[A-Za-z0-9]{20,}\b", data):
            findings.append((name, "possible API key found"))
        if path.name.startswith("~$") or path.name == ".env" or ".venv" in path.parts or "node_modules" in path.parts:
            findings.append((name, "temporary/private/dependency file staged"))
    for name, reason in findings:
        print(f"BLOCKED: {name}: {reason}")
    if not findings:
        print(f"Release scan passed: {len(names)} files, no matching credential or excluded file found.")
    raise SystemExit(bool(findings))


if __name__ == "__main__":
    main()
