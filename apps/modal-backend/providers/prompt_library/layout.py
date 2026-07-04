"""Turn the geometry engine's expected layout into deterministic prompt text.

fal-only geometry steering: instead of a structure-control model, we hand the
image model precise placement language derived from the projection bins
(h_pos/v_pos/size, nearest-first). Deterministic — the same layout always yields
the same clause — so it's unit-testable, and the grounding loop has a matching
target to verify the render against.

(Moved verbatim from providers/geometry_prompt.py, which re-exports for
compatibility; the view-grammar extensions — relative heights, depth layers,
observer-relative bearings — bolt on here as default-off kwargs.)
"""
from __future__ import annotations

from providers.geometry import ProjectedEntity


def _ratio_words(r: float) -> str:
    """Coarse word-ratios only — absolute units are dead on arrival
    (research/09: 'specifying different measurements has little effect')."""
    if r >= 1.5:
        half = round(r * 2.0) / 2.0
        if abs(half - 1.5) < 1e-9:
            return "one and a half times"
        if half == int(half):
            return f"{int(half)}x"
        return f"{half:g}x"
    if r <= 0.4:
        return "a third"
    if r <= 0.55:
        return "half"
    return "two thirds"


def _heights_clause(heights: list[tuple[str, float, str]], budget: int) -> str:
    """(label, ratio_vs_anchor, anchor_label); only ratios >=1.5 or <=0.67
    speak (anything closer is noise the model can't honor); max 3; ONE shared
    anchor expected. No meters, ever."""
    picked = [
        (lbl, r, anch) for (lbl, r, anch) in heights if r >= 1.5 or r <= 0.67
    ][: min(3, max(0, budget))]
    if not picked:
        return ""
    parts = [
        f"{lbl} rises about {_ratio_words(r)} the height of {anch}"
        for (lbl, r, anch) in picked
    ]
    return "RELATIVE HEIGHTS (true vertical proportions): " + "; ".join(parts) + "."


def _rects_overlap(a: ProjectedEntity, b: ProjectedEntity) -> bool:
    return (
        abs(a["x_pct"] - b["x_pct"]) < (a["w_pct"] + b["w_pct"]) / 2.0
        and abs(a["y_pct"] - b["y_pct"]) < (a["h_pct"] + b["h_pct"]) / 2.0
    )


def _entity_name(e: ProjectedEntity) -> str:
    return str(e.get("label") or e.get("id") or "object").strip()


def _depth_layers_clause(
    expected: list[ProjectedEntity], budget: int
) -> tuple[str, int]:
    """fg/mg/bg grouping by depth terciles — the best-honored spatial axis
    (research/09: depth words ~0.36-0.39 vs ~0.21-0.29 for 2-D left/right).
    Occlusion pairs ONLY where projected rects actually overlap (max 2).
    Returns (clause, assertions_used). Skipped when depth spread is
    uninformative."""
    if len(expected) < 3 or budget <= 0:
        return "", 0
    depths = [e["depth"] for e in expected]
    d_min, d_max = min(depths), max(depths)
    if d_max < d_min * 1.25 + 1e-9:
        return "", 0
    t1 = d_min + (d_max - d_min) / 3.0
    t2 = d_min + 2.0 * (d_max - d_min) / 3.0
    fg = [e for e in expected if e["depth"] <= t1]
    mg = [e for e in expected if t1 < e["depth"] <= t2]
    bg = [e for e in expected if e["depth"] > t2]
    # <=4 labels in fg/mg (overflow rolls back a layer); bg holds the rest —
    # one constraint regardless of label count (the folding rule).
    mg = fg[4:] + mg
    fg = fg[:4]
    bg = mg[4:] + bg
    mg = mg[:4]
    layers = [
        (name, grp)
        for name, grp in (("foreground", fg), ("midground", mg), ("background", bg))
        if grp
    ]
    used = len(layers)
    if used > budget:
        return "", 0
    text = (
        "DEPTH LAYERS (front to back): "
        + "; ".join(
            f"{name} — " + ", ".join(_entity_name(e) for e in grp)
            for name, grp in layers
        )
        + "."
    )
    occl = 0
    for i, near in enumerate(expected):
        if occl >= 2 or used + occl >= budget:
            break
        for far in expected[i + 1 :]:
            if far["depth"] > near["depth"] * 1.1 and _rects_overlap(near, far):
                text += (
                    f" The {_entity_name(far)} is partially hidden behind "
                    f"the {_entity_name(near)}."
                )
                occl += 1
                break
    return text, used + occl


