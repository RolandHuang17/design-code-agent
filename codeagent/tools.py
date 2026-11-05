import hashlib
import json
import threading
from pathlib import Path

from .checks import validate
from .provider import Cancelled
from .safety import Redactor, project_files, safe_path


def schema(name, description, properties, required):
    return {"type": "function", "function": {"name": name, "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required, "additionalProperties": False}}}


STRING = {"type": "string"}
TOOL_SCHEMAS = [
    schema("list_files", "List all project source paths. Dependencies are excluded.", {}, []),
    schema("read_file", "Read a project file, optionally from character offset (max 16000 chars).", {"path": STRING, "offset": {"type": "integer", "minimum": 0}}, ["path"]),
    schema("write_file", "Create a UTF-8 source file, or replace a file previously read in this context. Max 80000 bytes.", {"path": STRING, "content": STRING}, ["path", "content"]),
    schema("edit_file", "Replace exactly one occurrence in a file previously read; fails if ambiguous or stale.", {"path": STRING, "old": STRING, "new": STRING}, ["path", "old", "new"]),
    schema("run_check", "Run a fixed check profile; auth runs independent RSA/JWKS JWT acceptance for the Space Fractions module. No arbitrary shell commands.", {"profile": {"type": "string", "enum": ["static", "install", "test", "build", "compose", "auth"]}}, ["profile"]),
]


class Toolset:
    def __init__(self, root: Path, cancel: threading.Event, redactor: Redactor, allow_execution=False, on_write=None):
        self.root, self.cancel, self.redactor = root, cancel, redactor
        self.allow_execution, self.on_write = allow_execution, on_write
        self.read_hashes = {}
        self.check_history = []
        self.revision = 0

    def execute(self, name: str, arguments: str):
        if self.cancel.is_set():
            raise Cancelled("用户取消")
        try:
            spec = next((s["function"] for s in TOOL_SCHEMAS if s["function"]["name"] == name), None)
            if spec is None:
                raise ValueError("未知工具")
            args = json.loads(arguments)
            params = spec["parameters"]
            if not isinstance(args, dict) or set(args) - set(params["properties"]) or not set(params["required"]).issubset(args):
                raise ValueError("工具参数字段不匹配")
            for key, value in args.items():
                expected = params["properties"][key]
                if expected["type"] == "string" and not isinstance(value, str):
                    raise ValueError("参数必须为字符串")
                if expected["type"] == "integer" and (type(value) is not int or value < 0):
                    raise ValueError("offset 必须为非负整数")
            if name == "list_files":
                return {"files": [p.relative_to(self.root).as_posix() for p in project_files(self.root)]}
            if name == "run_check":
                result = validate(self.root, args["profile"], self.cancel, self.allow_execution)
                self.check_history.append({"revision": self.revision, **result})
                return self.redactor.value(result)
            path = safe_path(self.root, args["path"])
            if name == "read_file":
                if path.stat().st_size > 80_000:
                    raise ValueError("文件超过读取上限")
                content = path.read_text(encoding="utf-8")
                self.read_hashes[path] = hashlib.sha256(path.read_bytes()).hexdigest()
                offset = args.get("offset", 0)
                return {"content": content[offset:offset + 16000], "offset": offset, "total_chars": len(content)}
            if path.exists():
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                if self.read_hashes.get(path) != digest:
                    raise ValueError("请先读取文件，再修改；文件可能已经变化")
            if name == "edit_file":
                content = path.read_text(encoding="utf-8")
                if not args["old"] or content.count(args["old"]) != 1:
                    raise ValueError("old 必须恰好匹配一处非空内容")
                content = content.replace(args["old"], args["new"], 1)
            else:
                content = args["content"]
            if len(content.encode("utf-8")) > 80_000:
                raise ValueError("单文件超过 80000 字节；请拆分模块")
            if self.redactor.text(content) != content:
                raise ValueError("文件疑似包含 API 密钥；禁止写入")
            files = list(project_files(self.root))
            if not path.exists() and len(files) >= 300:
                raise ValueError("项目文件数达到 300 上限")
            if sum(p.stat().st_size for p in files) + len(content.encode("utf-8")) > 8_000_000:
                raise ValueError("项目大小达到 8MB 上限")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8", newline="\n")
            self.read_hashes[path] = hashlib.sha256(path.read_bytes()).hexdigest()
            self.revision += 1
            if self.on_write:
                self.on_write(args["path"], content, self.revision)
            return {"written": args["path"], "bytes": path.stat().st_size, "revision": self.revision}
        except Cancelled:
            raise
        except (ValueError, OSError, KeyError, TypeError) as exc:
            return {"error": self.redactor.text(str(exc))[:2000]}
