"""providers/pixel_diff — the free outside-mask stability metric.

Pins the jitter-robustness contract the edit loop relies on: identical bytes
score 0, a real rect-sized edit scores high INSIDE the mask and exactly 0
OUTSIDE it, a plain JPEG re-encode of an unchanged frame stays far under any
sane gate, a different-size return still compares, and the seam fringe a
compositing model blends at the mask boundary is forgiven by dilation.
"""
from __future__ import annotations

import io

from PIL import Image, ImageDraw

from providers.pixel_diff import changed_fraction

_W, _H = 256, 144  # downscale=256 is then the identity: deterministic pixels
_BOX = (140, 40, 216, 110)  # the "selection", in pixel coords


def _base() -> Image.Image:
    grad = Image.linear_gradient("L").resize((_W, _H))
    im = Image.merge("RGB", (grad, grad.point(lambda v: 255 - v), grad))
    d = ImageDraw.Draw(im)
    d.rectangle((20, 20, 90, 80), fill=(40, 90, 160))
    d.ellipse((60, 90, 140, 130), fill=(200, 170, 60))
    return im


def _jpg(im: Image.Image, quality: int = 92) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def _mask(box: tuple[int, int, int, int] | None = _BOX) -> bytes:
    m = Image.new("L", (_W, _H), 0)
    if box is not None:
        ImageDraw.Draw(m).rectangle(box, fill=255)
    buf = io.BytesIO()
    m.save(buf, "PNG")
    return buf.getvalue()


def _edited(grow: int = 0) -> Image.Image:
    im = _base()
    x0, y0, x1, y1 = _BOX
    box = (x0 - grow, y0 - grow, x1 + grow, y1 + grow)
    ImageDraw.Draw(im).rectangle(box, fill=(230, 30, 30))
    return im


def test_identical_bytes_score_zero() -> None:
    src = _jpg(_base())
    assert changed_fraction(src, src) == 0.0
    assert changed_fraction(src, src, _mask()) == 0.0
    assert changed_fraction(src, src, _mask(), invert_mask=True) == 0.0


def test_rect_edit_lands_inside_not_outside() -> None:
    src, out = _jpg(_base()), _jpg(_edited())
    assert changed_fraction(src, out, _mask()) > 0.5
    assert changed_fraction(src, out, _mask(), invert_mask=True) == 0.0


def test_reencode_jitter_stays_under_any_gate() -> None:
    src = _jpg(_base())
    out = _jpg(Image.open(io.BytesIO(src)), quality=80)
    assert changed_fraction(src, out) < 0.01


def test_different_size_return_is_resized_onto_src_grid() -> None:
    src = _jpg(_base())
    out = _jpg(_base().resize((_W * 2, _H * 2), Image.Resampling.BILINEAR))
    assert changed_fraction(src, out) < 0.02


def test_dilation_forgives_the_seam_fringe() -> None:
    # The edit bleeds 2px past the selection — a compositor's blend seam.
    src, out = _jpg(_base()), _jpg(_edited(grow=2))
    assert changed_fraction(src, out, _mask(), invert_mask=True, dilate_px=2) == 0.0
    assert changed_fraction(src, out, _mask(), invert_mask=True, dilate_px=0) > 0.0


def test_empty_region_scores_zero() -> None:
    src, out = _jpg(_base()), _jpg(_edited())
    assert changed_fraction(src, out, _mask(box=None)) == 0.0