# The register pin (AUDIT_BOX §4): the SCENE LAYOUT bins are honoured only up
# to an arbitrary similarity transform — the model paints the feature cluster
# inside margins/a disk instead of spanning the sheet (recon bench: pos_raw
# ≈ 0.05 vs pos_aligned 0.7-0.84; the fitted scale hits the 0.5 clamp). This
# exact wording is the committed recon_base.v2 A/B winner (matrix 2026-06-13:
# +0.17…+0.56 pos_raw on the drifting cells, ~-0.1 style tax) — thirds
# language only, per research/09's no-grid-refs rule.
REGISTER_PIN_CLAUSE = (
    "Compose to the stated layout EXACTLY: treat the SCENE LAYOUT lines as a "
    "strict grid — each named feature sits at the named third of the sheet "
    "(left/center/right, top/mid/bottom), at the stated relative size. Do not "
    "re-center or re-balance the composition."
)


def layout_constraints(
    expected: list[ProjectedEntity],
    *,
    heights: list[tuple[str, float, str]] | None = None,
    depth_layers: bool = False,
    max_entity_lines: int | None = None,
    max_assertions: int = 12,
    register_pin: bool = False,
) -> str:
    """A placement block from a projected layout (ProjectedEntity dicts,
    already depth-sorted nearest-first). Empty string when there's nothing to
    place. Defaults (all extensions off, max_entity_lines=None) -> byte-
    identical to the pre-grammar clause.

    Extended (research/09): blocks join in the evidence-backed order
    SCENE LAYOUT -> DEPTH LAYERS -> RELATIVE HEIGHTS, nearest first, positives
    only, <= max_assertions total; over budget the farthest entities FOLD into
    one background segment (never truncated). Observer-relative bearings were
    researched (09 §iii) but are not implemented until a caller computes real
    per-entity bearings — no dead vocabulary."""
    if not expected:
        return ""
    placed = expected
    folded: list[ProjectedEntity] = []
    if max_entity_lines is not None and len(expected) > max_entity_lines:
        placed = expected[:max_entity_lines]
        folded = expected[max_entity_lines:]
    parts: list[str] = []
    for e in placed:
        parts.append(f"{_entity_name(e)} — {e['size']}, {e['h_pos']} {e['v_pos']}")
    scene = (
        "SCENE LAYOUT (place these exactly where stated — nearest listed first, "
        "keep their relative positions, sizes and front-to-back order): "
        + "; ".join(parts)
    )
    if folded:
        names = ", ".join(_entity_name(e) for e in folded)
        scene += f"; the rest in the background, smallest and farthest — {names}"
    scene += "."

    used = len(parts) + (1 if folded else 0)
    blocks: list[str] = [scene]
    if depth_layers:
        clause, n = _depth_layers_clause(expected, max_assertions - used)
        if clause:
            blocks.append(clause)
            used += n
    if heights:
        clause = _heights_clause(heights, max_assertions - used)
        if clause:
            blocks.append(clause)
    if register_pin:
        blocks.append(REGISTER_PIN_CLAUSE)
    return "\n".join(blocks)


def _place_phrase(e: ProjectedEntity) -> str:
    return f"{e['h_pos']} {e['v_pos']}"


def repair_instruction(
    expected: list[ProjectedEntity],
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
    by_label: dict[str, ProjectedEntity] = {}
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
