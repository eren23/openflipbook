"""Render an annotation back onto its source map — the visual in->out check.

Given a corpus description (verified or a candidate from annotate.py) and the
map image it was made from, draw each entity's detector box, segmenter border
and centroid + label onto the image, so a reviewer can SEE what the pipeline
extracted (and where the VLM segmenter's borders go wrong — the M2/SAM3 case).

    .venv/bin/python -m tests.map_corpus.overlay <map-id>              # verified
    .venv/bin/python -m tests.map_corpus.overlay <map-id> --candidate  # candidate
or: make corpus-overlay id=<map-id>

Writes tests/map_corpus/overlays/<id>.<source>.png (free, no API calls).
"""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path
from typing import Any

from tests.map_corpus import DESCRIPTIONS, ROOT, image_path

OVERLAYS = ROOT / "overlays"


def frame_to_px(
    x: float, y: float, frame_w: float, frame_h: float, img_w: int, img_h: int
) -> tuple[int, int]:
    """Map a point in the corpus frame (0..frame_w, 0..frame_h; origin top-left)
    to image pixels (rounded). This is the transform the whole overlay rides on."""
    return (round(x / frame_w * img_w), round(y / frame_h * img_h))


def render_overlay(image_bytes: bytes, desc: dict[str, Any]) -> bytes:
    """Draw the description's entities over the image; return PNG bytes."""
    from PIL import Image, ImageColor, ImageDraw, ImageFont

    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    w, h = img.size
    fw = float(desc.get("frame", {}).get("w", 100.0))
    fh = float(desc.get("frame", {}).get("h", 60.0))
    draw = ImageDraw.Draw(img, "RGBA")
    try:
        font = ImageFont.load_default(size=max(13, w // 60))
    except TypeError:  # very old Pillow without the size kwarg
        font = ImageFont.load_default()

    box_c = ImageColor.getrgb("#00e5ff")  # detector footprint
    border_c = ImageColor.getrgb("#ffd400")  # segmenter polygon
    dot_c = ImageColor.getrgb("#ff2d55")  # centroid

    for e in desc.get("entities", []):
        pos = e["pos"]
        fp = e.get("footprint", {"w": 2.0, "d": 2.0})
        cx, cy = frame_to_px(pos["x"], pos["y"], fw, fh, w, h)
        # detector footprint box (pos is the centre)
        x0, y0 = frame_to_px(pos["x"] - fp["w"] / 2, pos["y"] - fp["d"] / 2, fw, fh, w, h)
        x1, y1 = frame_to_px(pos["x"] + fp["w"] / 2, pos["y"] + fp["d"] / 2, fw, fh, w, h)
        draw.rectangle([x0, y0, x1, y1], outline=(*box_c, 230), width=2)
        # segmenter border polygon (this is where loose VLM traces show up)
        border = e.get("border")
        if border and len(border) >= 3:
            pts = [frame_to_px(vx, vy, fw, fh, w, h) for vx, vy in border]
            draw.line([*pts, pts[0]], fill=(*border_c, 230), width=2)
        # centroid + label
        draw.ellipse([cx - 4, cy - 4, cx + 4, cy + 4], fill=(*dot_c, 255))
        label = str(e.get("label", ""))
        tb = draw.textbbox((0, 0), label, font=font)
        tw, th = tb[2] - tb[0], tb[3] - tb[1]
        ly = max(0, cy - th - 6)
        draw.rectangle([cx + 6, ly, cx + 10 + tw, ly + th + 4], fill=(0, 0, 0, 170))
        draw.text((cx + 8, ly + 2), label, fill=(255, 255, 255, 255), font=font)

    # header strip: source + entity count + verdict
    status = desc.get("review", {}).get("status", "?")
    ann = desc.get("annotation", {})
    head = (
        f"{desc.get('map_id', '')}  |  {len(desc.get('entities', []))} entities  |  "
        f"status={status}"
        + (
            f"  |  judge={ann.get('judge_score')} agree={ann.get('agreement')}"
            f" contrib={ann.get('contributors')}"
            if ann
            else ""
        )
    )
    draw.rectangle([0, 0, w, 22], fill=(0, 0, 0, 180))
    draw.text((6, 4), head, fill=(255, 255, 255, 255), font=font)

    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


def _load_desc(map_id: str, candidate: bool) -> tuple[dict[str, Any], str]:
    path = (
        DESCRIPTIONS / "candidates" / f"{map_id}.json"
        if candidate
        else DESCRIPTIONS / f"{map_id}.json"
    )
    if not path.exists():
        raise SystemExit(f"{path} not found")
    return json.loads(path.read_text()), ("candidate" if candidate else "verified")


def overlay_one(map_id: str, candidate: bool = False) -> Path:
    desc, source = _load_desc(map_id, candidate)
    img = image_path(map_id)
    if not img.exists():
        raise SystemExit(f"{img} missing — run `make corpus-fetch` first")
    png = render_overlay(img.read_bytes(), desc)
    OVERLAYS.mkdir(parents=True, exist_ok=True)
    out = OVERLAYS / f"{map_id}.{source}.png"
    out.write_bytes(png)
    print(f"  wrote {out.relative_to(ROOT.parent.parent)} ({len(desc.get('entities', []))} entities)")
    return out


def main() -> int:
    args = [a for a in sys.argv[1:] if a]
    candidate = "--candidate" in args
    ids = [a for a in args if not a.startswith("--")]
    if not ids:
        print("usage: python -m tests.map_corpus.overlay <map-id> [--candidate]")
        return 1
    for map_id in ids:
        overlay_one(map_id, candidate=candidate)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
