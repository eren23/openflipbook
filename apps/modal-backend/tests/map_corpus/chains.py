"""Descent chains: link a child reference (an interior/closeup manifest row) to a
place ENTITY in a parent map, so the descent bench can crop the parent at that
spot, generate an "enter" view, and score it against the REAL child image.

The link lives on the child's MANIFEST row (parent_id + parent_ref) — the child
needs no description of its own; its ground truth is the photo. The parent must
have a (verified) corpus description so parent_ref resolves to a position.
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
            }
        )
    return out
