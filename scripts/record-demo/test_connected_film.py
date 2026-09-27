import importlib.util
from pathlib import Path

import pytest
from PIL import Image

spec = importlib.util.spec_from_file_location("connected_film", Path(__file__).with_name("compose_connected_film.py"))
film = importlib.util.module_from_spec(spec)
spec.loader.exec_module(film)


def test_every_frame_has_one_saved_source_and_an_in_bounds_uniform_transform():
    seen = set()
    for i in range(film.FPS * film.DURATION):
        name, scale, x, y = film.state(i / film.FPS)
        seen.add(name)
        assert scale >= 1
        assert x <= 1e-9 and y <= 1e-9
        assert x + scale >= 1 - 1e-9 and y + scale >= 1 - 1e-9
    assert seen == {"root", "market", "interior", "lighthouse"}
    assert film.state(0) == film.state(26)


def test_approaches_move_toward_the_actual_target_and_returns_reverse_it():
    for start, end, child, reverse in film.MOVES:
        first = film.state(start)
        last = film.state(end - 1 / film.FPS)
        assert first[0] == last[0] == film.EDGES[child][0]
        assert (first[1] > last[1]) if reverse else (first[1] < last[1])
        x, y, fraction = film.crop(child)
        point = film.EDGES[child][1]
        assert x <= point[0] <= x + fraction and y <= point[1] <= y + fraction


def test_generated_arrivals_are_cuts_not_morphs():
    for start, end, child, reverse in film.MOVES:
        if not reverse:
            assert film.state(end - 1e-6)[0] == film.EDGES[child][0]
            assert film.state(end)[0] == child
            assert film.state(end)[1:] == (1, 0, 0)


def test_reviewed_lighthouse_crop_retains_crystal_and_base():
    x, y, f = film.crop("lighthouse")
    bx, by, bw, bh = (.082, .074, .127, .438)
    assert x <= bx and y <= by and x + f >= bx + bw and y + f >= by + bh


def test_raw_return_pixels_are_identical_and_no_source_is_stretched():
    images = {name: Image.new("RGB", (1376, 768), color) for name, color in
              [("root", "red"), ("market", "green"), ("interior", "blue"), ("lighthouse", "yellow")]}
    first = film.frame_at(images, 0, False)
    assert first.size == film.SIZE
    assert first.tobytes() == film.frame_at(images, 26, False).tobytes()
    assert first.getpixel((0, 0)) == (16, 23, 25)
    assert first.getpixel((960, 540)) == (255, 0, 0)


def test_invalid_times_are_not_silently_replaced():
    for t in (-1, film.DURATION):
        with pytest.raises(ValueError):
            film.state(t)
