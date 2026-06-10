"""EDIT-MASK SMOKE — does `openai/gpt-image-2/edit` (via fal) HONOR mask_url?

The schema takes it (scripts/verify-fal-models.py) but schema is not
behavior: OpenAI-family edit models historically regenerate the whole
canvas. This one-off paid probe (~$0.5, zero VLM spend) answers with pixels:
  - which mask convention the endpoint obeys — white-on-black (white = edit,
    the flux fill convention), the inverse, or OpenAI's own images.edit
    convention (alpha hole = edit);
  - how stable the OUTSIDE-mask region is per arm, with a no-mask control
    measuring the model's whole-canvas churn floor — that number seeds the
    edit loop's EDIT_LOOP_OUTSIDE_MAX gate;
  - that the dormant `fal-ai/flux-pro/v1/fill` slot works end to end
    (image_url singular + mask_url + seed; white = inpaint).

Every arm gets the same loud instruction and is scored against the same
CANONICAL white mask with providers.pixel_diff.changed_fraction — the exact
metric the production loop will use, so the smoke validates that too.

Per-arm verdicts: EDITED_INSIDE_ONLY (mask honored) / EDITED_EVERYWHERE
(whole-canvas regenerator) / EDITED_OUTSIDE_ONLY (inverted convention) /
NO_EDIT. The decision table:
  - some gpt arm is EDITED_INSIDE_ONLY -> that's the convention;
    gpt-image-2/edit stays the primary inpaint model.
  - all gpt arms are EDITED_EVERYWHERE or NO_EDIT -> flux-pro/v1/fill
    becomes primary (it composites; outside is pixel-identical).

FINDINGS (2026-06-10 run; reports/edit_mask_smoke.json + arm images):
  - gpt-image-2/edit ACCEPTS mask_url but honors NO convention — every
    masked arm regenerated the whole canvas (white: outside 0.278, black:
    0.999, alpha: 1.0). Its no-mask control still churned 0.089 of the
    canvas: even an unmasked "small edit" repaints everything slightly.
  - flux-pro/v1/fill (white = inpaint) is a TRUE compositor: inside 0.395,
    outside 0.0000 — pixel-identical beyond the selection, source dims
    kept. PRIMARY INPAINT MODEL; the long-dormant MODEL_SLOTS["inpaint"]
    default was right all along. White=edit is its native convention (no
    mask adaptation needed) and EDIT_LOOP_OUTSIDE_MAX can sit tight (0.02).
  - Consequence: there is no mask-honoring fallback model — if fill fails,
    degrade to the whole-image edit path rather than pretend gpt confines.

Usage:  cd apps/modal-backend && EDIT_REGION_BENCH_RUN=1 \
          .venv/bin/python -m tests.edit_bench.mask_smoke
or:     make eval-edit-mask-smoke
"""
from __future__ import annotations

import asyncio
import io
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

from providers._common import to_fal_url
from providers.image import (
    _fal_subscribe,
    _fetch_image_bytes,
    _first_image,
    encode_data_url,
)
from providers.pixel_diff import changed_fraction

_HERE = Path(__file__).resolve().parent
_FIXTURE = _HERE / "fixtures" / "source.jpg"
_REPORTS = _HERE / "reports"

_GPT_EDIT = "openai/gpt-image-2/edit"
_FLUX_FILL = "fal-ai/flux-pro/v1/fill"

# x, y, w, h normalized to the fixture — open sea left of the harbor wall,
# clear of the lighthouse cliff and the bottom-left compass rose.
_RECT = (0.04, 0.42, 0.20, 0.28)
_INSTRUCTION = "add a single bright red hot-air balloon floating in this area"

_INSIDE_MIN = 0.10  # below this fraction the asked edit didn't land
_OUTSIDE_MAX = 0.05  # above this the canvas churned beyond the selection


@dataclass
class ArmResult:
    arm: str
    model: str
    mask: str | None
    inside: float | None = None
    outside: float | None = None
    width: int | None = None
    height: int | None = None
    aspect_changed: bool = False
    verdict: str = "ERROR"
    error: str | None = None


def _rect_px(size: tuple[int, int]) -> tuple[int, int, int, int]:
    w, h = size
    x, y, rw, rh = _RECT
    return (round(x * w), round(y * h), round((x + rw) * w), round((y + rh) * h))


def build_masks(size: tuple[int, int]) -> dict[str, bytes]:
    """The three convention candidates, full fixture dims, lossless PNG."""
    box = _rect_px(size)
    white = Image.new("L", size, 0)
    ImageDraw.Draw(white).rectangle(box, fill=255)
    black = Image.new("L", size, 255)
    ImageDraw.Draw(black).rectangle(box, fill=0)
    alpha = Image.new("RGBA", size, (255, 255, 255, 255))
    ImageDraw.Draw(alpha).rectangle(box, fill=(255, 255, 255, 0))
    out: dict[str, bytes] = {}
    for name, im in (("white", white), ("black", black), ("alpha", alpha)):
        buf = io.BytesIO()
        im.save(buf, "PNG")
        out[name] = buf.getvalue()
    return out


