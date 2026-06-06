"""P1 geometry gate (Python side, FREE).

Asserts the Python 2.5D engine reproduces the shared golden fixture
(packages/config/src/projection-golden.json) that the vitest twin
(apps/web/lib/world-geometry.test.ts) also reproduces — so a TS/Py divergence
fails this parity gate. Plus projection property tests.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from providers import geometry

pytestmark = pytest.mark.geometry

_GOLDEN = json.loads(
    (
        Path(__file__).resolve().parents[4]
        / "packages/config/src/projection-golden.json"
    ).read_text()
)
_ASPECT = _GOLDEN["aspect"]
_FLOATS = ("x_pct", "y_pct", "w_pct", "h_pct", "depth")
_BINS = ("id", "label", "h_pos", "v_pos", "size")


def _ent(eid, x, y, height=5.0, fw=4.0):
    return {
        "id": eid,
        "label": eid,
        "pos": {"x": x, "y": y},
        "height": height,
        "footprint": {"w": fw, "d": fw},
    }


_OBS = {"pos": {"x": 0.0, "y": 0.0}, "eye_height": 1.7, "gaze": 0.0, "fov": math.pi / 2}


@pytest.mark.parametrize("scene", _GOLDEN["scenes"], ids=lambda s: s["name"])
def test_project_scene_reproduces_golden(scene) -> None:
    out = geometry.project_scene(scene["entities"], scene["observer"], _ASPECT)
    assert [p["id"] for p in out] == [e["id"] for e in scene["expected"]]  # order
    out_ids = {p["id"] for p in out}
    culled = sorted(e["id"] for e in scene["entities"] if e["id"] not in out_ids)
    assert culled == scene["culled"]
    for got, exp in zip(out, scene["expected"], strict=True):
        for f in _BINS:
            assert got[f] == exp[f]
        for f in _FLOATS:
            assert got[f] == pytest.approx(exp[f], abs=1e-6)


def test_dead_ahead_projects_to_center() -> None:
    p = geometry.project(_ent("a", 50, 0), _OBS, _ASPECT)
    assert p is not None
    assert p["x_pct"] == pytest.approx(0.5, abs=1e-9)
    assert p["h_pos"] == "center"


def test_behind_observer_is_culled() -> None:
    assert geometry.project(_ent("a", -10, 0), _OBS, _ASPECT) is None


def test_outside_fov_is_culled() -> None:
    # gaze east, fov 90° → an entity due north (bearing -90°) is past the edge.
    assert geometry.project(_ent("a", 0, -50), _OBS, _ASPECT) is None


def test_farther_is_smaller() -> None:
    near = geometry.project(_ent("a", 10, 0), _OBS, _ASPECT)
    far = geometry.project(_ent("a", 100, 0), _OBS, _ASPECT)
    assert near is not None and far is not None
    assert far["w_pct"] < near["w_pct"]
    assert far["depth"] > near["depth"]


def _elev(eid, x, y, height, elevation, fw=4.0):
    return {
        "id": eid, "label": eid, "pos": {"x": x, "y": y},
        "height": height, "elevation": elevation, "footprint": {"w": fw, "d": fw},
    }


def test_elevation_raises_on_screen() -> None:
    # Same spot + size; lifting the base (elevation) moves the entity UP (smaller y).
    ground = geometry.project(_ent("a", 40, 0, height=2), _OBS, _ASPECT)
    raised = geometry.project(_elev("a", 40, 0, 2, 20.0), _OBS, _ASPECT)
    assert ground is not None and raised is not None
    assert raised["y_pct"] < ground["y_pct"]


def test_pitch_up_lowers_scene() -> None:
    # Tilting the camera UP (pitch>0) drops everything DOWN on screen (larger y).
    level = geometry.project(_ent("a", 40, 0, height=2), _OBS, _ASPECT)
    up = geometry.project(_ent("a", 40, 0, height=2), {**_OBS, "pitch": 0.3}, _ASPECT)
    assert level is not None and up is not None
    assert up["y_pct"] > level["y_pct"]


def test_pitch_and_elevation_default_is_byte_identical() -> None:
    # Omitting the fields == 0 (additive: existing projections are unchanged).
    a = geometry.project(_ent("a", 40, 0, height=8), _OBS, _ASPECT)
    b = geometry.project(_elev("a", 40, 0, 8, 0.0), {**_OBS, "pitch": 0.0}, _ASPECT)
    assert a is not None and b is not None
    assert a["y_pct"] == pytest.approx(b["y_pct"], abs=1e-12)
    assert a["h_pct"] == pytest.approx(b["h_pct"], abs=1e-12)


def test_vertical_frustum_cull() -> None:
    # Looking down hard (pitch<0) at a tall, very close entity pushes its top
    # past the vertical image plane → culled (the new Z guard).
    assert geometry.project(_ent("a", 3, 0, height=30), {**_OBS, "pitch": -0.6}, _ASPECT) is None


def test_crop_entities_window() -> None:
    ents = [_ent("a", 5, 5), _ent("b", 50, 50), _ent("c", 9, 1)]
    got = [e["id"] for e in geometry.crop_entities(ents, {"x": 0, "y": 0, "w": 10, "h": 10})]
    assert got == ["a", "c"]


def test_neighbors_nearest_first() -> None:
    ents = [_ent("a", 0, 0), _ent("b", 100, 0), _ent("c", 5, 0)]
    nb = geometry.neighbors_of(ents, "a", 5)
    assert [n["id"] for n in nb] == ["c", "b"]
    assert nb[0]["dist"] == pytest.approx(5.0)
