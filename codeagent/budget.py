"""Persistent prepaid reservations. Ambiguous network failures stay charged."""
import json
import math
import os
import time
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path


class BudgetError(RuntimeError):
    pass


@dataclass(frozen=True)
class Prices:
    # Conservative RMB ceilings: peak USD 1.32 / 3.96 times 8 RMB/USD.
    input_per_million: float = 10.56
    output_per_million: float = 31.68
    reference_date: str = "2026-11-05"

    def __post_init__(self):
        if any(not math.isfinite(v) or v <= 0 for v in (self.input_per_million, self.output_per_million)):
            raise ValueError("价格必须为正数")


@contextmanager
def locked(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        handle.seek(0, 2)
        if not handle.tell():
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


class Budget:
    def __init__(self, path: Path, limit: float = 50, prices: Prices | None = None):
        if not math.isfinite(limit) or not 0 < limit <= 200:
            raise ValueError("累计预算必须大于 0 且不超过 200 元")
        self.path, self.limit, self.prices = path, limit, prices or Prices()

    def _read(self):
        if self.path.exists():
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if data.get("schema_version") != 1 or not isinstance(data.get("reservations"), dict):
                raise BudgetError("预算账本损坏；停止付费调用")
            for item in data["reservations"].values():
                if not isinstance(item.get("charged"), (float, int)) or not math.isfinite(item["charged"]) or item["charged"] < 0:
                    raise BudgetError("预算账本金额无效；停止付费调用")
            return data
        return {"schema_version": 1, "reservations": {}}

    def _write(self, data):
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self.path)

    def reserve(self, input_bound: int, max_output: int) -> str:
        amount = (input_bound * self.prices.input_per_million + max_output * self.prices.output_per_million) / 1_000_000
        with locked(self.path.with_suffix(".lock")):
            data = self._read()
            total = sum(item["charged"] for item in data["reservations"].values())
            if total + amount > self.limit:
                raise BudgetError(f"预算不足：累计已计 {total:.4f} 元，本次需预留 {amount:.4f} 元，上限 {self.limit:.2f} 元")
            key = uuid.uuid4().hex
            data["reservations"][key] = {"charged": amount, "reserved": amount, "state": "uncertain",
                                          "time": time.time(), "prices": asdict(self.prices)}
            self._write(data)
            return key

    def settle(self, key: str, usage: dict) -> float:
        prompt, completion = usage.get("prompt_tokens"), usage.get("completion_tokens")
        if any(type(v) is not int or v < 0 for v in (prompt, completion)):
            raise BudgetError("API 未返回有效 usage，保留预留费用并停止调用")
        amount = (prompt * self.prices.input_per_million + completion * self.prices.output_per_million) / 1_000_000
        with locked(self.path.with_suffix(".lock")):
            data = self._read()
            item = data["reservations"][key]
            item.update(charged=amount, state="settled", usage=usage)
            self._write(data)
            if amount > item["reserved"] + 1e-8:
                raise BudgetError("实际 usage 超出预留，停止调用并核查价格及计数")
        return amount

    def snapshot(self):
        with locked(self.path.with_suffix(".lock")):
            data = self._read()
        return {"limit_cny": self.limit, "charged_cny": sum(i["charged"] for i in data["reservations"].values()),
                "uncertain_requests": sum(i["state"] != "settled" for i in data["reservations"].values()),
                "request_count": len(data["reservations"]), "prices": asdict(self.prices)}


def default_ledger() -> Path:
    return Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".local" / "share"))) / "DesignCodeAgent" / "budget.json"
