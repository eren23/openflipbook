"""Free (unpaid) tests for the coherence A/B — the pure region-crop geometry.

Keeps crop_box in lockstep with lib/image-condition.ts cropBox so the eval crops
the same region the live app conditions on.
"""

from __future__ import annotations

from tests.continuity_bench.coherence_runner import crop_box


def test_crop_box_centred() -> None:
    x, y, w, h = crop_box(0.5, 0.5, 0.42)
    assert (w, h) == (0.42, 0.42)
    assert round(x, 4) == 0.29 and round(y, 4) == 0.29


def test_crop_box_clamps_to_top_left() -> None:
    # A place at the very corner can't centre — the box clamps inside the image.
    x, y, w, h = crop_box(0.0, 0.0, 0.42)
    assert (x, y) == (0.0, 0.0)
    assert (w, h) == (0.42, 0.42)


def test_crop_box_clamps_to_bottom_right() -> None:
    x, y, _w, _h = crop_box(1.0, 1.0, 0.42)
    assert round(x, 4) == 0.58 and round(y, 4) == 0.58


def test_crop_box_matches_ts_for_a_known_place() -> None:
    # Coral Cathedral: world (61.4, 21.1) on the {0,0,100,60} frame.
    x, y, w, h = crop_box(61.4 / 100, 21.1 / 60, 0.42)
    assert round(x, 4) == 0.404 and round(y, 4) == 0.1417
    assert (w, h) == (0.42, 0.42)
