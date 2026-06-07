"""Pure 2.5D projection: (world map + observer pose) -> per-frame entity layout.

A flat-ground bearing/size approximation, NOT a full 3D camera. Output is coarse
*bins* (h_pos/v_pos/size) plus 0..1 normalized rects — what prompts and the VLM
judge consume (honest: bins, not pixels). Models the vertical axis via entity
`height` + base `elevation` and observer `eye_height` + `pitch` (look up/down).
LIMITS: still a flat-ground pinhole — no terrain mesh, no camera roll, no
interiors / occlusion-by-walls.

Kept line-for-line identical to the TS port apps/web/lib/world-geometry.ts; the
P1 parity gate (a shared golden fixture both must reproduce) guards drift.

World coords: origin top-left, +x east, +y south. Observer gaze is a heading in
radians (0 = +x / east); fov is the horizontal field of view in radians.
"""
from __future__ import annotations

import math
from typing import Any

_TWO_PI = 2.0 * math.pi
_HALF_PI = math.pi / 2.0


def _norm_angle(a: float) -> float:
    while a > math.pi:
        a -= _TWO_PI
    while a < -math.pi:
        a += _TWO_PI
    return a


def _h_pos(x: float) -> str:
    if x < 0.2:
        return "far-left"
    if x < 0.4:
        return "left"
    if x < 0.6:
        return "center"
    if x < 0.8:
        return "right"
    return "far-right"


def _v_pos(y: float) -> str:
    if y < 0.4:
        return "top"
    if y < 0.66:
        return "mid"
    return "bottom"


def _size_bin(s: float) -> str:
    if s < 0.08:
        return "tiny"
    if s < 0.18:
        return "small"
    if s < 0.35:
        return "medium"
    if s < 0.6:
        return "large"
    return "huge"


def project(
    entity: dict[str, Any], observer: dict[str, Any], aspect: float
) -> dict[str, Any] | None:
    """Project one entity into the observer's frame, or None if not visible."""
    if aspect <= 0:
        return None  # degenerate frame — no vertical frustum
    ex, ey = entity["pos"]["x"], entity["pos"]["y"]
    ox, oy = observer["pos"]["x"], observer["pos"]["y"]
    dx, dy = ex - ox, ey - oy
    dist = math.hypot(dx, dy)
    if dist < 1e-6:
        return None  # degenerate: entity sits on the observer
    half_fov = observer["fov"] / 2.0
    rel = _norm_angle(math.atan2(dy, dx) - observer["gaze"])
    if abs(rel) >= half_fov:
        return None  # outside the horizontal field of view
    t_half = math.tan(half_fov)
    x_pct = 0.5 + math.tan(rel) / (2.0 * t_half)
    # Vertical FOV from the aspect ratio (width / height).
    half_vfov = math.atan(t_half / aspect)
    tv = math.tan(half_vfov)
    eye = observer["eye_height"]
    pitch = observer.get("pitch", 0.0)
    elev = entity.get("elevation", 0.0)
    # Angle (relative to the camera's optical axis) to the entity's base + top:
    # base at world-z = elev, top at elev + height; the camera is tilted by pitch.
    th_base = math.atan((elev - eye) / dist) - pitch
    th_top = math.atan((elev + entity["height"] - eye) / dist) - pitch
    # Vertical frustum: past ±pi/2 the point is behind the image plane (only
    # reachable under pitch / extreme elevation) — cull, mirroring the h-FOV cull.
    if th_top >= _HALF_PI or th_base <= -_HALF_PI:
        return None
    y_base = 0.5 - math.tan(th_base) / (2.0 * tv)
    y_top = 0.5 - math.tan(th_top) / (2.0 * tv)
    # Vertical-FOV cull: an entity entirely above or below the frame isn't visible.
    # (The old code let y_pct/h_pct run unbounded, so off-image boxes leaked into
    # the golden + the grounding diff — codex-audit #4.)
    if max(y_top, y_base) < 0.0 or min(y_top, y_base) > 1.0:
        return None
    y_pct = (y_top + y_base) / 2.0
    h_pct = abs(y_base - y_top)
    w_pct = (entity["footprint"]["w"] / dist) / (2.0 * t_half)
    return {
        "id": entity["id"],
        "label": entity.get("label", ""),
        "x_pct": x_pct,
        "y_pct": y_pct,
        "w_pct": w_pct,
        "h_pct": h_pct,
        "depth": dist,
        "h_pos": _h_pos(x_pct),
        "v_pos": _v_pos(y_pct),
        "size": _size_bin(max(w_pct, h_pct)),
    }


def project_scene(
    entities: list[dict[str, Any]], observer: dict[str, Any], aspect: float
) -> list[dict[str, Any]]:
    """Project all in-frame entities, nearest first (reverse for painter's draw)."""
    out = [p for e in entities if (p := project(e, observer, aspect)) is not None]
    out.sort(key=lambda p: (p["depth"], p["id"]))
    return out


def crop_entities(
    entities: list[dict[str, Any]], crop: dict[str, float]
) -> list[dict[str, Any]]:
    """Entities whose map position falls inside a world-coord window (sub-map)."""
    x0, y0 = crop["x"], crop["y"]
    x1, y1 = x0 + crop["w"], y0 + crop["h"]
    return [
        e
        for e in entities
        if x0 <= e["pos"]["x"] <= x1 and y0 <= e["pos"]["y"] <= y1
    ]


def neighbors_of(
    entities: list[dict[str, Any]], entity_id: str, k: int
) -> list[dict[str, Any]]:
    """The k nearest entities to `entity_id`, with bearing + distance (anchors)."""
    src = next((e for e in entities if e["id"] == entity_id), None)
    if src is None:
        return []
    sx, sy = src["pos"]["x"], src["pos"]["y"]
    others = []
    for e in entities:
        if e["id"] == entity_id:
            continue
        dx, dy = e["pos"]["x"] - sx, e["pos"]["y"] - sy
        others.append(
            {
                "id": e["id"],
                "bearing": math.atan2(dy, dx),
                "dist": math.hypot(dx, dy),
            }
        )
    others.sort(key=lambda o: (o["dist"], o["id"]))
    return others[:k]
