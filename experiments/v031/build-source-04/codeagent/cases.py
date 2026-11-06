"""Host-selected acceptance profiles; supplements remain identifiable input data."""
import sys
from pathlib import Path

from .inputs import parse_markdown

PROFILES = ("generic-node", "space-fractions", "library")


def supplement(profile):
    if profile not in PROFILES:
        raise ValueError("未知验收方案")
    if profile == "generic-node":
        return None, None
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).parent.parent))
    path = base / "codeagent/cases" / (profile + ".md")
    doc = parse_markdown(path, "operator_supplement")
    doc["origin"] = "Operator benchmark supplement; not original design"
    return path, doc
