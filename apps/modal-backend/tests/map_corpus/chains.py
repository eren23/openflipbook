"""Descent chains: link a child reference (an interior/closeup manifest row) to a
place ENTITY in a parent map, so the descent bench can crop the parent at that
spot, generate an "enter" view, and score it against the REAL child image.

The link lives on the child's MANIFEST row (parent_id + parent_ref) — the child
needs no description of its own; its ground truth is the photo. The parent must
have a (verified) corpus description so parent_ref resolves to a position.

Sourcing a chain that actually MEASURES place_lift (learned the hard way):

  1. The parent must depict the child's SPECIFIC identity, not a generic icon.
     The seeded manor::church -> Chester nave chain scores place_lift=0 because a
     village-map church glyph carries no Chester-specific identity to transfer —
     continuity_with (footprint) is 9, but there is nothing to *place*-match.

  2. Mind the exterior/interior gap. The descent prompt generates a *closer view*
     of the place; by default that view is "interior". A map crop shows a
     building's EXTERIOR, so it can only transfer identity the interior shares —
     a distinctive DOME, a footprint, a silhouette. A plain facade -> an
     arbitrary hall will not move place_lift (both the conditioned and baseline
     gens guess a generic interior). Two chain shapes DO measure:
       (a) interior-predictive: a distinctive exterior that defines the inside
           (a domed rotunda on the map -> its domed reading room), or
       (b) exterior-closeup: set the child row's `view: "exterior"` and pair a
           map building with an exterior closeup of the SAME building — a
           distinctive silhouette transfers and place_lift becomes measurable.

  3. Prefer same-medium pairs, or lean on score_place_match (medium-agnostic):
     an illustrated parent -> a photographed child is fine for place_lift (it
     ignores medium) but sinks style_lift, which stays a secondary signal.

  Row shape for a chain child: {..., parent_id, parent_ref, view?: "interior"}.
"""
from __future__ import annotations

from typing import Any


def parent_anchor(parent_desc: dict[str, Any], parent_ref: str) -> dict[str, Any] | None:
    """The parent entity named by `parent_ref`, as a 'place' dict
    {label, pos:{x,y}} for the region crop — or None if the ref isn't present."""
    for e in parent_desc.get("entities", []):
        if e.get("ref") == parent_ref and isinstance(e.get("pos"), dict):
            return {"label": str(e.get("label") or parent_ref), "pos": e["pos"]}
    return None


def descent_chains(
    manifest_rows: list[dict[str, Any]], descs_by_id: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    """Resolve every child row whose parent_id has a description AND whose
    parent_ref names a real entity in it. A row missing the link, or pointing at
    an unknown parent / entity, is skipped."""
    by_id = {m["id"]: m for m in manifest_rows}
    out: list[dict[str, Any]] = []
    for row in manifest_rows:
        pid, pref = row.get("parent_id"), row.get("parent_ref")
        if not pid or not pref:
            continue
        parent_desc = descs_by_id.get(pid)
        parent_row = by_id.get(pid)
        if not parent_desc or not parent_row:
            continue
        anchor = parent_anchor(parent_desc, str(pref))
        if not anchor:
            continue
        out.append(
            {
                "child_id": row["id"],
                "child_filename": row["filename"],
                "parent_id": pid,
                "parent_filename": parent_row["filename"],
                "label": anchor["label"],
                "anchor": anchor,
                # "interior" (default) enters the place; "exterior" generates a
                # closer OUTSIDE view — the shape that measures place_lift when
                # the map already draws a distinctive exterior (see module docs).
                "view": str(row.get("view", "interior")),
            }
        )
    return out
