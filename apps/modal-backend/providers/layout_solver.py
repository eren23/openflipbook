"""Deterministic place-layout solver (B1 — WORLD_FROM_DESCRIPTION).

Pure: a `SceneGraph` (the structure the planner read from a description) -> a list
of `WorldEntityGeo` dicts in the shared MAP_IMAGE_FRAME (100x60), or a blocked
result carrying mechanical clarifiers. No I/O, no randomness, no LLM — same input
-> same output, so it is golden-testable (the discipline geometry_prompt.py keeps).

The planner emits ONLY relations between refs, never coordinates (the audit's
ROOT-2 failure was a model free-styling placement); this module turns relations
into positions. Coords match the world convention: origin top-left, +x EAST,
+y SOUTH, in the same MAP_IMAGE_FRAME the tap router + extract seed use.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

# Shared frame + defaults (mirror geo-tap.ts MAP_IMAGE_FRAME + world-map.ts /
# world-geometry.ts DEFAULT_FOOTPRINT=6 / DEFAULT_HEIGHT=4).
FRAME_W = 100.0
FRAME_H = 60.0
DEFAULT_FOOTPRINT = 6.0
DEFAULT_HEIGHT = 4.0
DERIVED_CONFIDENCE = 0.6  # x0.6 discount — matches deriveGeoFromExtraction (world-map.ts:358)
_GAP = 2.0

# Wall / side keyword -> which edge of the frame.
_SIDES: dict[str, str] = {
    "north": "top", "back": "top", "top": "top", "rear": "top",
    "south": "bottom", "front": "bottom", "bottom": "bottom",
    "west": "left", "left": "left",
    "east": "right", "right": "right",
}


@dataclass
class PlannedEntity:
    ref: str
    kind: str
    label: str
    visual: str
    footprint: dict[str, float] | None = None
    height: float | None = None
    count: int = 1


@dataclass
class PlannedRelation:
    subject: str
    relation: str
    object: str
    gap: float | None = None


@dataclass
class EmptyRegion:
    ref: str
    note: str
    approx: dict[str, float] | None = None


@dataclass
class SceneGraph:
    place_label: str
    place_kind: str = "place"
    bounds_hint: dict[str, float] | None = None
    entities: list[PlannedEntity] = field(default_factory=list)
    relations: list[PlannedRelation] = field(default_factory=list)
    empty_regions: list[EmptyRegion] = field(default_factory=list)
    clarifiers: list[str] = field(default_factory=list)
    contradictions: list[str] = field(default_factory=list)


@dataclass
class SolveResult:
    geos: list[dict[str, Any]]
    clarifiers: list[str]
    blocked: bool


# ── pure AABB helpers ────────────────────────────────────────────────────────
def _aabb(pos: tuple[float, float], fp: dict[str, float]) -> tuple[float, float, float, float]:
    return (pos[0] - fp["w"] / 2, pos[1] - fp["d"] / 2,
            pos[0] + fp["w"] / 2, pos[1] + fp["d"] / 2)


_Rect = tuple[float, float, float, float]


def _intersects(a: _Rect, b: _Rect) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def _kind_footprint(kind: str) -> dict[str, float]:
    # A small per-kind bias; the floor stays the shared default so units agree.
    if kind == "item":
        return {"w": 2.0, "d": 2.0}
    if kind == "creature" or kind == "person":
        return {"w": 2.0, "d": 2.0}
    return {"w": DEFAULT_FOOTPRINT, "d": DEFAULT_FOOTPRINT}


def _kind_height(kind: str) -> float:
    if kind in ("person", "creature"):
        return 3.5
    if kind == "item":
        return 1.5
    return DEFAULT_HEIGHT


def _region_rect(r: EmptyRegion, w: float, h: float) -> tuple[float, float, float, float]:
    """A reserved rectangle (x0,y0,x1,y1) for an empty region: from `approx`
    (0..1 of the place) when given, else derived from a side keyword in the note
    (a corner/edge quadrant), else the centre quadrant."""
    if r.approx:
        x = float(r.approx.get("x", 0.0)) * w
        y = float(r.approx.get("y", 0.0)) * h
        rw = float(r.approx.get("w", 0.3)) * w
        rh = float(r.approx.get("h", 0.3)) * h
        return (x, y, x + rw, y + rh)
    note = r.note.lower()
    # "centre / middle of the room" -> a central reserved box, NOT a corner.
    if any(s in note for s in ("centre", "center", "middle")):
        return (w * 0.3, h * 0.3, w * 0.7, h * 0.7)
    # else a corner/edge quadrant chosen by the side words in the note.
    qx = w / 2 if any(s in note for s in ("right", "east")) else 0.0
    qy = h / 2 if any(s in note for s in ("front", "bottom", "south")) else 0.0
    return (qx, qy, qx + w / 2, qy + h / 2)


def _wall_pos(side_ref: str, it: dict, w: float, h: float) -> tuple[float, float]:
    side = _SIDES.get(_first_keyword(side_ref), "top")
    fw, fd = it["fp"]["w"], it["fp"]["d"]
    if side == "top":
        return (w / 2, fd / 2)
    if side == "bottom":
        return (w / 2, h - fd / 2)
    if side == "left":
        return (fw / 2, h / 2)
    return (w - fw / 2, h / 2)  # right


def _first_keyword(ref: str) -> str:
    for tok in ref.lower().replace("_", " ").replace("-", " ").split():
        if tok in _SIDES:
            return tok
    return ref.lower()


def _is_wall(ref: str) -> bool:
    return _first_keyword(ref) in _SIDES


# ── placement ────────────────────────────────────────────────────────────────
def _resolve_pos(it: dict, rels: list[PlannedRelation], by_ref: dict, first: dict,
                 w: float, h: float) -> tuple[float, float] | None:
    for rel in sorted(rels, key=lambda r: (r.relation, r.object)):
        if rel.relation == "on_wall" or _is_wall(rel.object):
            return _wall_pos(rel.object, it, w, h)
        obj = by_ref.get(first.get(rel.object, ""))
        if obj is None or obj["pos"] is None:
            continue  # object not placed yet — try next pass
        gap = rel.gap if rel.gap is not None else _GAP
        ox, oy = obj["pos"]
        ow, od = obj["fp"]["w"], obj["fp"]["d"]
        iw, idp = it["fp"]["w"], it["fp"]["d"]
        if rel.relation == "inside":
            # Flat nesting (v1): sit within the container's footprint, same frame,
            # exempt from de-overlap (a prop on a shelf, not a separate sub-world;
            # true sub-frame nesting is deferred — see docs/PLAN_PLACE_TO_WORLD.md).
            it["nested"] = True
            return (ox, oy)
        if rel.relation == "behind":
            return (ox, oy - (od / 2 + idp / 2 + gap))
        if rel.relation == "in_front_of":
            return (ox, oy + (od / 2 + idp / 2 + gap))
        if rel.relation == "left_of":
            return (ox - (ow / 2 + iw / 2 + gap), oy)
        if rel.relation == "right_of":
            return (ox + (ow / 2 + iw / 2 + gap), oy)
        if rel.relation == "on_top_of":
            it["elevation"] = obj["elevation"] + obj["height"]
            return (ox, oy)
        if rel.relation == "facing":
            # placed beside the object; heading points back AT it from there.
            sx, sy = ox + (ow / 2 + iw / 2 + gap), oy
            it["heading"] = math.atan2(oy - sy, ox - sx)
            return (sx, sy)
        # "near" (and any default) — nearest free side, default right.
        return (ox + (ow / 2 + iw / 2 + gap), oy)
    return None


def _de_overlap(insts: list[dict], reserved: list[_Rect], w: float, h: float) -> None:
    # Stacked items (elevation > 0, a lamp ON a desk) and nested items (a mug
    # INSIDE a cabinet) intentionally share their support's x/y — keep them out
    # of 2D separation.
    movable = [it for it in insts
               if it["pos"] is not None and not it["elevation"] and not it.get("nested")]
    for _ in range(20):
        moved = False
        for i in range(len(movable)):
            a = movable[i]
            aabb_a = _aabb(a["pos"], a["fp"])
            # push out of reserved regions first
            for rr in reserved:
                if _intersects(aabb_a, rr):
                    a["pos"] = _push_out(a["pos"], a["fp"], rr)
                    aabb_a = _aabb(a["pos"], a["fp"])
                    moved = True
            for j in range(i + 1, len(movable)):
                b = movable[j]
                aabb_b = _aabb(b["pos"], b["fp"])
                if not _intersects(aabb_a, aabb_b):
                    continue
                # min-translation separation along the smaller-overlap axis
                ox = min(aabb_a[2], aabb_b[2]) - max(aabb_a[0], aabb_b[0])
                oy = min(aabb_a[3], aabb_b[3]) - max(aabb_a[1], aabb_b[1])
                bx, by = b["pos"]
                if ox < oy:
                    bx += ox if bx >= a["pos"][0] else -ox
                else:
                    by += oy if by >= a["pos"][1] else -oy
                b["pos"] = (_clamp(bx, b["fp"]["w"] / 2, w - b["fp"]["w"] / 2),
                            _clamp(by, b["fp"]["d"] / 2, h - b["fp"]["d"] / 2))
                # Separation must never shove b into a declared-empty region —
                # push it back out (the final solve check blocks if it's stuck).
                for rr in reserved:
                    if _intersects(_aabb(b["pos"], b["fp"]), rr):
                        b["pos"] = _push_out(b["pos"], b["fp"], rr)
                moved = True
        if not moved:
            break


def _push_out(pos: tuple, fp: dict, rr: tuple) -> tuple[float, float]:
    a = _aabb(pos, fp)
    left = a[2] - rr[0]   # push left by this to clear
    right = rr[2] - a[0]  # push right
    up = a[3] - rr[1]
    down = rr[3] - a[1]
    m = min(left, right, up, down)
    x, y = pos
    if m == left:
        x -= left
    elif m == right:
        x += right
    elif m == up:
        y -= up
    else:
        y += down
    return (x, y)


def _emit(it: dict) -> dict[str, Any]:
    geo: dict[str, Any] = {
        "id": f"geo_plan_{it['ref']}",  # `ref` carries the #n instance suffix -> unique
        "entity_id": None,
        "parent_id": None,  # flat v1: all objects share the place's frame
        "kind": it["kind"],
        "label": it["label"],
        "pos": {"x": round(it["pos"][0], 3), "y": round(it["pos"][1], 3)},
        "height": it["height"],
        "footprint": {"w": it["fp"]["w"], "d": it["fp"]["d"]},
        "visual": it["visual"],
        "state": {},
        "confidence": DERIVED_CONFIDENCE,
        "source": "derived",
    }
    if it["elevation"]:
        geo["elevation"] = round(it["elevation"], 3)
    if it["heading"] is not None:
        geo["heading"] = round(it["heading"], 4)
    return geo


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for s in items:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


def solve_layout(graph: SceneGraph) -> SolveResult:
    w = float((graph.bounds_hint or {}).get("w") or FRAME_W)
    h = float((graph.bounds_hint or {}).get("h") or FRAME_H)
    clar: list[str] = []
    blocked = bool(graph.contradictions)

    # 1. instances (fan out `count`) + kind-default footprints/heights.
    insts: list[dict] = []
    first: dict[str, str] = {}
    for e in sorted(graph.entities, key=lambda x: x.ref):
        fp = dict(e.footprint) if e.footprint else _kind_footprint(e.kind)
        fp = {"w": float(fp.get("w", DEFAULT_FOOTPRINT)), "d": float(fp.get("d", DEFAULT_FOOTPRINT))}
        height = float(e.height) if e.height is not None else _kind_height(e.kind)
        n = max(1, int(e.count or 1))
        for i in range(n):
            ref = e.ref if n == 1 else f"{e.ref}#{i + 1}"
            if i == 0:
                first[e.ref] = ref
            insts.append({
                "ref": ref, "base": e.ref, "kind": e.kind, "label": e.label,
                "visual": e.visual, "fp": dict(fp), "height": height,
                "elevation": 0.0, "heading": None, "pos": None,
            })
    by_ref = {it["ref"]: it for it in insts}

    # 2. reserved empty-region rectangles.
    reserved = [_region_rect(r, w, h) for r in graph.empty_regions]

    # 3. place by relation (object placed first); iterate to a fixpoint.
    rel_by_subj: dict[str, list[PlannedRelation]] = {}
    rel_objects: set[str] = set()
    for rel in graph.relations:
        rel_by_subj.setdefault(rel.subject, []).append(rel)
        if not _is_wall(rel.object):
            rel_objects.add(rel.object)
    subjects = set(rel_by_subj.keys())

    # Root anchors — something others are placed relative to, but itself
    # unconstrained (a desk a lamp sits ON). Seed it at the centre so its
    # dependents resolve; it is NOT unanchored, so no clarifier.
    for it in insts:
        if it["pos"] is None and it["base"] in rel_objects and it["base"] not in subjects:
            it["pos"] = (w / 2, h / 2)

    for _ in range(len(insts) + 2):
        changed = False
        for it in insts:
            if it["pos"] is not None or it["base"] not in rel_by_subj:
                continue
            pos = _resolve_pos(it, rel_by_subj[it["base"]], by_ref, first, w, h)
            if pos is not None:
                it["pos"] = (_clamp(pos[0], it["fp"]["w"] / 2, w - it["fp"]["w"] / 2),
                             _clamp(pos[1], it["fp"]["d"] / 2, h - it["fp"]["d"] / 2))
                changed = True
        if not changed:
            break

    # fan-out siblings share the base's spot until de-overlap spreads them.
    for it in insts:
        if it["pos"] is None and "#" in it["ref"]:
            anchor = by_ref.get(first.get(it["base"], ""))
            if anchor and anchor["pos"]:
                it["pos"] = anchor["pos"]

    # 4. unanchored / dangling -> clarifier + soft default (centre).
    for it in insts:
        if it["pos"] is None:
            if it["base"] in subjects:
                clar.append(f"Where should the {it['label']} go relative to?")
            else:
                clar.append(f"Where is the {it['label']}?")
            it["pos"] = (w / 2, h / 2)

    # 5. over-pack (blocking).
    area = sum(it["fp"]["w"] * it["fp"]["d"] for it in insts)
    if insts and area > w * h:
        avg = area / len(insts)
        k = max(1, int(w * h / max(avg, 1.0)))
        clar.insert(0, f"That's more than {graph.place_label} can fit (~{k}) — fewer, or a bigger place?")
        blocked = True

    # 6. de-overlap (never into a reserved region) + collision check (blocking).
    _de_overlap(insts, reserved, w, h)
    for it in insts:
        if any(_intersects(_aabb(it["pos"], it["fp"]), rr) for rr in reserved):
            clar.insert(0, f"The {it['label']} can't avoid the area you described as clear — keep it empty or move it?")
            blocked = True
            break

    # 7. emit.
    geos = [_emit(it) for it in insts]
    return SolveResult(geos=geos, clarifiers=_dedupe(clar)[:2], blocked=blocked)
