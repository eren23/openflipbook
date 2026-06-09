"""Anchor tests for providers.geometry_checks — the deterministic geometry /
consistency invariants. The shared world-geo fixture samples must produce zero
issues; crafted-bad inputs must surface the expected issue code. FREE."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from providers.geometry_checks import (
    GeoIssue,
    check_geo_entities,
    check_map_crop,
    check_observer,
    check_projected,
    check_scene_view,
)

_FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[3] / "packages/config/src/world-geo-fixture.json"
    ).read_text()
)
_S = _FIXTURE["samples"]

pytestmark = pytest.mark.geometry


def _codes(issues: list[GeoIssue]) -> set[str]:
    return {i.code for i in issues}


# ── valid fixtures → zero issues ──────────────────────────────────────────────


def test_valid_geo_entity_clean() -> None:
    assert check_geo_entities([_S["WorldEntityGeo"]]) == []


def test_valid_observer_clean() -> None:
    assert check_observer(_S["ObserverPose"]) == []


def test_valid_scene_view_clean() -> None:
    assert check_scene_view(_S["SceneView"]) == []


def test_valid_projected_clean() -> None:
    assert check_projected([_S["ProjectedEntity"]]) == []


def test_valid_map_crop_clean() -> None:
    assert check_map_crop(_S["MapCrop"]) == []


# ── crafted-bad inputs → expected codes ───────────────────────────────────────


def test_nonpositive_footprint_flagged() -> None:
    e = {**_S["WorldEntityGeo"], "footprint": {"w": 0, "d": 4}}
    assert "geo.nonpositive_footprint" in _codes(check_geo_entities([e]))


def test_nan_pos_flagged() -> None:
    e = {**_S["WorldEntityGeo"], "pos": {"x": float("nan"), "y": 0}}
    assert "geo.bad_pos" in _codes(check_geo_entities([e]))


def test_duplicate_id_flagged() -> None:
    e = _S["WorldEntityGeo"]
    assert "geo.dup_id" in _codes(check_geo_entities([e, e]))


def test_dangling_parent_flagged() -> None:
    e = {**_S["WorldEntityGeo"], "parent_id": "nope"}
    assert "geo.dangling_parent" in _codes(check_geo_entities([e]))


def test_parent_cycle_flagged() -> None:
    a = {**_S["WorldEntityGeo"], "id": "a", "parent_id": "b"}
    b = {**_S["WorldEntityGeo"], "id": "b", "parent_id": "a"}
    assert "geo.parent_cycle" in _codes(check_geo_entities([a, b]))


def test_confidence_out_of_range_flagged() -> None:
    e = {**_S["WorldEntityGeo"], "confidence": 1.5}
    assert "geo.bad_confidence" in _codes(check_geo_entities([e]))


def test_bad_kind_flagged() -> None:
    e = {**_S["WorldEntityGeo"], "kind": "dragon"}
    assert "geo.bad_kind" in _codes(check_geo_entities([e]))


def test_bad_scale_tier_flagged() -> None:
    e = {**_S["WorldEntityGeo"], "scale_tier": "bogus"}
    assert "geo.bad_tier" in _codes(
        check_geo_entities([e], valid_tiers=frozenset({"place", "city"}))
    )


def test_observer_fov_too_wide_flagged() -> None:
    o = {**_S["ObserverPose"], "fov": 4.0}
    assert "obs.bad_fov" in _codes(check_observer(o))


def test_observer_zero_eye_height_flagged() -> None:
    o = {**_S["ObserverPose"], "eye_height": 0}
    assert "obs.bad_eye_height" in _codes(check_observer(o))


def test_observer_pitch_out_of_range_flagged() -> None:
    o = {**_S["ObserverPose"], "pitch": 2.0}
    assert "obs.bad_pitch" in _codes(check_observer(o))


def test_projected_pct_out_of_range_flagged() -> None:
    p = {**_S["ProjectedEntity"], "x_pct": 1.5}
    assert "proj.pct_range" in _codes(check_projected([p]))


def test_projected_bad_bin_flagged() -> None:
    p = {**_S["ProjectedEntity"], "h_pos": "middle"}
    assert "proj.bad_hpos" in _codes(check_projected([p]))


def test_scene_view_bad_level_flagged() -> None:
    sv = {**_S["SceneView"], "level": "orbit"}
    assert "view.bad_level" in _codes(check_scene_view(sv))


def test_map_crop_nonpositive_flagged() -> None:
    assert "crop.nonpositive" in _codes(check_map_crop({"x": 0, "y": 0, "w": 0, "h": 60}))
