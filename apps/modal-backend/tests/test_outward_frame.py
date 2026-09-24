import random
from io import BytesIO

from PIL import Image, ImageDraw

from providers.outward_frame import FEATHER, PASTE_CORE, composite_source, locate_source


def _png(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _town(seed: int, size: tuple[int, int] = (960, 540)) -> Image.Image:
    rng = random.Random(seed)
    img = Image.new("RGB", size, (214, 190, 140))
    draw = ImageDraw.Draw(img)
    for _ in range(60):
        x, y = rng.randrange(size[0]), rng.randrange(size[1])
        w, h = rng.randrange(30, 140), rng.randrange(20, 90)
        colour = tuple(rng.randrange(40, 220) for _ in range(3))
        (draw.rectangle if rng.random() < 0.6 else draw.ellipse)((x, y, x + w, y + h), fill=colour)
    return img


def test_finds_a_half_size_source_at_the_centre() -> None:
    source = _town(1)
    wide = _town(2, (1376, 768))
    wide.paste(source.resize((688, 384)), (344, 192))
    rect = locate_source(_png(source), _png(wide))
    assert rect is not None
    assert abs(rect["w_pct"] - 0.5) < 0.02 and abs(rect["h_pct"] - 0.5) < 0.02
    assert abs(rect["x_pct"] - 0.25) < 0.02 and abs(rect["y_pct"] - 0.25) < 0.02


def test_finds_an_off_centre_third_size_source() -> None:
    source = _town(3)
    wide = _town(4, (1200, 675))
    wide.paste(source.resize((400, 225)), (440, 180))
    rect = locate_source(_png(source), _png(wide))
    assert rect is not None
    assert abs(rect["w_pct"] - 1 / 3) < 0.02
    assert abs(rect["x_pct"] - 440 / 1200) < 0.02 and abs(rect["y_pct"] - 180 / 675) < 0.02


def test_an_unrelated_image_is_not_located() -> None:
    assert locate_source(_png(_town(5)), _png(_town(6, (1376, 768)))) is None


def test_a_pattern_that_repeats_within_the_search_window_is_refused() -> None:
    """Stripes match just as well a step to the side, so no placement is the
    placement. Ambiguity FURTHER out than the search window is not seen."""
    def striped(size: tuple[int, int]) -> Image.Image:
        img = Image.new("RGB", size, (214, 190, 140))
        draw = ImageDraw.Draw(img)
        for x in range(0, size[0], 40):
            draw.rectangle((x, 0, x + 20, size[1]), fill=(90, 120, 80))
        return img

    assert locate_source(_png(striped((960, 540))), _png(striped((1376, 768)))) is None


def test_an_oversized_or_broken_image_is_refused_without_decoding_it() -> None:
    assert locate_source(b"x" * (25 * 1024 * 1024), _png(_town(7, (1376, 768)))) is None
    assert locate_source(_png(_town(7)), b"not an image") is None


def _mean_abs(a: Image.Image, b: Image.Image) -> float:
    from PIL import ImageChops, ImageStat

    return sum(ImageStat.Stat(ImageChops.difference(a.convert("RGB"), b.convert("RGB"))).mean) / 3


def _redrawn(source: Image.Image) -> Image.Image:
    """The ascend edit's centre: the same layout, re-invented pixels."""
    from PIL import ImageEnhance, ImageFilter

    return ImageEnhance.Color(source.filter(ImageFilter.GaussianBlur(3))).enhance(0.3)


def test_composite_puts_the_real_source_back_over_the_redraw() -> None:
    source = _town(11)
    wide = _town(12, (1376, 768))
    wide.paste(_redrawn(source).resize((688, 384)), (344, 192))
    rect = locate_source(_png(source), _png(wide))
    assert rect is not None
    out = composite_source(_png(source), _png(wide), rect)
    assert out is not None
    got = Image.open(BytesIO(out))
    # the middle of the placement is now the source, not the redraw
    inner = (344 + 688 * 3 // 10, 192 + 384 * 3 // 10, 344 + 688 * 7 // 10, 192 + 384 * 7 // 10)
    truth = source.resize((688, 384)).crop((688 * 3 // 10, 384 * 3 // 10, 688 * 7 // 10, 384 * 7 // 10))
    assert _mean_abs(got.crop(inner), truth) < 6
    assert _mean_abs(got.crop(inner), wide.crop(inner)) > 3 * _mean_abs(got.crop(inner), truth)
    # the placement's corners (a source's cartouche, compass, scale bar) and
    # everything outside it stay the redraw's
    corner = (344, 192, 344 + 688 // 10, 192 + 384 // 10)
    assert _mean_abs(got.crop(corner), wide.crop(corner)) < 6
    assert _mean_abs(got.crop((0, 0, 300, 150)), wide.crop((0, 0, 300, 150))) < 6
    assert FEATHER > 0 and 0 < PASTE_CORE < 1


def test_composite_fails_open() -> None:
    wide = _png(_town(13, (1376, 768)))
    assert composite_source(b"not an image", wide, {"x_pct": 0.25, "y_pct": 0.25, "w_pct": 0.5, "h_pct": 0.5}) is None
    # a rect too small to place is refused, one past the edge is clamped
    assert composite_source(_png(_town(14)), wide, {"x_pct": 0.5, "y_pct": 0.5, "w_pct": 0.005, "h_pct": 0.005}) is None
    clamped = composite_source(_png(_town(14)), wide, {"x_pct": 0.8, "y_pct": 0.8, "w_pct": 0.5, "h_pct": 0.5})
    assert clamped is not None and Image.open(BytesIO(clamped)).size == (1376, 768)


def test_composite_refuses_a_hop_that_did_not_zoom_out() -> None:
    """Live 2026-09-24: a redraw at the same size located at 0.98 of the width.
    Pasting the source there would make the wider map the source itself."""
    wide = _png(_town(15, (1376, 768)))
    same_size = {"x_pct": 0.01, "y_pct": 0.0, "w_pct": 0.98, "h_pct": 0.99}
    assert composite_source(_png(_town(16)), wide, same_size) is None
