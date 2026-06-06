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
