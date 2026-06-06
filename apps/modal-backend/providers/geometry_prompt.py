"""Turn the geometry engine's expected layout into deterministic prompt text.

fal-only geometry steering: instead of a structure-control model, we hand the
image model precise placement language derived from the projection bins
(h_pos/v_pos/size, nearest-first). Deterministic — the same layout always yields
the same clause — so it's exactly unit-testable, and the P4 grounding loop has a
matching target to verify the render against.
"""
from __future__ import annotations

from typing import Any


def layout_constraints(expected: list[dict[str, Any]]) -> str:
    """A placement clause from a projected layout (ProjectedEntity dicts, already
    depth-sorted nearest-first). Empty string when there's nothing to place."""
    if not expected:
        return ""
    parts: list[str] = []
    for e in expected:
        label = str(e.get("label") or e.get("id") or "object").strip()
        parts.append(f"{label} — {e['size']}, {e['h_pos']} {e['v_pos']}")
    return (
        "SCENE LAYOUT (place these exactly where stated — nearest listed first, "
        "keep their relative positions, sizes and front-to-back order): "
        + "; ".join(parts)
        + "."
    )


def _place_phrase(e: dict[str, Any]) -> str:
    return f"{e['h_pos']} {e['v_pos']}"


def repair_instruction(
    expected: list[dict[str, Any]],
    missing: list[str],
    misplaced: list[str],
) -> str:
    """A corrective edit instruction from a grounding diff: add the entities the
    detector couldn't find, and move the ones that landed in the wrong place to
    their target bins. Empty string when there's nothing actionable (or no listed
    label maps to a known expected entity).

    The edit model is in-context (it keeps unmentioned content), and the loop
    only runs this below the accept threshold — so the instruction stays a
    minimal "fix just these" rather than a re-describe of the whole scene."""
    by_label: dict[str, dict[str, Any]] = {}
    for e in expected:
        by_label.setdefault(str(e.get("label") or e.get("id") or ""), e)
    parts: list[str] = []
    for lbl in missing:
        ent = by_label.get(lbl)
        if ent:
            parts.append(f"add a {lbl} ({ent['size']}, {_place_phrase(ent)})")
    for lbl in misplaced:
        ent = by_label.get(lbl)
        if ent:
            parts.append(f"move the {lbl} to {_place_phrase(ent)}")
    if not parts:
        return ""
    return (
        "Keep the existing scene, its art medium, colour palette and everything "
        "else exactly as they are — only adjust these to match the intended "
        "layout: " + "; ".join(parts) + "."
    )
