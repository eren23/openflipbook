"""Scenario Lab — versioned world/scene definitions for the unified test bench.

Scenarios are committed JSON files under scenarios/<id>.json. Each carries
dimension tags, optional world geometry, arms, and a review status gate for
paid sweeps.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SCENARIOS_DIR = Path(__file__).resolve().parent / "scenarios"
PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"
SWEEPS_DIR = Path(__file__).resolve().parent / "sweeps"
REPORTS_DIR = Path(__file__).resolve().parent / "reports"
CACHE_DIR = Path(__file__).resolve().parent / "cache"

KNOWN_DIMENSIONS = frozenset({
    "top_down",
    "detection",
    "layout",
    "dimensions",
    "pov_oblique",
    "pov_eye_level",
    "pov_top_down",
    "interior",
    "style_watercolor",
    "style_engraving",
    "style_blueprint",
    "style_photoreal",
    "model_swap",
    "edit_region",
    "continuity",
    "video",
    "ux_perf",
    "ux_understand",
})

REVIEW_STATUSES = frozenset({"draft", "verified", "retired"})

_REQUIRED_KEYS = ("id", "rev", "dimensions", "prompt", "review")


def validate_scenario(data: dict[str, Any]) -> list[str]:
    """Return a list of validation errors (empty = ok)."""
    errors: list[str] = []
    for key in _REQUIRED_KEYS:
        if key not in data:
            errors.append(f"missing required key {key!r}")
    if "dimensions" in data:
        dims = data["dimensions"]
        if not isinstance(dims, list) or not dims:
            errors.append("dimensions must be a non-empty list")
        else:
            for d in dims:
                if d not in KNOWN_DIMENSIONS:
                    errors.append(f"unknown dimension tag {d!r}")
    if "review" in data:
        review = data["review"]
        if not isinstance(review, dict):
            errors.append("review must be an object")
        elif review.get("status") not in REVIEW_STATUSES:
            errors.append(f"review.status must be one of {sorted(REVIEW_STATUSES)}")
    world = data.get("world")
    if world and "entities" in world:
        for i, ent in enumerate(world["entities"]):
            if "label" not in ent:
                errors.append(f"world.entities[{i}] missing label")
    if data.get("arms") and not isinstance(data["arms"], dict):
        errors.append("arms must be an object")
    return errors


def load_scenario(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text())
    errors = validate_scenario(data)
    if errors:
        raise ValueError(f"{path.name}: " + "; ".join(errors))
    return data


def list_scenarios(*, verified_only: bool = False) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not SCENARIOS_DIR.exists():
        return out
    for p in sorted(SCENARIOS_DIR.glob("*.json")):
        data = load_scenario(p)
        if verified_only and data.get("review", {}).get("status") != "verified":
            continue
        out.append(data)
    return out


def scenario_cell_id(data: dict[str, Any]) -> str:
    """Stable identity for cache keys — id + rev."""
    return f"{data['id']}:r{data['rev']}"


def filter_by_dimensions(
    scenarios: list[dict[str, Any]], dimension_filter: list[str] | None
) -> list[dict[str, Any]]:
    if not dimension_filter:
        return scenarios
    wanted = set(dimension_filter)
    return [s for s in scenarios if wanted.intersection(s.get("dimensions", []))]


def resolve_scenario_refs(refs: list[str], *, verified_only: bool = True) -> list[dict[str, Any]]:
    """Expand sweep scenario refs like 'scenario:*' or 'scenario:lighthouse-coast'."""
    all_scenarios = list_scenarios(verified_only=verified_only)
    by_id = {s["id"]: s for s in all_scenarios}
    out: list[dict[str, Any]] = []
    for ref in refs:
        if ref == "scenario:*":
            out.extend(all_scenarios)
        elif ref.startswith("scenario:"):
            sid = ref.split(":", 1)[1]
            if sid in by_id:
                out.append(by_id[sid])
        else:
            # passthrough for corpus:* refs handled elsewhere
            pass
    return out
