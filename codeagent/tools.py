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
    schema("read_file", "Read max 16000 characters. offset is a CHARACTER position, NOT a line number. For continuation use returned next_offset exactly.", {"path": STRING, "offset": {"type": "integer", "minimum": 0}}, ["path"]),
    schema("write_file", "Create a UTF-8 source file, or replace a file previously read in this context. Max 80000 bytes.", {"path": STRING, "content": STRING}, ["path", "content"]),
    schema("edit_file", "Replace exactly one occurrence in a file previously read; fails if ambiguous or stale.", {"path": STRING, "old": STRING, "new": STRING}, ["path", "old", "new"]),
    schema("run_check", "Run fixed validation. runtime starts the protected host-selected Docker/HTTP acceptance and returns actual failures. No arbitrary shell commands.", {"profile": {"type": "string", "enum": ["static", "install", "test", "integration", "build", "compose", "auth", "runtime"]}}, ["profile"]),
]


class Toolset:
    def __init__(self, root: Path, cancel: threading.Event, redactor: Redactor, allow_execution=False, on_write=None, runtime_check=None):
        self.root, self.cancel, self.redactor = root, cancel, redactor
        self.allow_execution, self.on_write = allow_execution, on_write
        self.read_hashes = {}
        self.check_history = []
        self.revision = 0
        self.read_limit = None
        self.phase_reads = 0
        self.runtime_check = runtime_check
        self.phase = None
        self.focus_path = None
        self.read_counts = {}
        self.metrics = {"reads": 0, "repeated_reads": 0, "tool_errors": 0, "writes": 0}

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
                raise ValueError(f"工具参数字段不匹配；允许字段：{', '.join(params['properties'])}；必填字段：{', '.join(params['required'])}")
            for key, value in args.items():
                expected = params["properties"][key]
                if expected["type"] == "string" and not isinstance(value, str):
                    raise ValueError("参数必须为字符串")
                if expected["type"] == "integer" and (type(value) is not int or value < 0):
                    raise ValueError("offset 必须为非负整数")
            if name == "list_files":
                return {"files": [p.relative_to(self.root).as_posix() for p in project_files(self.root)]}
            if name == "run_check":
                if self.phase in ("planning", "generation") and args["profile"] != "static":
                    return {"profile": args["profile"], "status": "unverified", "reason": "生成阶段仅开放静态检查；生成结束后宿主统一执行测试与独立运行验收"}
                if args["profile"] == "runtime":
                    result = self.runtime_check() if self.runtime_check else {"profile": "runtime", "status": "unverified", "reason": "未选择宿主运行验收方案"}
                else:
                    result = validate(self.root, args["profile"], self.cancel, self.allow_execution)
                self.check_history.append({"revision": self.revision, **result})
                return self.redactor.value(result)
            path = safe_path(self.root, args["path"])
            if name in ("write_file", "edit_file") and self.focus_path and args["path"].replace("\\", "/") != self.focus_path:
                raise ValueError(f"当前生成目标必须精确为 {self.focus_path}；不要改写到 {args['path']}。依赖路径冲突将在生成结束后统一修复。")
            if name == "read_file":
                if self.read_limit is not None and self.phase_reads >= self.read_limit:
                    raise ValueError("当前目标读取上限已到，请使用已提供的接口索引和读取结果编写目标文件，不要重复遍历仓库")
                self.phase_reads += 1
                if path.stat().st_size > 80_000:
                    raise ValueError("文件超过读取上限")
                content = path.read_text(encoding="utf-8")
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                self.read_hashes[path] = digest
                offset = args.get("offset", 0)
                key = (path, offset, digest)
                self.read_counts[key] = self.read_counts.get(key, 0) + 1
                self.metrics["reads"] += 1
                if self.read_counts[key] > 1:
                    self.metrics["repeated_reads"] += 1
                if self.read_counts[key] > 2:
                    raise ValueError("同一文件片段重复读取；请使用已返回内容修改文件，或用 next_offset 继续读取（字符位置，不是行号）")
                return {"content": content[offset:offset + 16000], "offset": offset, "offset_unit": "characters",
                        "next_offset": offset + 16000 if offset + 16000 < len(content) else None, "total_chars": len(content)}
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
            self.metrics["writes"] += 1
            self.phase_reads = 0
            if self.on_write:
                self.on_write(args["path"], content, self.revision)
            return {"written": args["path"], "bytes": path.stat().st_size, "revision": self.revision}
        except Cancelled:
            raise
        except (ValueError, OSError, KeyError, TypeError) as exc:
            self.metrics["tool_errors"] += 1
            return {"error": self.redactor.text(str(exc))[:2000]}
