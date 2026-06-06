"""P1 cross-language parity-fuzz (Python pin) + structural properties.

Pins the Python engine to the committed differential corpus
(packages/config/src/projection-fuzz.json) — the same corpus the vitest gate
(apps/web/lib/world-geometry.fuzz.test.ts) runs the TS engine against. Together
they prove TS == Py over hundreds of random projections, not just the 2 goldens.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from providers import geometry

pytestmark = pytest.mark.geometry

_FUZZ = json.loads(
    (
        Path(__file__).resolve().parents[4]
        / "packages/config/src/projection-fuzz.json"
    ).read_text()
)
_FLOATS = ("x_pct", "y_pct", "w_pct", "h_pct", "depth")
_BINS = ("id", "label", "h_pos", "v_pos", "size")


def test_fuzz_corpus_reproduces_from_engine() -> None:
    """The committed corpus is exactly what the current engine emits."""
    total = 0
    for sc in _FUZZ["scenes"]:
        out = geometry.project_scene(sc["entities"], sc["observer"], sc["aspect"])
        assert [p["id"] for p in out] == [e["id"] for e in sc["expected"]]
        for got, exp in zip(out, sc["expected"], strict=True):
            for f in _BINS:
                assert got[f] == exp[f]
            for f in _FLOATS:
                assert got[f] == pytest.approx(exp[f], abs=1e-9)
        total += len(out)
    # Guard against a degenerate corpus silently making the gate vacuous.
    assert total >= 200


def test_left_right_mirror_symmetry() -> None:
    """Structural truth (independent of any golden): an entity at bearing +θ and
    its mirror at -θ project to x and 1-x at the same height."""
    obs = {"pos": {"x": 0.0, "y": 0.0}, "eye_height": 1.7, "gaze": 0.0, "fov": math.pi / 2}
    d = 50.0
    for ang in (0.2, 0.6, 1.1, 1.3):  # all < half-fov (π/4 ≈ 0.785)? no — test cull too
        if ang >= math.pi / 4:
            # past the edge → both mirror entities culled
            assert geometry.project({"id": "r", "pos": {"x": d * math.cos(ang), "y": d * math.sin(ang)}, "height": 5, "footprint": {"w": 4, "d": 4}}, obs, 1.0) is None
            continue
        left = geometry.project({"id": "l", "label": "l", "pos": {"x": d * math.cos(-ang), "y": d * math.sin(-ang)}, "height": 5, "footprint": {"w": 4, "d": 4}}, obs, 1.0)
        right = geometry.project({"id": "r", "label": "r", "pos": {"x": d * math.cos(ang), "y": d * math.sin(ang)}, "height": 5, "footprint": {"w": 4, "d": 4}}, obs, 1.0)
        assert left is not None and right is not None
        assert left["x_pct"] == pytest.approx(1.0 - right["x_pct"], abs=1e-9)
        assert left["y_pct"] == pytest.approx(right["y_pct"], abs=1e-9)
        assert left["w_pct"] == pytest.approx(right["w_pct"], abs=1e-9)
