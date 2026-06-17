"""Overlay gate (free): the frame->pixel transform that lands the annotation on
the source image. The drawing itself is verified by eye (it's a viz tool); this
pins the coordinate math so an overlay can't silently drift off the image."""
from __future__ import annotations

from tests.map_corpus.overlay import frame_to_px


def test_frame_to_px_maps_corners_and_center() -> None:
    # frame is 100x60 (the corpus convention); image any size
    assert frame_to_px(0, 0, 100, 60, 1000, 600) == (0, 0)
    assert frame_to_px(100, 60, 100, 60, 1000, 600) == (1000, 600)
    assert frame_to_px(50, 30, 100, 60, 800, 480) == (400, 240)
    # rounds to the nearest pixel
    assert frame_to_px(48, 13.1, 100, 60, 480, 355) == (230, 78)
