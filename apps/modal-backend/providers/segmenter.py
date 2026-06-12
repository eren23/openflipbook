"""VLM polygon segmentation + relative heights (B2 segmenter).

Same shape as detector.py, one level richer: instead of a box per label, the
VLM traces each visible target's BORDER as a closed polygon and ranks its
apparent built height. Polygons are normalized 0..1 image coords, 3..24
vertices; rel_height is 0..1 of the tallest visible target; est_height_m is
the VLM's own absolute guess (anchoring happens in providers/heights.py, not
here). Tolerant parse: a malformed entry is dropped, never raises.
"""
from __future__ import annotations

import base64
import json
import os
from typing import Any, TypedDict


class SegmentEntity(TypedDict):
    label: str
    polygon: list[list[float]]  # [[x, y], ...] normalized 0..1, 3..24 vertices
    rel_height: float  # 0..1 vs the tallest visible target
    est_height_m: float | None  # the VLM's raw absolute guess, meters
    score: float


MAX_VERTICES = 24
MIN_VERTICES = 3


def _segmenter_model() -> str:
    return os.environ.get(
        "WORLD_BENCH_JUDGE_MODEL",
        os.environ.get("OPENROUTER_VLM_MODEL", "google/gemini-3-flash-preview"),
    )


def _clamp01(v: Any) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, f))


def _parse_vertices(raw: Any) -> list[list[float]]:
    """Coerce a polygon reply into clamped [[x, y], ...]: accepts [x,y] pairs
    or {x,y} dicts, drops malformed vertices and consecutive duplicates
    (including a closing vertex equal to the first)."""
    if not isinstance(raw, list):
        return []
    verts: list[list[float]] = []
    for v in raw:
        if isinstance(v, (list, tuple)) and len(v) >= 2:
            vert = [_clamp01(v[0]), _clamp01(v[1])]
        elif isinstance(v, dict) and "x" in v and "y" in v:
            vert = [_clamp01(v["x"]), _clamp01(v["y"])]
        else:
            continue
        if verts and vert == verts[-1]:
            continue
        verts.append(vert)
    if len(verts) > 1 and verts[0] == verts[-1]:
        verts.pop()
    return verts[:MAX_VERTICES]


def parse_segments(payload: Any) -> list[SegmentEntity]:
    """Coerce a VLM segmentation reply. Tolerant: entries with a blank label
    or a degenerate polygon (<3 usable vertices) are dropped (never raises)."""
    if isinstance(payload, dict):
        payload = payload.get("segments") or payload.get("entities") or []
    if not isinstance(payload, list):
        return []
    out: list[SegmentEntity] = []
    for s in payload:
        if not isinstance(s, dict):
            continue
        label = str(s.get("label", "")).strip()
        if not label:
            continue
        polygon = _parse_vertices(s.get("polygon") or s.get("border"))
        if len(polygon) < MIN_VERTICES:
            continue
        est_raw = s.get("est_height_m")
        try:
            est = float(est_raw) if est_raw is not None else None
        except (TypeError, ValueError):
            est = None
        if est is not None and est <= 0:
            est = None
        out.append(
            {
                "label": label,
                "polygon": polygon,
                "rel_height": _clamp01(s.get("rel_height", 0.0)),
                "est_height_m": est,
                "score": _clamp01(s.get("score", 1.0)),
            }
        )
    return out


async def segment(image_bytes: bytes, labels: list[str]) -> list[SegmentEntity]:
    """Segment the given labels in the image: one closed border polygon +
    height ranking per label actually present (the VLM is told NOT to invent
    absent labels). One call covers all labels."""
    from providers import llm

    b64 = base64.b64encode(image_bytes).decode("ascii")
    system = (
        "You segment buildings and landmarks in illustrated maps and scenes. "
        "For EACH target label actually visible, trace its outer border as ONE "
        "closed polygon of 6-16 vertices (normalized 0..1 image coordinates, "
        "clockwise), judge rel_height = its apparent BUILT height relative to "
        "the tallest visible target (the tallest gets 1.0), and est_height_m = "
        "your best absolute height guess in meters from the entity's category "
        "and the image's scale cues. OMIT labels that are absent; do NOT "
        "invent them. Return JSON exactly: "
        '{"segments":[{"label":..,"polygon":[[x,y],..],"rel_height":..,'
        '"est_height_m":..,"score":..}]}.'
    )
    user = "Target labels: " + ", ".join(labels) + ". Segment them in the image."
    model = _segmenter_model()
    client = llm._client()
    messages: list[Any] = [
        {"role": "system", "content": system},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/jpeg;base64,{b64}",
                        "detail": "low",
                    },
                },
            ],
        },
    ]
    resp = await client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=0.0,
        max_tokens=1400,
        **llm._maybe_response_format(model),
    )
    raw = resp.choices[0].message.content or "{}"
    try:
        payload = json.loads(raw[raw.find("{") : raw.rfind("}") + 1])
    except Exception:
        return []
    return parse_segments(payload)
