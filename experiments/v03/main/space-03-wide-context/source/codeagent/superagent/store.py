"""SQLite state and resource surfaces. Logs are evidence, never instructions."""
import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path


class Store:
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
