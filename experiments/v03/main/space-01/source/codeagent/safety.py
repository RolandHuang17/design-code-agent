import json
import re
from pathlib import Path, PureWindowsPath


class Redactor:
    def __init__(self, *secrets: str):
        self.secrets = tuple(s for s in secrets if s)

    def text(self, value: str) -> str:
        for secret in self.secrets:
            value = value.replace(secret, "[REDACTED]")
        return re.sub(r"\bsk-[A-Za-z0-9_-]{8,}\b", "[REDACTED]", value)

    def value(self, value):
        return json.loads(self.text(json.dumps(value, ensure_ascii=False)))


def safe_path(root: Path, name: str) -> Path:
    if not isinstance(name, str) or not name or len(name) > 220:
        raise ValueError("无效的相对路径")
    windows = PureWindowsPath(name)
    parts = name.replace("\\", "/").split("/")
    reserved = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
    if windows.drive or windows.root or any(p in ("", ".", "..") for p in parts):
        raise ValueError("只允许输出目录内的相对文件路径")
    if any(re.search(r'[<>:"|?*\x00-\x1f]', p) or p.endswith((".", " ")) or p.split(".")[0].upper() in reserved for p in parts):
        raise ValueError("路径含 Windows 禁止字符或保留名")
    if any(p.lower() in {".git", "node_modules", ".venv", "__pycache__"} for p in parts):
        raise ValueError("禁止访问内部或依赖目录")
    resolved = root.resolve()
    target = root.joinpath(*parts)
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            raise ValueError("禁止通过符号链接或 junction 访问文件")
    if not target.resolve().is_relative_to(resolved):
        raise ValueError("路径越界")
    return target


def project_files(root: Path):
    """Do not follow model-created symlinks, including directory junctions."""
    import os
    for parent, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in {"node_modules", ".git", ".venv", "__pycache__"}
                         and not (Path(parent) / d).is_symlink()
                         and not (hasattr(Path, "is_junction") and (Path(parent) / d).is_junction()))
        for name in sorted(files):
            path = Path(parent) / name
            if not path.is_symlink():
                yield path