async def _run_arm(
    arm: str,
    model: str,
    mask_name: str | None,
    args: dict[str, Any],
    src: bytes,
    white_mask: bytes,
    src_size: tuple[int, int],
) -> ArmResult:
    r = ArmResult(arm=arm, model=model, mask=mask_name)
    try:
        result = await _fal_subscribe(model, args)
        raw, mime = await _fetch_image_bytes(_first_image(result))
    except Exception as e:  # one dead arm must not kill the probe
        r.error = f"{type(e).__name__}: {e}"
        return r
    r.width, r.height = Image.open(io.BytesIO(raw)).size
    src_aspect = src_size[0] / src_size[1]
    r.aspect_changed = abs(r.width / r.height - src_aspect) / src_aspect > 0.02
    # Always scored against the canonical white mask, whatever was sent.
    r.inside = round(changed_fraction(src, raw, white_mask), 4)
    r.outside = round(changed_fraction(src, raw, white_mask, invert_mask=True), 4)
    edited_in, edited_out = r.inside >= _INSIDE_MIN, r.outside > _OUTSIDE_MAX
    r.verdict = (
        "EDITED_INSIDE_ONLY"
        if edited_in and not edited_out
        else "EDITED_EVERYWHERE"
        if edited_in
        else "EDITED_OUTSIDE_ONLY"
        if edited_out
        else "NO_EDIT"
    )
    ext = "png" if mime.endswith("png") else "jpg"
    (_REPORTS / f"mask_smoke_{arm}.{ext}").write_bytes(raw)
    return r


async def run_smoke() -> dict[str, Any]:
    src = _FIXTURE.read_bytes()
    src_size = Image.open(io.BytesIO(src)).size
    masks = build_masks(src_size)
    _REPORTS.mkdir(parents=True, exist_ok=True)
    src_url = await to_fal_url(encode_data_url(src, "image/jpeg"))
    mask_urls = {
        name: await to_fal_url(encode_data_url(png, "image/png"))
        for name, png in masks.items()
    }

    def gpt(mask: str | None) -> dict[str, Any]:
        args: dict[str, Any] = {"prompt": _INSTRUCTION, "image_urls": [src_url]}
        if mask:
            args["mask_url"] = mask_urls[mask]
        return args

    arms = [
        ("gpt_white", _GPT_EDIT, "white", gpt("white")),
        ("gpt_black", _GPT_EDIT, "black", gpt("black")),
        ("gpt_alpha", _GPT_EDIT, "alpha", gpt("alpha")),
        ("gpt_nomask", _GPT_EDIT, None, gpt(None)),
        (
            "fill_white",
            _FLUX_FILL,
            "white",
            {
                "prompt": _INSTRUCTION,
                "image_url": src_url,
                "mask_url": mask_urls["white"],
                "seed": 42,
            },
        ),
    ]
    results = list(
        await asyncio.gather(
            *[
                _run_arm(arm, model, mask, args, src, masks["white"], src_size)
                for arm, model, mask, args in arms
            ]
        )
    )
    return {
        "fixture": _FIXTURE.name,
        "rect": _RECT,
        "instruction": _INSTRUCTION,
        "inside_min": _INSIDE_MIN,
        "outside_max": _OUTSIDE_MAX,
        "arms": [asdict(r) for r in results],
        "mask_honored_by": [r.arm for r in results if r.verdict == "EDITED_INSIDE_ONLY"],
    }


def _load_env() -> None:
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _cli() -> None:
    if not os.environ.get("EDIT_REGION_BENCH_RUN"):
        raise SystemExit("set EDIT_REGION_BENCH_RUN=1 to spend ~$0.5 on the edit-mask smoke")
    _load_env()
    if not os.environ.get("FAL_KEY"):
        raise SystemExit("FAL_KEY required (apps/modal-backend/.env)")
    report = asyncio.run(run_smoke())
    (_REPORTS / "edit_mask_smoke.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    honored = report["mask_honored_by"]
    print(
        f"\nMASK HONORED BY: {honored or 'NOBODY'} — "
        + (
            "gpt-image-2/edit stays primary."
            if any(a.startswith("gpt") for a in honored)
            else "flux-pro/v1/fill becomes the primary inpaint model."
            if "fill_white" in honored
            else "no arm confined the edit; inspect the report images."
        )
    )


if __name__ == "__main__":
    _cli()
