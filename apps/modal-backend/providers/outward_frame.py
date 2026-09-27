"""Where the source map sits inside its zoom-out (OUTWARD) image.

The ascend hop redraws or outpaints the source smaller near the centre, at a
scale that nothing reports. Without that scale the wider map inherits the
source's frame, and every place on it is 2-3x too large (live Lantern Quay,
2026-09-17: the town sat at 0.44x, the frame said 1.0x).

A centre-constrained, multi-scale normalized cross-correlation over small
greyscale copies finds the scale and offset. Pillow only: the backend image
has no numpy.
"""

from __future__ import annotations

from io import BytesIO

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps, ImageStat

WORK_WIDTH = 192
# Live Lantern Quay: true zoom-out 0.74, an unrelated street view 0.42.
MIN_SCORE = 0.6
# A repeating map (fields, tiles) correlates almost as well in many places.
# Take the peak only when it beats the best placement well away from it.
MIN_MARGIN = 0.04
FAR_PIXELS = 0.1  # "well away", as a fraction of the working width
# Decode limits: the source image arrives from the client.
MAX_BYTES = 24 * 1024 * 1024
MAX_PIXELS = 40_000_000
# Compare the source's central 60%: redraws drop cartouches and legends at its edges.
CORE = 0.6
# The ascend prompts keep the source at the centre.
MAX_SHIFT = 0.12
# composite_source puts back only this central share of the source, in an
# oval: its edges hold the title cartouche, compass and scale bar, and pasting
# those made a map inside the map with a pale parchment rectangle round it
# (live Lantern Quay, 2026-09-24). The redraw keeps its own version of them.
PASTE_CORE = 0.8
# The oval's edge fades into the redraw over this share of its shorter side.
FEATHER = 0.15
# composite_source only puts the source back when it is a real sub-region.
# A hop that barely zoomed out redraws the map at about the same size (live
# Lantern Quay 2026-09-24: located at 0.98 of the width, judged alignment
# 2/10); pasting the source there would make the "wider" map the source.
MAX_COMPOSITE_SHARE = 0.8


def _grey(img: Image.Image, w: int, h: int) -> Image.Image:
    return ImageOps.grayscale(img).resize((w, h), Image.Resampling.BILINEAR).filter(ImageFilter.GaussianBlur(1))


def _ncc(a: Image.Image, t: Image.Image, t_mean: float, t_std: float) -> float:
    sa = ImageStat.Stat(a)
    a_mean, a_std = sa.mean[0], sa.stddev[0]
    if a_std < 1 or t_std < 1:
        return -1.0
    # ImageChops.multiply divides by 255; undo it for the product mean.
    prod = ImageStat.Stat(ImageChops.multiply(a, t)).mean[0] * 255
    return (prod - a_mean * t_mean) / (a_std * t_std)


def _open(data: bytes) -> Image.Image | None:
    if len(data) > MAX_BYTES:
        return None
    try:
        img = Image.open(BytesIO(data))
        img.draft("L", (WORK_WIDTH * 4, WORK_WIDTH * 4))  # cheap JPEG downscale
        if img.width * img.height > MAX_PIXELS or img.width < 8 or img.height < 8:
            return None
        return img
    except Exception:
        return None


