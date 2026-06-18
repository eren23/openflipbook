"""Segmenter parse gate (free): garbage polygons dropped, vertices clamped
and deduped, height fields coerced — the tolerant-parse contract that lets
the VLM reply be sloppy without ever raising."""
from __future__ import annotations

import pytest

from providers.segmenter import (
    MAX_VERTICES,
    detector_box_to_sam_box,
    parse_segments,
    polygon_from_mask,
    segmenter_provider,
)


def _seg(**over: object) -> dict[str, object]:
    s: dict[str, object] = {
        "label": "tower",
        "polygon": [[0.1, 0.1], [0.3, 0.1], [0.3, 0.4], [0.1, 0.4]],
        "rel_height": 1.0,
        "est_height_m": 25,
        "score": 0.9,
    }
    s.update(over)
    return s


def test_parses_a_clean_reply() -> None:
    out = parse_segments({"segments": [_seg()]})
    assert len(out) == 1
    s = out[0]
    assert s["label"] == "tower"
    assert s["polygon"] == [[0.1, 0.1], [0.3, 0.1], [0.3, 0.4], [0.1, 0.4]]
    assert s["rel_height"] == 1.0
    assert s["est_height_m"] == 25.0
    assert s["score"] == 0.9


def test_accepts_xy_dict_vertices_and_border_alias() -> None:
    out = parse_segments(
        {"segments": [_seg(polygon=None, border=[{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}])]}
    )
    assert out[0]["polygon"] == [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]


def test_drops_degenerate_and_blank_entries_never_raises() -> None:
    out = parse_segments(
        {
            "segments": [
                _seg(label="  "),  # blank label
                _seg(polygon=[[0.1, 0.1], [0.2, 0.2]]),  # <3 vertices
                _seg(polygon="not a list"),
                "not a dict",
                _seg(label="keeper"),
            ]
        }
    )
    assert [s["label"] for s in out] == ["keeper"]
    assert parse_segments(None) == []
    assert parse_segments({"weird": True}) == []


def test_clamps_dedupes_and_caps_vertices() -> None:
    ring = [[0.0, 0.0], [0.0, 0.0], [2.0, -1.0], [0.5, 0.5], [0.0, 0.0]]
    out = parse_segments({"segments": [_seg(polygon=ring)]})
    # consecutive dupe dropped, coords clamped to 0..1, closing vertex == first dropped
    assert out[0]["polygon"] == [[0.0, 0.0], [1.0, 0.0], [0.5, 0.5]]
    big = [[i / 100, i / 100] for i in range(40)]
    out = parse_segments({"segments": [_seg(polygon=big)]})
    assert len(out[0]["polygon"]) == MAX_VERTICES


def test_height_fields_coerced() -> None:
    out = parse_segments(
        {
            "segments": [
                _seg(label="a", rel_height=3.0, est_height_m="not a number"),
                _seg(label="b", rel_height=-1, est_height_m=-5),
                _seg(label="c", rel_height="0.5", est_height_m="12.5"),
            ]
        }
    )
    by = {s["label"]: s for s in out}
    assert by["a"]["rel_height"] == 1.0 and by["a"]["est_height_m"] is None
    assert by["b"]["rel_height"] == 0.0 and by["b"]["est_height_m"] is None
    assert by["c"]["rel_height"] == 0.5 and by["c"]["est_height_m"] == 12.5


# --- SAM3 provider dispatch + pure mask->polygon ----------------------------


def test_segmenter_provider_defaults_to_vlm(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SEGMENTER_PROVIDER", raising=False)
    assert segmenter_provider() == "vlm"
    monkeypatch.setenv("SEGMENTER_PROVIDER", "SAM3_FAL")  # case-insensitive
    assert segmenter_provider() == "sam3_fal"
    monkeypatch.setenv("SEGMENTER_PROVIDER", "nonsense")  # unknown -> safe default
    assert segmenter_provider() == "vlm"


def test_polygon_from_mask_bounds_the_blob() -> None:
    from PIL import Image, ImageDraw

    img = Image.new("L", (200, 120), 0)
    ImageDraw.Draw(img).ellipse([40, 30, 160, 90], fill=255)  # bbox (0.2,0.25)-(0.8,0.75)

    poly = polygon_from_mask(img, n_vertices=20)

    assert 3 <= len(poly) <= MAX_VERTICES
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    assert all(0.0 <= v <= 1.0 for v in xs + ys)
    # the radial polygon's bbox approximates the white ellipse's bbox
    assert abs(min(xs) - 0.2) < 0.08 and abs(max(xs) - 0.8) < 0.08
    assert abs(min(ys) - 0.25) < 0.08 and abs(max(ys) - 0.75) < 0.08


def test_polygon_from_empty_mask_is_empty() -> None:
    from PIL import Image

    assert polygon_from_mask(Image.new("L", (50, 50), 0)) == []


def test_detector_box_to_sam_box_centre_to_pixel_corners() -> None:
    # detector boxes are centre-based normalized; SAM3 box_prompts are pixel corners
    b = detector_box_to_sam_box(
        {"x_pct": 0.5, "y_pct": 0.5, "w_pct": 0.2, "h_pct": 0.1}, 1000, 600
    )
    assert b == {"x_min": 400, "y_min": 270, "x_max": 600, "y_max": 330}


def test_detector_box_clamps_to_image_bounds() -> None:
    # a box hanging off the top-left edge is clamped, never negative
    b = detector_box_to_sam_box(
        {"x_pct": 0.05, "y_pct": 0.02, "w_pct": 0.2, "h_pct": 0.1}, 1000, 600
    )
    assert b["x_min"] == 0 and b["y_min"] == 0
    assert b["x_max"] == 150 and b["y_max"] == 42
