"""Cheap pixel-level change measurement for mask-scoped edits.

The outside-mask stability gate of the edit loop: a mask PROMISES that pixels
outside the selection survive, and that promise is checkable without a VLM.
Robust to whole-image re-encode jitter by design — grayscale kills
chroma-subsampling noise, downscaling to ~256-wide averages away JPEG block
artifacts, and a per-pixel threshold + changed-FRACTION (not mean abs diff)
means a global ±2-gray drift never registers while a real edit (a large local
delta) always does. Pillow only; no numpy in the runtime.
"""
from __future__ import annotations

import io

from PIL import Image, ImageChops, ImageFilter, ImageOps


def changed_fraction(
    src: bytes,
    out: bytes,
    mask_png: bytes | None = None,
    *,
    pixel_thresh: float = 0.12,
    downscale: int = 256,
    dilate_px: int = 2,
    invert_mask: bool = False,
) -> float:
    """Fraction of region pixels whose grayscale value moved > pixel_thresh.

    The region is the mask's WHITE area (the wire convention: white = edit),
    binarized at 50% then dilated by dilate_px in downscaled space so seam
    blending at the mask boundary never counts against the OUTSIDE region;
    invert_mask=True measures the complement (the outside-stability gate).
    mask_png=None measures the whole frame. `out` is resized onto src's grid
    first, so models that return a different size bucket still compare.
    """
    a = Image.open(io.BytesIO(src)).convert("L")
    b = Image.open(io.BytesIO(out)).convert("L")
    w = min(downscale, a.width)
    size = (w, max(1, round(a.height * w / a.width)))
    a = a.resize(size, Image.Resampling.BILINEAR)
    b = b.resize(size, Image.Resampling.BILINEAR)
    thresh = max(1, round(pixel_thresh * 255))
    diff = ImageChops.difference(a, b).point(lambda v: 255 if v > thresh else 0)
    if mask_png is None:
        region = Image.new("L", size, 255)
    else:
        m = Image.open(io.BytesIO(mask_png)).convert("L").resize(size, Image.Resampling.BILINEAR)
        m = m.point(lambda v: 255 if v >= 128 else 0)
        if dilate_px > 0:
            m = m.filter(ImageFilter.MaxFilter(2 * dilate_px + 1))
        region = ImageOps.invert(m) if invert_mask else m
    total = region.histogram()[255]
    if total == 0:
        return 0.0
    hits = ImageChops.multiply(diff, region).histogram()[255]
    return hits / total
