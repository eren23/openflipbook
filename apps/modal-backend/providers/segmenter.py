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
import hashlib
import io
import math
import os
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any, TypedDict

import httpx

if TYPE_CHECKING:
    from PIL import Image

    from .detector import Detection


class SegmentEntity(TypedDict):
    label: str
    polygon: list[list[float]]  # [[x, y], ...] normalized 0..1, 3..24 vertices
    rel_height: float  # 0..1 vs the tallest visible target
    est_height_m: float | None  # the VLM's raw absolute guess, meters
    score: float


MAX_VERTICES = 24
MIN_VERTICES = 3
_MAX_SAM3_LABELS = 12  # cap paid SAM3 jobs per scene (one fal call per label)
_SAM3_CONCURRENCY = 4  # in-flight SAM3 calls — bound provider rate-limit pressure


def _segmenter_model() -> str:
    return os.environ.get(
        "WORLD_BENCH_JUDGE_MODEL",
        os.environ.get("OPENROUTER_VLM_MODEL", "google/gemini-3.7-flash"),
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


# How much wider than the box to crop before segmenting. Room for overflow to
# be visible; tight enough that a neighbour does not win the crop.
CROP_PAD = 1.6

# Explicit experimental profile; the existing crop-and-text call stays unchanged.
SAM3_VISUAL_PROFILE = "sam3-visual-full-frame-v1"
SAM3_VISUAL_SIZE = (688, 384)
SAM3_VISUAL_IMAGE_MAX_BYTES = 4 * 1024 * 1024
SAM3_VISUAL_OBJECTS_MAX_BYTES = 2 * 1024 * 1024
SAM3_VISUAL_POINT_MARGIN = 8


class Sam3VisualPromptError(RuntimeError):
    """An acknowledged SAM request failed during free polling or mask retrieval."""

    def __init__(self, request_id: str, proof: dict[str, Any]) -> None:
        super().__init__("Acknowledged visual SAM request did not return a usable result")
        self.request_id = request_id
        self.proof = proof


def _visual_rgb(value: Sequence[int]) -> tuple[int, int, int]:
    if len(value) != 3 or any(type(channel) is not int or not 0 <= channel <= 255 for channel in value):
        raise ValueError("Visual prompts require byte RGB identifiers")
    rgb = (value[0], value[1], value[2])
    if rgb == (0, 0, 0):
        raise ValueError("Background is not an object identifier")
    return rgb


def _visual_interior(mask: Image.Image) -> Image.Image:
    from PIL import ImageFilter

    radius = SAM3_VISUAL_POINT_MARGIN
    interior = mask.filter(ImageFilter.MinFilter(2 * radius + 1))
    w, h = mask.size
    # Pillow extends edge pixels during filtering; frame edges are not safe interior.
    for border in ((0, 0, w, radius), (0, h - radius, w, h),
                   (0, 0, radius, h), (w - radius, 0, w, h)):
        interior.paste(0, border)
    return interior


def _visual_point(mask: Image.Image, y0: int, y1: int) -> tuple[int, int] | None:
    """Actual interior pixel nearest its region's centroid, with deterministic ties."""
    w, _ = mask.size
    values = mask.tobytes()
    points = [(x, y) for y in range(y0, y1) for x in range(w) if values[y * w + x]]
    if not points:
        return None
    count = len(points)
    sx, sy = sum(p[0] for p in points), sum(p[1] for p in points)
    return min(points, key=lambda p: ((p[0] * count - sx) ** 2 + (p[1] * count - sy) ** 2, p[1], p[0]))


def sam3_visual_prompts(
    objects_bytes: bytes, box: Sequence[int], subject_rgb: Sequence[int],
    other_building_rgbs: Sequence[Sequence[int]], road_rgb: Sequence[int],
) -> dict[str, Any]:
    """Derive visual prompts from the saved canonical pass, never from candidate pixels.

    This private profile requires three other building IDs and one known road ID.
    Occluded or thin objects contribute no negative point. Road points must also
    lie in the bottom fifth and outside every building mask. No returned SAM mask
    is intersected with these inputs: overflow must remain visible to the gate.
    """
    from PIL import Image

    if (len(box) != 4 or any(type(v) is not int for v in box)
            or not (0 <= box[0] < box[2] <= 688 and 0 <= box[1] < box[3] <= 384)):
        raise ValueError("Visual subject box must use exact registered pixel corners")
    if not 0 < len(objects_bytes) <= SAM3_VISUAL_OBJECTS_MAX_BYTES:
        raise ValueError("Visual objects pass exceeds its byte limit")
    subject, road = _visual_rgb(subject_rgb), _visual_rgb(road_rgb)
    if len(other_building_rgbs) != 3:
        raise ValueError("Visual profile requires all four building identifiers")
    others = [_visual_rgb(rgb) for rgb in other_building_rgbs]
    colors = [subject, *others, road]
    if len(set(colors)) != 5:
        raise ValueError("Visual object and road identifiers must be distinct")
    with Image.open(io.BytesIO(objects_bytes)) as image:
        if (image.format != "PNG" or image.size != SAM3_VISUAL_SIZE or image.mode not in {"RGB", "RGBA"}
                or getattr(image, "n_frames", 1) != 1 or image.getexif().get(274, 1) != 1):
            raise ValueError("Visual objects pass must be the upright registered PNG")
        image.load()
        if image.mode == "RGBA" and image.getchannel("A").getextrema() != (255, 255):
            raise ValueError("Visual objects pass must be opaque")
        pixels = image.convert("RGB").tobytes()
    masks = [Image.frombytes("L", SAM3_VISUAL_SIZE,
                            bytes(255 if tuple(pixels[n:n + 3]) == rgb else 0
                                  for n in range(0, len(pixels), 3))) for rgb in colors]
    if masks[0].getbbox() != tuple(box):
        raise ValueError("Visual subject box differs from the saved object mask")
    w, h = SAM3_VISUAL_SIZE
    interior = _visual_interior(masks[0])
    middle = (box[1] + box[3]) // 2
    regions = [_visual_point(interior, box[1], middle), _visual_point(interior, middle, box[3])]
    positives = [p for p in regions if p is not None]
    if not positives:
        raise ValueError("Visual subject has no safe interior point")
    point_prompts = [{"x": x, "y": y, "label": 1, "object_id": 1} for x, y in positives]
    for mask in masks[1:4]:
        point = _visual_point(_visual_interior(mask), 0, h)
        if point is not None:
            point_prompts.append({"x": point[0], "y": point[1], "label": 0, "object_id": 1})
    # A road RGB identifies the path, even when its nonzero ID fills the ground plane.
    # Explicitly exclude all four buildings before erosion; no sky/zero-RGB fallback.
    road_pixels = masks[4].tobytes()
    building_pixels = [mask.tobytes() for mask in masks[:4]]
    road_mask = Image.frombytes("L", (w, h), bytes(
        road_pixels[n] if not any(building[n] for building in building_pixels) else 0
        for n in range(w * h)))
    road_point = _visual_point(_visual_interior(road_mask), math.ceil(h * 0.8), h)
    if road_point is not None:
        point_prompts.append({"x": road_point[0], "y": road_point[1], "label": 0, "object_id": 1})
    return {
        "box_prompts": [{"x_min": box[0], "y_min": box[1], "x_max": box[2], "y_max": box[3], "object_id": 1}],
        "point_prompts": point_prompts,
        "proof": {"version": SAM3_VISUAL_PROFILE, "objects_sha256": hashlib.sha256(objects_bytes).hexdigest(),
                  "width": w, "height": h, "subject_rgb": subject, "other_building_rgbs": others,
                  "road_rgb": road, "point_margin": SAM3_VISUAL_POINT_MARGIN},
    }


async def sam3_visual_full_frame_mask(
    image_bytes: bytes, objects_bytes: bytes, box: Sequence[int], subject_rgb: Sequence[int],
    other_building_rgbs: Sequence[Sequence[int]], road_rgb: Sequence[int],
) -> dict[str, Any]:
    """One nonretrying paid visual request, preserving the exact full-frame JPEG.

    Fal's documented box/point object IDs refine the same object. Empty prompt
    explicitly disables the default text prompt. This does not promise detection;
    no detection is null, and a failed acknowledged request retains its queue ID.
    """
    import fal_client
    from PIL import Image

    from providers.image import _fetch_url_bytes

    if _sam_model() != "fal-ai/sam-3/image":
        raise ValueError("Visual profile is pinned to fal-ai/sam-3/image")
    if not 0 < len(image_bytes) <= SAM3_VISUAL_IMAGE_MAX_BYTES:
        raise ValueError("Visual candidate exceeds its JPEG byte limit")
    with Image.open(io.BytesIO(image_bytes)) as image:
        if (image.format != "JPEG" or image.size != SAM3_VISUAL_SIZE or getattr(image, "n_frames", 1) != 1
                or image.getexif().get(274, 1) != 1):
            raise ValueError("Visual candidate must be the exact upright registered JPEG")
        image.verify()
    prompts = sam3_visual_prompts(objects_bytes, box, subject_rgb, other_building_rgbs, road_rgb)
    proof = {**prompts["proof"], "image_sha256": hashlib.sha256(image_bytes).hexdigest(),
             "box_prompts": prompts["box_prompts"], "point_prompts": prompts["point_prompts"]}
    async with httpx.AsyncClient(timeout=60, follow_redirects=False,
                                 transport=httpx.AsyncHTTPTransport(retries=0)) as client:
        response = await client.post(
            "https://queue.fal.run/fal-ai/sam-3/image",
            headers={"Authorization": f"Key {os.environ['FAL_KEY']}", "X-Fal-No-Retry": "1"},
            json={"image_url": "data:image/jpeg;base64," + base64.b64encode(image_bytes).decode(),
                  "prompt": "", "box_prompts": prompts["box_prompts"], "point_prompts": prompts["point_prompts"],
                  "apply_mask": False, "include_scores": True, "include_boxes": True,
                  "return_multiple_masks": False, "max_masks": 1, "output_format": "png"},
        )
        response.raise_for_status()
    request_id = str(response.json()["request_id"])
    try:
        result = await fal_client.result_async("fal-ai/sam-3/image", request_id)
        scores = result.get("scores") or []
        out: dict[str, Any] = {"mask": None, "request_id": request_id,
                               "score": float(scores[0]) if scores else None, "visual_prompt_proof": proof}
        masks = result.get("masks") or []
        url = masks[0].get("url") if masks and isinstance(masks[0], dict) else None
        if url:
            data, _ = await _fetch_url_bytes(url)
            if not 0 < len(data) <= SAM3_VISUAL_IMAGE_MAX_BYTES:
                raise ValueError("Visual output mask exceeds its byte limit")
            with Image.open(io.BytesIO(data)) as image:
                if (image.width * image.height > 4 * 1024 * 1024 or getattr(image, "n_frames", 1) != 1
                        or image.getexif().get(274, 1) != 1):
                    raise ValueError("Invalid visual output mask")
                full = image.convert("L").resize(SAM3_VISUAL_SIZE, Image.Resampling.NEAREST)
            mask = full.convert("1", dither=Image.Dither.NONE)
            out["mask"] = mask if mask.getbbox() else None
        return out
    except (Exception, asyncio.CancelledError) as error:
        # Also preserve the known ID if the enclosing gate deadline cancels polling.
        raise Sam3VisualPromptError(request_id, proof) from error


def box_crop(box: Sequence[float], w: int, h: int, pad: float = CROP_PAD) -> tuple[int, int, int, int]:
    """The pixel box [x0, y0, x1, y1] grown `pad` times around its centre and
    clamped to the frame: the region SAM-3 actually sees."""
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hw, hh = (x1 - x0) * pad / 2, (y1 - y0) * pad / 2
    return (max(0, round(cx - hw)), max(0, round(cy - hh)), min(w, round(cx + hw)), min(h, round(cy + hh)))


async def sam3_box_mask(
    image_bytes: bytes, box: Sequence[float], label: str, size: tuple[int, int] | None = None
) -> dict[str, Any]:
    """SAM-3 mask of `label` inside the pixel `box`, in full-frame pixels.

    An earlier text-plus-box probe returned an unrelated barrel at 0.94
    confidence. This compatibility profile therefore scopes the text call by
    CROPPING, at CROP_PAD. The separate visual profile uses the currently
    documented box and point fields. `size` resizes into saved-view pixels.

    Paid: one queue POST without retries; only the free polling may retry.
    Returns {"mask": a 1-bit frame-size image, or None when nothing was found,
    "request_id", "score", "crop": the (x0, y0, x1, y1) that was sent}."""
    import fal_client
    from PIL import Image

    from providers.image import _fetch_url_bytes

    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    if size is not None and img.size != size:
        img = img.resize(size)
    w, h = img.size
    crop = box_crop(box, w, h)
    buf = io.BytesIO()
    img.crop(crop).save(buf, "JPEG", quality=92)
    model = _sam_model()
    async with httpx.AsyncClient(timeout=60, follow_redirects=False,
                                 transport=httpx.AsyncHTTPTransport(retries=0)) as client:
        response = await client.post(
            f"https://queue.fal.run/{model}",
            headers={"Authorization": f"Key {os.environ['FAL_KEY']}", "X-Fal-No-Retry": "1"},
            json={"image_url": "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode(),
                  "prompt": label, "apply_mask": False, "include_scores": True, "max_masks": 1},
        )
        response.raise_for_status()
    request_id = str(response.json()["request_id"])
    result = await fal_client.result_async(model, request_id)
    scores = result.get("scores") or []
    out: dict[str, Any] = {"mask": None, "request_id": request_id,
                           "score": float(scores[0]) if scores else None, "crop": crop}
    masks = result.get("masks") or []
    url = masks[0].get("url") if masks and isinstance(masks[0], dict) else None
    if url:
        data, _ = await _fetch_url_bytes(url)
        x0, y0, x1, y1 = crop
        full = Image.new("L", (w, h), 0)
        full.paste(Image.open(io.BytesIO(data)).convert("L").resize((x1 - x0, y1 - y0), Image.Resampling.NEAREST), (x0, y0))
        mask = full.convert("1", dither=Image.Dither.NONE)  # >= 128 is the building
        out["mask"] = mask if mask.getbbox() else None
    return out


def detector_box_to_sam_box(det: Detection, img_w: int, img_h: int) -> dict[str, int]:
    """Convert a detector box (centre-based, normalized 0..1: x_pct, y_pct,
    w_pct, h_pct) into a SAM3 box_prompt (pixel corners {x_min,y_min,x_max,
    y_max}, clamped to the image). SAM3 can't ground a proper-noun label like
    "Spyglass Hill" from text, but the VLM detector localizes it — so we hand
    SAM3 the box and let it refine the pixel mask."""
    x, y = float(det.get("x_pct", 0.5)), float(det.get("y_pct", 0.5))
    w, h = float(det.get("w_pct", 0.0)), float(det.get("h_pct", 0.0))
    x_min = min(max(0, round((x - w / 2) * img_w)), img_w)
    y_min = min(max(0, round((y - h / 2) * img_h)), img_h)
    x_max = min(max(0, round((x + w / 2) * img_w)), img_w)
    y_max = min(max(0, round((y + h / 2) * img_h)), img_h)
    return {"x_min": x_min, "y_min": y_min, "x_max": x_max, "y_max": y_max}


def box_from_polygon(polygon: list[list[float]]) -> dict[str, float]:
    """A polygon's centre-based bounding box {x_pct,y_pct,w_pct,h_pct} (the
    Detection shape) — the mask's tight extent."""
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    x1, x2, y1, y2 = min(xs), max(xs), min(ys), max(ys)
    return {
        "x_pct": (x1 + x2) / 2.0,
        "y_pct": (y1 + y2) / 2.0,
        "w_pct": x2 - x1,
        "h_pct": y2 - y1,
    }


def refine_detections_with_masks(
    detections: list[Detection], segments: list[SegmentEntity]
) -> list[Detection]:
    """Tighten each detector box to its SAM3 mask's bounding box (label-matched,
    case-insensitive), keeping the detection's label + score. A detection with no
    matching mask is passed through unchanged — so this only ever sharpens the
    grounding loop's observed boxes, never drops one."""
    seg_by = {str(s.get("label", "")).lower(): s for s in segments}
    out: list[Detection] = []
    for d in detections:
        seg = seg_by.get(str(d.get("label", "")).lower())
        poly = seg.get("polygon") if seg else None
        if poly and len(poly) >= MIN_VERTICES:
            box = box_from_polygon(poly)
            out.append(
                {
                    "label": d.get("label", ""),
                    "score": d.get("score", 1.0),
                    "x_pct": box["x_pct"],
                    "y_pct": box["y_pct"],
                    "w_pct": box["w_pct"],
                    "h_pct": box["h_pct"],
                }
            )
        else:
            out.append(d)
    return out


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


async def segment(
    image_bytes: bytes,
    labels: list[str],
    boxes: list[Detection] | None = None,
) -> list[SegmentEntity]:
    """Segment the given labels: one closed border polygon + height ranking per
    label actually present. Routes on SEGMENTER_PROVIDER (default "vlm"); the
    return shape is identical across providers so draft/annotate/recon are
    untouched. `boxes` (the detector's output for these labels) is used only by
    the SAM3 path — proper-noun labels don't ground from text, so the detector's
    box localizes the concept and SAM3 refines the mask; the VLM path ignores it."""
    from . import mock

    # Mock stacks always take the VLM arm (it rides the mocked llm client) —
    # SAM3 is one paid fal call PER LABEL, the priciest way to rediscover #184.
    if segmenter_provider() == "sam3_fal" and not mock.on():
        return await _segment_sam3(image_bytes, labels, boxes)
    return await _segment_vlm(image_bytes, labels)


async def _segment_sam3(
    image_bytes: bytes,
    labels: list[str],
    boxes: list[Detection] | None,
) -> list[SegmentEntity]:
    """Pixel-accurate segmentation via fal-ai/sam-3, one call per label. Each
    label is BOX-PROMPTED with its detector box (proper-noun text prompts return
    nothing; a box scores reliably), falling back to a text prompt when no box is
    available. The SAM3 mask PNG is traced to the SegmentEntity polygon shape;
    rel_height is the mask's normalized bbox height ranked against the tallest
    label (a geometric proxy — SAM3 doesn't estimate built height, so
    est_height_m stays None and the VLM/authored path keeps that job). A label
    SAM3 can't ground is omitted, same contract as the VLM path."""
    from PIL import Image

    from providers.image import _fal_subscribe, _fetch_url_bytes

    data_uri = f"data:image/jpeg;base64,{base64.b64encode(image_bytes).decode('ascii')}"
    model = _sam_model()
    img_w, img_h = Image.open(io.BytesIO(image_bytes)).size
    box_by = {str(b.get("label", "")).lower(): b for b in (boxes or [])}

    async def one(label: str) -> tuple[SegmentEntity, float] | None:
        arguments: dict[str, Any] = {
            "image_url": data_uri,
            "prompt": label,
            "apply_mask": False,
            "include_boxes": True,
            "include_scores": True,
            "max_masks": 1,
        }
        det = box_by.get(label.lower())
        if det is not None:
            arguments["box_prompts"] = [detector_box_to_sam_box(det, img_w, img_h)]
        try:
            result = await _fal_subscribe(model, arguments)
        except Exception as exc:
            from obs import log

            log(
                "warn",
                "segmenter.sam3.label_failed",
                label=label,
                error=f"{type(exc).__name__}: {exc}",
            )
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
        except Exception as exc:
            from obs import log

            log(
                "warn",
                "segmenter.sam3.label_failed",
                label=label,
                error=f"{type(exc).__name__}: {exc}",
            )
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

    # Bound the fan-out: a busy scene can emit many labels, and one paid fal SAM3
    # job per label (unbounded) is both a cost and a provider rate-limit hazard.
    # Cap the label count and the in-flight concurrency.
    capped = labels[:_MAX_SAM3_LABELS]
    if len(labels) > len(capped):
        from obs import log

        log("warn", "segmenter.sam3.labels_capped", total=len(labels), kept=len(capped))
    sem = asyncio.Semaphore(_SAM3_CONCURRENCY)

    async def _bounded(label: str) -> tuple[SegmentEntity, float] | None:
        async with sem:
            return await one(label)

    results = [r for r in await asyncio.gather(*[_bounded(label) for label in capped]) if r]
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
    # Via _create_with_retry so a transient 429/5xx retries instead of dropping
    # this label silently (the client now disables the SDK's own retries).
    # Polygon replies are the biggest in the repo (up to 12 labels x 16-vertex
    # point arrays, pretty-printed) — 1400 tokens truncated real replies and
    # the old bare `except: return []` hid it completely.
    resp = await llm._create_with_retry(
        client,
        model=model,
        messages=messages,
        temperature=0.0,
        max_tokens=4000,
        **llm._maybe_response_format(model),
    )
    raw = resp.choices[0].message.content or "{}"
    payload, failure = llm.salvage_json(raw)
    if failure is not None:
        from obs import log

        log(
            "warn",
            "segmenter.parse_failed",
            finish_reason=getattr(resp.choices[0], "finish_reason", None),
            labels=len(labels),
            failure=failure,
        )
    return parse_segments(payload)
