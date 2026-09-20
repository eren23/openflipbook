"""Does the painted building stand where the map says it does?

    cd apps/modal-backend && SILHOUETTE_BENCH_RUN=1 \
      .venv/bin/python -m tests.world_bench.silhouette_runner <masks-dir> <frames-dir>
or: make eval-silhouette

The truth is not a judge's opinion: `renderLayoutControl` knows exactly which
pixels belong to which place, because the footprint is stored data. This asks a
segmenter what is actually painted in that same spot and compares the two.

Two things learned building it, both encoded below:

- **fal-ai/sam-3 ignores `box_prompts` on the image endpoint.** Asked for a
  building on the right of the frame, it returned a barrel on the far left
  (centre off by 0.78 of the frame) with 0.94 confidence. Scoping is done by
  CROPPING to the stored box instead, at 1.6x so a building painted wider than
  its plot has room to show the overflow rather than being clipped flush.
- **A box is a proxy, not a building.** A pitched roof rising above a flat box
  top lowers whole-silhouette IoU honestly. `width_ratio` and `centre_dx` are
  the verdict; `iou` is context. Read them together.

PAID: one SAM-3 call per (camera, building). Self-skips unless
SILHOUETTE_BENCH_RUN=1, the same discipline as every other paid runner here.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any

_REPORTS = Path(__file__).resolve().parent / "reports"
# How much wider than the stored box to crop before segmenting. Room for
# overflow to be visible; tight enough that a neighbour does not win the crop.
CROP_PAD = 1.6


def _load_env() -> None:
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def mask_stats(mask: bytes, w: int, h: int) -> dict[str, float] | None:
    """Extent and centroid of a 0/1 mask, in frame fractions. None when empty:
    an empty mask has no centre, and saying zero would read as a score."""
    n = sx = sy = 0
    x0, x1, y0, y1 = w, -1, h, -1
    for j in range(h):
        base = j * w
        for i in range(w):
            if not mask[base + i]:
                continue
            n += 1
            sx += i
            sy += j
            x0, x1 = min(x0, i), max(x1, i)
            y0, y1 = min(y0, j), max(y1, j)
    if n == 0:
        return None
    return {"pixels": n, "cx": sx / n / w, "cy": sy / n / h,
            "width": (x1 - x0 + 1) / w, "height": (y1 - y0 + 1) / h, "area": n / (w * h)}


async def measure_one(masks_dir: Path, painted: Path, camera: int, label: str) -> dict[str, Any]:
    """One (camera, building): the stored silhouette vs what is painted there."""
    import fal_client
    from PIL import Image

    from providers.image import _fetch_url_bytes

    plan = json.loads((masks_dir / "masks.json").read_text())
    shot = next(s for s in plan if s["camera"] == camera)
    w, h = shot["width"], shot["height"]
    row = next((r for r in shot["visible"] if r["label"] == label), None)
    if row is None:
        return {"camera": camera, "label": label, "error": "not visible from this camera"}
    truth = (masks_dir / f"cam{camera}_{row['k']}.mask").read_bytes()
    ts = mask_stats(truth, w, h)
    if ts is None:
        return {"camera": camera, "label": label, "error": "stored silhouette is empty"}

    img = Image.open(painted).convert("RGB").resize((w, h))
    cw, ch = ts["width"] * CROP_PAD, ts["height"] * CROP_PAD
    cx0 = max(0, round((ts["cx"] - cw / 2) * w))
    cx1 = min(w, round((ts["cx"] + cw / 2) * w))
    cy0 = max(0, round((ts["cy"] - ch / 2) * h))
    cy1 = min(h, round((ts["cy"] + ch / 2) * h))
    buf = io.BytesIO()
    img.crop((cx0, cy0, cx1, cy1)).save(buf, "JPEG", quality=92)
    uri = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

    handle = await fal_client.submit_async("fal-ai/sam-3/image", arguments={
        "image_url": uri, "prompt": "building", "apply_mask": False,
        "include_scores": True, "max_masks": 1,
    })
    result = await handle.get()
    masks = result.get("masks") or []
    if not masks:
        return {"camera": camera, "label": label, "request_id": handle.request_id,
                "error": "segmenter found nothing in the crop"}
    data, _ = await _fetch_url_bytes(masks[0]["url"])
    crop_mask = Image.open(io.BytesIO(data)).convert("L").resize((cx1 - cx0, cy1 - cy0), Image.NEAREST)
    full = Image.new("L", (w, h), 0)
    full.paste(crop_mask, (cx0, cy0))  # back into full-frame coordinates
    pred = bytes(1 if p >= 128 else 0 for p in full.tobytes())
    ps = mask_stats(pred, w, h)
    if ps is None:
        return {"camera": camera, "label": label, "error": "segmenter mask is empty"}

    inter = union = 0
    for a, b in zip(truth, pred, strict=True):  # a length mismatch is a bug, not a shorter loop
        if a and b:
            inter += 1
        if a or b:
            union += 1
    return {
        "camera": camera, "label": label, "request_id": handle.request_id,
        "segmenter_score": round(float((result.get("scores") or [0])[0]), 3),
        "iou": round(inter / union, 3) if union else 0.0,
        "width_ratio": round(ps["width"] / ts["width"], 3),
        "centre_dx": round(ps["cx"] - ts["cx"], 3),
        "centre_dy": round(ps["cy"] - ts["cy"], 3),
        "area_ratio": round(ps["area"] / ts["area"], 3),
        "truth_width": round(ts["width"], 3), "pred_width": round(ps["width"], 3),
        # A painting that fills the crop may have been clipped; its width is a
        # floor, not a measurement.
        "clipped": round(ps["width"], 3) >= round((cx1 - cx0) / w, 3) - 1e-9,
    }


async def main() -> None:
    if os.environ.get("SILHOUETTE_BENCH_RUN") != "1":
        print("silhouette_runner is PAID (one SAM-3 call per camera+building). "
              "Set SILHOUETTE_BENCH_RUN=1 to run it.")
        return
    _load_env()
    masks_dir, frames_dir = Path(sys.argv[1]), Path(sys.argv[2])
    label = sys.argv[3] if len(sys.argv) > 3 else None
    plan = json.loads((masks_dir / "masks.json").read_text())

    jobs = []
    for shot in plan:
        frame = frames_dir / f"wframe{shot['camera']}.png"
        if not frame.exists():
            continue
        names = [label] if label else [r["label"] for r in shot["visible"][:1]]
        jobs.extend((masks_dir, frame, shot["camera"], n) for n in names)
    rows = [r for r in await asyncio.gather(*(measure_one(*j) for j in jobs), return_exceptions=False)]

    scored = [r for r in rows if "iou" in r and not r.get("clipped")]
    report: dict[str, Any] = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "crop_pad": CROP_PAD, "rows": rows,
    }
    if scored:
        report["iou_mean"] = round(statistics.mean(r["iou"] for r in scored), 3)
        report["width_ratio_mean"] = round(statistics.mean(r["width_ratio"] for r in scored), 3)
        report["centre_dx_abs_mean"] = round(statistics.mean(abs(r["centre_dx"]) for r in scored), 3)
        report["n"] = len(scored)
        from tests._baseline import compare
        for metric, name in (("iou_mean", "silhouette_iou"), ("width_ratio_mean", "silhouette_width_ratio")):
            try:
                verdict = compare(name, report[metric], report["n"])
                report[name] = {"status": verdict.status, "detail": verdict.detail}
            except KeyError:
                report[name] = {"status": "NO_BASELINE", "detail": f"{name} not in eval_baselines.json"}
    _REPORTS.mkdir(exist_ok=True)
    (_REPORTS / "silhouette_latest.json").write_text(json.dumps(report, indent=1))
    print(json.dumps({k: v for k, v in report.items() if k != "rows"}, indent=1))
    for r in rows:
        print(json.dumps(r))


if __name__ == "__main__":
    asyncio.run(main())
