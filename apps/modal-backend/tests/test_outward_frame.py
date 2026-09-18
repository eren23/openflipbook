import random
from io import BytesIO

from PIL import Image, ImageDraw

from providers.outward_frame import locate_source


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
