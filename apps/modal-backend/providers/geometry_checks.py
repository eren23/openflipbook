"""Deterministic geometry/consistency invariant checks — development anchors.

Pure functions over the geometric-world dicts (WorldEntityGeo / ProjectedEntity /
ObserverPose / SceneView / MapCrop, mirrored from packages/config). They return a
list of GeoIssue and NEVER raise, so the caller picks the posture:

- tests assert an empty list on valid fixtures + the expected codes on bad ones;
- the request validators (generate.py) raise on a non-empty list to fail loud on
  bad INPUT geometry;
- runtime seams (post-solve, post-detect) log them as OUTPUT-quality diagnostics
  without breaking the user-facing flow.

Field names + value sets mirror the TS contract (packages/config/src/index.ts);
the schema-parity gate keeps the shapes in lockstep, so the small expected-value
sets encoded here track that contract.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

# Expected value sets — mirror the TS unions in packages/config.
ENTITY_KINDS = frozenset({"person", "place", "item", "creature"})
GEO_SOURCES = frozenset({"extracted", "user", "derived"})
VIEW_LEVELS = frozenset({"map", "building", "street", "eye"})
H_POS = frozenset({"far-left", "left", "center", "right", "far-right"})
V_POS = frozenset({"top", "mid", "bottom"})
SIZE_BINS = frozenset({"tiny", "small", "medium", "large", "huge"})

_MAX_FOV = math.pi  # a horizontal FOV past 180° is a mis-built pose
_HALF_PI = math.pi / 2.0
_PCT_EPS = 0.01  # the projector clips to [0,1]; allow a hair of float slack


@dataclass(frozen=True)
class GeoIssue:
    code: str
    detail: str

    def __str__(self) -> str:
        return f"[{self.code}] {self.detail}"


def _num(v: Any) -> float | None:
    """The finite numeric value of v, or None. Rejects bool (an int subclass —
    a flag is never a coordinate) and NaN/inf."""
    if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
        return float(v)
    return None


def _vec2_ok(v: Any) -> bool:
    return isinstance(v, dict) and _num(v.get("x")) is not None and _num(v.get("y")) is not None


def check_geo_entities(
    entities: list[dict[str, Any]], *, valid_tiers: frozenset[str] | None = None
) -> list[GeoIssue]:
    """Validate a WorldEntityGeo[] (the solver / seed / upsert shape)."""
    issues: list[GeoIssue] = []
    ids = {str(e["id"]) for e in entities if isinstance(e, dict) and e.get("id")}
    seen: set[str] = set()
    for i, e in enumerate(entities):
        if not isinstance(e, dict):
            issues.append(GeoIssue("geo.not_dict", f"entity[{i}] is not an object"))
            continue
        eid = str(e.get("id") or f"#{i}")
        if not e.get("id"):
            issues.append(GeoIssue("geo.missing_id", f"entity[{i}] has no id"))
        elif eid in seen:
            issues.append(GeoIssue("geo.dup_id", f"duplicate entity id {eid!r}"))
        seen.add(eid)

        if not _vec2_ok(e.get("pos")):
            issues.append(GeoIssue("geo.bad_pos", f"{eid}: pos must be finite {{x,y}}"))
        fp = e.get("footprint")
        fw = _num(fp.get("w")) if isinstance(fp, dict) else None
        fd = _num(fp.get("d")) if isinstance(fp, dict) else None
        if fw is None or fd is None:
            issues.append(GeoIssue("geo.bad_footprint", f"{eid}: footprint must be finite {{w,d}}"))
        elif fw <= 0 or fd <= 0:
            issues.append(
                GeoIssue("geo.nonpositive_footprint", f"{eid}: footprint must be > 0 ({fw}x{fd})")
            )
        h = _num(e.get("height"))
        if h is None or h < 0:
            issues.append(GeoIssue("geo.bad_height", f"{eid}: height must be finite and >= 0"))
        for opt in ("elevation", "heading"):
            if e.get(opt) is not None and _num(e[opt]) is None:
                issues.append(GeoIssue("geo.bad_number", f"{eid}: {opt} must be finite when set"))
        if e.get("scale") is not None:
            s = _num(e["scale"])
            if s is None or s <= 0:
                issues.append(GeoIssue("geo.bad_scale", f"{eid}: scale must be finite and > 0 when set"))
        c = _num(e.get("confidence"))
        if c is None or not (0.0 <= c <= 1.0):
            issues.append(GeoIssue("geo.bad_confidence", f"{eid}: confidence must be in [0,1]"))
        if e.get("kind") not in ENTITY_KINDS:
            issues.append(GeoIssue("geo.bad_kind", f"{eid}: kind {e.get('kind')!r} invalid"))
        if e.get("source") not in GEO_SOURCES:
            issues.append(GeoIssue("geo.bad_source", f"{eid}: source {e.get('source')!r} invalid"))
        tier = e.get("scale_tier")
        if tier is not None and valid_tiers is not None and tier not in valid_tiers:
            issues.append(GeoIssue("geo.bad_tier", f"{eid}: scale_tier {tier!r} invalid"))
        pid = e.get("parent_id")
        if pid is not None and str(pid) not in ids:
            issues.append(GeoIssue("geo.dangling_parent", f"{eid}: parent_id {pid!r} not in the set"))
    issues.extend(_parent_cycles(entities))
    return issues


def _parent_cycles(entities: list[dict[str, Any]]) -> list[GeoIssue]:
    parent = {
        str(e["id"]): str(e["parent_id"])
        for e in entities
        if isinstance(e, dict) and e.get("id") and e.get("parent_id")
    }
    issues: list[GeoIssue] = []
    for start in parent:
        seen: set[str] = set()
        cur: str | None = start
        while cur is not None:
            if cur in seen:
                issues.append(GeoIssue("geo.parent_cycle", f"parent chain cycles at {cur!r}"))
                break
            seen.add(cur)
            cur = parent.get(cur)
    return list({(i.code, i.detail): i for i in issues}.values())


def check_projected(layout: list[dict[str, Any]]) -> list[GeoIssue]:
    """Validate a ProjectedEntity[] (expected_layout — the prompt-injection input)."""
    issues: list[GeoIssue] = []
    seen: set[str] = set()
    for i, p in enumerate(layout):
        if not isinstance(p, dict):
            issues.append(GeoIssue("proj.not_dict", f"layout[{i}] is not an object"))
            continue
        pid = str(p.get("id") or f"#{i}")
        if pid in seen:
            issues.append(GeoIssue("proj.dup_id", f"duplicate projected id {pid!r}"))
        seen.add(pid)
        for k in ("x_pct", "y_pct", "w_pct", "h_pct"):
            v = _num(p.get(k))
            if v is None:
                issues.append(GeoIssue("proj.bad_pct", f"{pid}: {k} must be finite"))
            elif not (-_PCT_EPS <= v <= 1.0 + _PCT_EPS):
                issues.append(GeoIssue("proj.pct_range", f"{pid}: {k}={v} outside [0,1]"))
        d = _num(p.get("depth"))
        if d is None or d < 0:
            issues.append(GeoIssue("proj.bad_depth", f"{pid}: depth must be finite and >= 0"))
        if p.get("h_pos") not in H_POS:
            issues.append(GeoIssue("proj.bad_hpos", f"{pid}: h_pos {p.get('h_pos')!r} invalid"))
        if p.get("v_pos") not in V_POS:
            issues.append(GeoIssue("proj.bad_vpos", f"{pid}: v_pos {p.get('v_pos')!r} invalid"))
        if p.get("size") not in SIZE_BINS:
            issues.append(GeoIssue("proj.bad_size", f"{pid}: size {p.get('size')!r} invalid"))
    return issues


def check_observer(obs: dict[str, Any], *, where: str = "observer") -> list[GeoIssue]:
    """Validate an ObserverPose."""
    issues: list[GeoIssue] = []
    if not _vec2_ok(obs.get("pos")):
        issues.append(GeoIssue("obs.bad_pos", f"{where}: pos must be finite {{x,y}}"))
    eh = _num(obs.get("eye_height"))
    if eh is None or eh <= 0:
        issues.append(GeoIssue("obs.bad_eye_height", f"{where}: eye_height must be finite and > 0"))
    fov = _num(obs.get("fov"))
    if fov is None or not (0.0 < fov <= _MAX_FOV):
        issues.append(GeoIssue("obs.bad_fov", f"{where}: fov must be in (0, π] radians"))
    if _num(obs.get("gaze")) is None:
        issues.append(GeoIssue("obs.bad_gaze", f"{where}: gaze must be finite"))
    if obs.get("pitch") is not None:
        pitch = _num(obs["pitch"])
        if pitch is None or not (-_HALF_PI <= pitch <= _HALF_PI):
            issues.append(GeoIssue("obs.bad_pitch", f"{where}: pitch must be in [-π/2, π/2] when set"))
    return issues


def check_map_crop(crop: dict[str, Any], *, where: str = "map_crop") -> list[GeoIssue]:
    """Validate a MapCrop window (finite, positive extent)."""
    issues: list[GeoIssue] = []
    for k in ("x", "y", "w", "h"):
        if _num(crop.get(k)) is None:
            issues.append(GeoIssue("crop.bad_number", f"{where}: {k} must be finite"))
    for k in ("w", "h"):
        v = _num(crop.get(k))
        if v is not None and v <= 0:
            issues.append(GeoIssue("crop.nonpositive", f"{where}: {k} must be > 0"))
    return issues


def check_scene_view(
    sv: dict[str, Any], *, valid_tiers: frozenset[str] | None = None
) -> list[GeoIssue]:
    """Validate a SceneView (level + optional observer / map_crop / scale_tier)."""
    issues: list[GeoIssue] = []
    if sv.get("level") not in VIEW_LEVELS:
        issues.append(GeoIssue("view.bad_level", f"level {sv.get('level')!r} invalid"))
    obs = sv.get("observer")
    if obs is not None:
        issues.extend(
            check_observer(obs)
            if isinstance(obs, dict)
            else [GeoIssue("view.bad_observer", "observer must be an object or null")]
        )
    crop = sv.get("map_crop")
    if crop is not None:
        issues.extend(
            check_map_crop(crop)
            if isinstance(crop, dict)
            else [GeoIssue("view.bad_map_crop", "map_crop must be an object or null")]
        )
    tier = sv.get("scale_tier")
    if tier is not None and valid_tiers is not None and tier not in valid_tiers:
        issues.append(GeoIssue("view.bad_tier", f"scale_tier {tier!r} invalid"))
    return issues
