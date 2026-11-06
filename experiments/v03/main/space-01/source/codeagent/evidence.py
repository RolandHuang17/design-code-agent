"""Content identities for source and verification evidence (not model claims)."""
import hashlib
from pathlib import Path

from .safety import project_files


def project_snapshot(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(project_files(root), key=lambda p: p.relative_to(root).as_posix()):
        name = path.relative_to(root).as_posix().encode("utf-8")
        data = path.read_bytes()
        digest.update(len(name).to_bytes(4, "big"))
        digest.update(name)
        digest.update(hashlib.sha256(data).digest())
    return digest.hexdigest()


def bind_check(result, before, after):
    result = {**result, "snapshot_id": before, "snapshot_after": after, "stale": before != after}
    if before != after and result.get("profile") != "install":
        result.update(status="unverified", reason="Project changed while this check ran; rerun against current sources")
    # Installation legitimately derives a lockfile; its success belongs to the resulting snapshot.
    if result.get("profile") == "install" and result.get("status") == "passed":
        result.update(snapshot_id=after, stale=False)
    return result
