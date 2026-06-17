"""Polygon segmentation + relative heights (B2 segmenter), pluggable backend.

Each label gets a BORDER polygon (normalized 0..1, 3..24 vertices) + a height
ranking, the shape detector.py emits one level richer. `segment()` routes on
SEGMENTER_PROVIDER:

  vlm (default)  — Gemini traces the borders and guesses built heights in ONE
                   call; cheap, but the polygons can be loose/hallucinated.
  sam3_fal       — fal-ai/sam-3 returns a pixel-accurate mask per label
                   (promptable-concept, one call each); the mask is traced to the
                   same polygon shape (polygon_from_mask). Tighter borders for
                   grounding/IoU; rel_height becomes a geometric proxy (mask bbox
                   height) and est_height_m is left to the VLM/authored path.

The return type (SegmentEntity) is identical across providers, so draft.py,
annotate.py and recon_bench are untouched — flip SEGMENTER_PROVIDER and the same
pipeline grounds on SAM3 instead. Tolerant parse throughout: a malformed entry is
dropped, never raises.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import math
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


def segmenter_provider() -> str:
    """Which segmenter backs segment(): "vlm" (Gemini polygon trace, default —
    nothing changes unless opted in) or "sam3_fal" (pixel-accurate masks from
    fal-ai/sam-3, traced to the same polygon shape). An unknown value falls back
    to "vlm" so a typo can never silently disable segmentation."""
    v = os.environ.get("SEGMENTER_PROVIDER", "vlm").strip().lower()
    return v if v in {"vlm", "sam3_fal"} else "vlm"


def _sam_model() -> str:
    return os.environ.get("FAL_SAM_MODEL", "fal-ai/sam-3/image")


def polygon_from_mask(
    mask_img: Any, n_vertices: int = 20, thresh: int = 127, max_dim: int = 256
) -> list[list[float]]:
    """Trace a binary mask's outline as a normalized polygon (0..1 image coords),
    pure PIL — no cv2/numpy. Radial method: from the foreground centroid, cast
    `n_vertices` rays and take the farthest foreground pixel along each. Exact for
    star-convex blobs (mountains, islands, buildings — the corpus's targets) and a
    graceful approximation otherwise; the SAM3 mask + box stay the source of truth
    for tight IoU. Returns [] for an empty mask. Output matches SegmentEntity's
    polygon: <=MAX_VERTICES vertices, clockwise-ish by ray order."""
    g = mask_img.convert("L")
    w0, h0 = g.size
    scale = min(1.0, max_dim / max(w0, h0)) if max(w0, h0) else 1.0
    if scale < 1.0:
        g = g.resize((max(1, int(w0 * scale)), max(1, int(h0 * scale))))
    w, h = g.size
    px = g.load()
    fg = [[bool(px[x, y] > thresh) for x in range(w)] for y in range(h)]
    pts = [(x, y) for y in range(h) for x in range(w) if fg[y][x]]
    if not pts:
        return []

    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    # if the centroid sits in a hole (crescent/donut), snap to the nearest fg pixel
    if not fg[min(h - 1, max(0, int(cy)))][min(w - 1, max(0, int(cx)))]:
        ox, oy = min(pts, key=lambda p: (p[0] - cx) ** 2 + (p[1] - cy) ** 2)
        cx, cy = float(ox), float(oy)

    max_r = math.hypot(w, h)
    verts: list[list[float]] = []
    for i in range(max(3, n_vertices)):
        ang = 2.0 * math.pi * i / max(3, n_vertices)
        dx, dy = math.cos(ang), math.sin(ang)
        last: tuple[int, int] | None = None
        r = 0.0
        while r <= max_r:
            x, y = round(cx + dx * r), round(cy + dy * r)
            if 0 <= x < w and 0 <= y < h and fg[y][x]:
                last = (x, y)
                r += 1.0
            else:
                break
        if last is not None:
            verts.append([round(last[0] / w, 4), round(last[1] / h, 4)])

    # drop consecutive duplicates + a closing vertex equal to the first
    out: list[list[float]] = []
    for v in verts:
        if not out or out[-1] != v:
            out.append(v)
    if len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out[:MAX_VERTICES] if len(out) >= MIN_VERTICES else []


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
    """Segment the given labels: one closed border polygon + height ranking per
    label actually present. Routes on SEGMENTER_PROVIDER (default "vlm"); the
    return shape is identical across providers so draft/annotate/recon are
    untouched."""
    if segmenter_provider() == "sam3_fal":
        return await _segment_sam3(image_bytes, labels)
    return await _segment_vlm(image_bytes, labels)


async def _segment_sam3(image_bytes: bytes, labels: list[str]) -> list[SegmentEntity]:
    """Pixel-accurate segmentation via fal-ai/sam-3 (one promptable-concept call
    per label). The SAM3 mask PNG is traced to the SegmentEntity polygon shape;
    rel_height is the mask's normalized bbox height ranked against the tallest
    label (a geometric proxy — SAM3 doesn't estimate built height, so
    est_height_m stays None and the VLM/authored path keeps that job). A label
    SAM3 can't find is omitted (no mask returned), same contract as the VLM path."""
    from PIL import Image

    from providers.image import _fal_subscribe, _fetch_url_bytes

    data_uri = f"data:image/jpeg;base64,{base64.b64encode(image_bytes).decode('ascii')}"
    model = _sam_model()

    async def one(label: str) -> tuple[SegmentEntity, float] | None:
        try:
            result = await _fal_subscribe(
                model,
                {
                    "image_url": data_uri,
                    "prompt": label,
                    "apply_mask": False,
                    "include_boxes": True,
                    "include_scores": True,
                    "max_masks": 1,
                },
            )
        except Exception:
            return None
        masks = result.get("masks") or []
        if not masks:
            return None  # SAM3 found no instance of this concept
        url = masks[0].get("url") if isinstance(masks[0], dict) else None
        if not url:
            return None
        try:
            mask_bytes, _ = await _fetch_url_bytes(url)
            polygon = polygon_from_mask(Image.open(io.BytesIO(mask_bytes)))
        except Exception:
            return None
        if len(polygon) < MIN_VERTICES:
            return None
        boxes = result.get("boxes") or []
        scores = result.get("scores") or []
        box_h = float(boxes[0][3]) if boxes and len(boxes[0]) >= 4 else 0.0
        score = _clamp01(scores[0]) if scores else 1.0
        seg: SegmentEntity = {
            "label": label,
            "polygon": polygon,
            "rel_height": 0.0,  # filled below, once we know the tallest
            "est_height_m": None,
            "score": score,
        }
        return seg, box_h

    results = [r for r in await asyncio.gather(*[one(label) for label in labels]) if r]
    if not results:
        return []
    tallest = max((box_h for _, box_h in results), default=0.0)
    out: list[SegmentEntity] = []
    for seg, box_h in results:
        seg["rel_height"] = _clamp01(box_h / tallest) if tallest > 0 else 0.0
        out.append(seg)
    return out


async def _segment_vlm(image_bytes: bytes, labels: list[str]) -> list[SegmentEntity]:
    """The VLM polygon tracer (Gemini): one call covers all labels; the VLM is
    told NOT to invent absent labels."""
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
