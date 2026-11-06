"""Content identities for source and verification evidence (not model claims)."""
import hashlib
from pathlib import Path

from .safety import project_files


def project_snapshot(root: Path, excluded=()) -> str:
    digest = hashlib.sha256()
    for path in sorted(project_files(root), key=lambda p: p.relative_to(root).as_posix()):
        if path.relative_to(root).as_posix() in excluded:
            continue
        name = path.relative_to(root).as_posix().encode("utf-8")
        data = path.read_bytes()
        digest.update(len(name).to_bytes(4, "big"))
        digest.update(name)
        digest.update(hashlib.sha256(data).digest())
    return digest.hexdigest()


def bind_check(result, before, after, allow_derived_install=False):
    result = {**result, "snapshot_id": before, "snapshot_after": after, "stale": before != after}
    if before != after and not (result.get("profile") == "install" and allow_derived_install):
        result.update(status="unverified", reason="Project changed while this check ran; rerun against current sources")
    # Installation legitimately derives a lockfile; its success belongs to the resulting snapshot.
    if result.get("profile") == "install" and allow_derived_install and result.get("status") == "passed":
        result.update(snapshot_id=after, stale=False)
    return result