def locate_source(source: bytes, wide: bytes) -> dict[str, float] | None:
    """The normalized rect {x_pct, y_pct, w_pct, h_pct, score} of `source`
    inside `wide`, or None when no placement scores MIN_SCORE clearly."""
    src = _open(source)
    big_img = _open(wide)
    if src is None or big_img is None:
        return None
    W = WORK_WIDTH
    H = round(W * big_img.height / big_img.width)
    big = _grey(big_img, W, H)
    templates: dict[int, tuple[Image.Image, int, int, int, int, float, float]] = {}

    def template(tw: int) -> tuple[Image.Image, int, int, int, int, float, float]:
        if tw not in templates:
            th = max(1, round(tw * src.height / src.width))
            full = _grey(src, tw, th)
            cx, cy = round(tw * (1 - CORE) / 2), round(th * (1 - CORE) / 2)
            core = full.crop((cx, cy, tw - cx, th - cy))
            st = ImageStat.Stat(core)
            templates[tw] = (core, th, cx, cy, tw, st.mean[0], st.stddev[0])
        return templates[tw]

    best: tuple[float, int, int, int] = (-2.0, 0, 0, 0)  # (score, tw, x, y) of the source's top-left
    # Best score per coarse position bucket, to judge how unique the peak is.
    by_place: dict[tuple[int, int], float] = {}

    def search(widths: range, xs: range | None, ys: range | None, step: int) -> None:
        nonlocal best
        bucket = max(2, round(W * FAR_PIXELS))
        for tw in widths:
            core, th, cx, cy, _, t_mean, t_std = template(tw)
            if core.width < 8 or core.height < 8 or tw > W or th > H:
                continue
            x_mid, y_mid = round((W - tw) / 2), round((H - th) / 2)
            dx, dy = round(W * MAX_SHIFT), round(H * MAX_SHIFT)
            for y in ys if ys is not None else range(y_mid - dy, y_mid + dy + 1, step):
                for x in xs if xs is not None else range(x_mid - dx, x_mid + dx + 1, step):
                    x0, y0 = x + cx, y + cy
                    # The WHOLE template must sit inside the frame, not just
                    # its core, or the returned rect spills outside the image.
                    if x < 0 or y < 0 or x + tw > W or y + th > H:
                        continue
                    score = _ncc(big.crop((x0, y0, x0 + core.width, y0 + core.height)), core, t_mean, t_std)
                    key = (round((x + tw / 2) / bucket), round((y + th / 2) / bucket))
                    if score > by_place.get(key, -2.0):
                        by_place[key] = score
                    if score > best[0]:
                        best = (score, tw, x, y)

    # Coarse: every 4% of scale, every 2nd pixel; then refine around the peak.
    # From 12% of the width, so a tall source in a wide container is reachable.
    search(range(round(W * 0.12), W + 1, round(W * 0.04)), None, None, 2)
    if best[0] < 0:
        return None
    _, tw0, x0, y0 = best
    search(range(tw0 - 8, tw0 + 9), range(x0 - 3, x0 + 4), range(y0 - 3, y0 + 4), 1)
    score, tw, x, y = best
    if score < MIN_SCORE:
        return None
    # A repeating map matches nearly as well somewhere else entirely. Compare
    # the peak with the best CENTRE at least one bucket away from it.
    bucket = max(2, round(W * FAR_PIXELS))
    peak = (round((x + tw / 2) / bucket), round((y + template(tw)[1] / 2) / bucket))
    elsewhere = [v for k, v in by_place.items() if max(abs(k[0] - peak[0]), abs(k[1] - peak[1])) > 1]
    if elsewhere and score - max(elsewhere) < MIN_MARGIN:
        return None
    th = template(tw)[1]
    return {"x_pct": x / W, "y_pct": y / H, "w_pct": tw / W, "h_pct": th / H, "score": round(score, 3)}


def _open_full(data: bytes) -> Image.Image | None:
    """Full-colour, full-size decode (unlike _open, which drafts a small grey copy)."""
    if len(data) > MAX_BYTES:
        return None
    try:
        img = Image.open(BytesIO(data))
        if img.width * img.height > MAX_PIXELS or img.width < 8 or img.height < 8:
            return None
        return img.convert("RGB")
    except Exception:
        return None


def composite_source(source: bytes, wide: bytes, rect: dict[str, float]) -> bytes | None:
    """`wide` with the source's REAL pixels put back where it was located.

    The ascend edit redraws the source smaller near the centre, and a redraw
    re-invents it: the right medium and layout, but a different city (#252).
    `rect` (from locate_source) says where that redraw landed, so the source's
    own pixels replace the middle of it (see PASTE_CORE), in an oval that
    fades into the redraw.
    Returns JPEG bytes, or None when an image will not decode, the rect is
    too small to place, or it is no real sub-region (see MAX_COMPOSITE_SHARE)."""
    if max(rect["w_pct"], rect["h_pct"]) > MAX_COMPOSITE_SHARE:
        return None
    src, big = _open_full(source), _open_full(wide)
    if src is None or big is None:
        return None
    w_img, h_img = big.size
    x0 = max(0, min(w_img - 1, round(rect["x_pct"] * w_img)))
    y0 = max(0, min(h_img - 1, round(rect["y_pct"] * h_img)))
    w = min(w_img - x0, round(rect["w_pct"] * w_img))
    h = min(h_img - y0, round(rect["h_pct"] * h_img))
    if w < 16 or h < 16:
        return None
    placed = src.resize((w, h), Image.Resampling.LANCZOS)
    cw, ch = round(w * PASTE_CORE), round(h * PASTE_CORE)
    ox, oy = (w - cw) // 2, (h - ch) // 2
    band = max(1, round(min(cw, ch) * FEATHER))
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).ellipse((ox + band, oy + band, ox + cw - band, oy + ch - band), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(band / 2))
    big.paste(placed, (x0, y0), mask)
    buf = BytesIO()
    big.save(buf, "JPEG", quality=92)
    return buf.getvalue()
