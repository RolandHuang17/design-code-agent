"""SQLite state and resource surfaces. Logs are evidence, never instructions."""
import hashlib
import json
import shutil
import sqlite3
import tempfile
import threading
import time
from pathlib import Path


class Store:
    @staticmethod
    def validate_existing(directory):
        """Inspect only copied SQLite files, never create sidecars in a selected path."""
        if isinstance(directory, str) and not directory.strip():
            raise ValueError("请选择已有原型任务目录")
        directory = Path(directory)
        if not directory.is_dir() or directory.is_symlink() or (
                hasattr(directory, "is_junction") and directory.is_junction()):
            raise ValueError("恢复目录不存在或不是普通任务目录")
        directory = directory.resolve()
        database = directory / "state.sqlite"
        project = directory / "project"
        if not database.is_file() or database.is_symlink() or not project.is_dir() or project.is_symlink() or (
                hasattr(project, "is_junction") and project.is_junction()):
            raise ValueError("所选目录没有完整的原型数据库和项目目录")
        files = [path for path in (database, directory / "state.sqlite-wal", directory / "state.sqlite-shm") if path.exists()]
        if any(not path.is_file() or path.is_symlink() for path in files):
            raise ValueError("任务数据库文件类型无效")
        observed = {path.name: (path.stat().st_size, path.stat().st_mtime_ns) for path in files}
        try:
            with tempfile.TemporaryDirectory(prefix="dca-resume-preview-") as temporary:
                copied = Path(temporary)
                for path in files:
                    shutil.copyfile(path, copied / path.name)
                current = {path.name: (path.stat().st_size, path.stat().st_mtime_ns) for path in files}
                present = {path.name for path in (database, directory / "state.sqlite-wal", directory / "state.sqlite-shm") if path.exists()}
                if current != observed or present != set(observed):
                    raise ValueError("任务数据库正在变化，请等待旧程序退出后恢复")
                connection = sqlite3.connect(copied / "state.sqlite")
                try:
                    if connection.execute("PRAGMA quick_check").fetchone() != ("ok",):
                        raise ValueError("任务数据库完整性检查失败")
                    for table, columns, primary in (
                            ("records", ["kind", "id", "value"], ["kind", "id"]),
                            ("events", ["seq", "at", "kind", "value"], ["seq"]),
                            ("resources", ["id", "version", "summary", "text"], ["id"])):
                        info = connection.execute(f'PRAGMA table_info("{table}")').fetchall()
                        if [row[1] for row in info] != columns or [row[1] for row in sorted(info, key=lambda row: row[5]) if row[5]] != primary:
                            raise ValueError("所选数据库不是受支持的原型任务格式")
                    state_row = connection.execute("SELECT value FROM records WHERE kind='run' AND id='state'").fetchone()
                    state = json.loads(state_row[0]) if state_row else None
                    if not isinstance(state, dict) or state.get("state") not in {"pending", "running", "waiting_check", "blocked", "completed", "failed", "cancelled"}:
                        raise ValueError("所选目录没有有效的原型任务状态")
                    input_row = connection.execute("SELECT value FROM records WHERE kind='run' AND id='inputs'").fetchone()
                    inputs = json.loads(input_row[0]) if input_row else None
                    if not isinstance(inputs, list) or not inputs or any(
                            not isinstance(item, dict) or not isinstance(item.get("resource"), str) or
                            not connection.execute("SELECT 1 FROM resources WHERE id=?", (item["resource"],)).fetchone()
                            for item in inputs):
                        raise ValueError("原型任务缺少有效的原始设计资源")
                finally:
                    connection.close()
        except (sqlite3.Error, OSError, ValueError, TypeError) as exc:
            raise ValueError("无法恢复所选原型任务：" + str(exc)) from None
        return directory

    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.directory / "state.sqlite", check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS records(kind TEXT, id TEXT, value TEXT, PRIMARY KEY(kind,id));
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, at REAL, kind TEXT, value TEXT);
        CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY, version TEXT, summary TEXT, text TEXT);
        """)
        self.db.commit()

    def get(self, kind, key, default=None):
        with self.lock:
            row = self.db.execute("SELECT value FROM records WHERE kind=? AND id=?", (kind, key)).fetchone()
            return json.loads(row[0]) if row else default

    def put(self, kind, key, value):
        with self.lock, self.db:
            self.db.execute("INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value",
                            (kind, key, json.dumps(value, ensure_ascii=False)))

    def all(self, kind):
        with self.lock:
            return {key: json.loads(value) for key, value in self.db.execute("SELECT id,value FROM records WHERE kind=? ORDER BY id", (kind,))}

    def event(self, kind, **value):
        with self.lock, self.db:
            self.db.execute("INSERT INTO events(at,kind,value) VALUES(?,?,?)", (time.time(), kind, json.dumps(value, ensure_ascii=False)))

    def events(self, after=0):
        with self.lock:
            return [{"seq": n, "at": at, "kind": kind, "details": json.loads(value)} for n, at, kind, value in
                    self.db.execute("SELECT seq,at,kind,value FROM events WHERE seq>? ORDER BY seq LIMIT 300", (after,))]

    def resource(self, key, text):
        digest = hashlib.sha256(text.encode()).hexdigest()
        # A version is immutable and can still be read after its logical resource changes.
        resource_id = key + "@" + digest
        with self.lock, self.db:
            self.db.execute("INSERT OR IGNORE INTO resources VALUES(?,?,?,?)", (resource_id, digest, " ".join(text.split())[:180], text))
        return {"resource": resource_id, "version": digest, "summary": " ".join(text.split())[:180], "chars": len(text)}

    def resources(self):
        """Read resource descriptors without creating another resource version."""
        with self.lock:
            return [{"resource": key, "version": version, "summary": summary, "chars": count}
                    for key, version, summary, count in self.db.execute(
                        "SELECT id,version,summary,length(text) FROM resources ORDER BY id")]

    def read(self, key, offset=0, limit=4000):
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 8000:
            raise ValueError("Invalid resource page")
        with self.lock:
            row = self.db.execute("SELECT version,summary,text FROM resources WHERE id=?", (key,)).fetchone()
        if not row:
            raise ValueError("Unknown resource")
        version, summary, text = row
        end = min(len(text), offset + limit)
        return {"resource": key, "version": version, "summary": summary, "offset": offset,
                "offset_unit": "Python Unicode characters", "text": text[offset:end], "total_chars": len(text),
                "next_offset": end if end < len(text) else None}

    def close(self):
        with self.lock:
            self.db.close()
