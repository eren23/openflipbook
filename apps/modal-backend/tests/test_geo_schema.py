"""P0 schema-parity gate (Python side).

Asserts the geometric-world Pydantic mirrors in generate.py stay field-for-field
in sync with the shared TS contract fixture (packages/config/src/world-geo-fixture.json).
The vitest twin (apps/web/lib/world-geo-schema.test.ts) checks the TS interfaces
against the same fixture, so together they lock TS↔Py drift.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# generate.py imports `modal` at module level (deploy-only, not a test dep).
sys.modules.setdefault("modal", MagicMock())

import generate  # noqa: E402

_FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[3]
        / "packages/config/src/world-geo-fixture.json"
    ).read_text()
)

_MODELS = {
    "WorldVec2": generate.WorldVec2,
    "ObserverPose": generate.ObserverPose,
    "MapCrop": generate.MapCrop,
    "ViewSpec": generate.ViewSpec,
    "SceneView": generate.SceneView,
    "ProjectedEntity": generate.ProjectedEntity,
}


@pytest.mark.parametrize("shape", _FIXTURE["shared_shapes"])
def test_pydantic_mirror_fields_match_fixture(shape: str) -> None:
    model = _MODELS[shape]
    assert set(model.model_fields.keys()) == set(_FIXTURE["keys"][shape])


@pytest.mark.parametrize("shape", _FIXTURE["shared_shapes"])
def test_pydantic_mirror_validates_sample(shape: str) -> None:
    model = _MODELS[shape]
    obj = model.model_validate(_FIXTURE["samples"][shape])
    assert set(obj.model_dump().keys()) == set(_FIXTURE["keys"][shape])


# ── Drift guard for the request-body geo + continuity mirrors ─────────────────
# The fixture above pins the 5 standalone geo shapes. But the same TS↔Py drift
# also bites the request body (GenerateRequestBody → GenerateBody) and the
# continuity entity (WorldContextEntity), whose fields are NOT in the fixture.
# A missing `scene_view.focus_id` (geo-tap sends it; the extract route reads it)
# slipped exactly because nothing asserted those paths. These parse the TS
# interfaces in packages/config and assert the Pydantic mirrors keep up. FREE.

_CONFIG_TS = (
    Path(__file__).resolve().parents[3] / "packages/config/src/index.ts"
).read_text()


def _ts_interface_fields(name: str) -> set[str]:
    """Field names of a TS `interface <name> { ... }` block in index.ts.

    Deliberately tiny: matches `^  <field>?:` lines (2-space indent, the file's
    style) inside the first brace block. Good enough to lock field PRESENCE so a
    dropped mirror field fails the build; not a full TS parser.
    """
    import re

    m = re.search(rf"export interface {name} \{{(.*?)\n\}}", _CONFIG_TS, re.DOTALL)
    assert m, f"interface {name} not found in packages/config/src/index.ts"
    body = m.group(1)
    fields: set[str] = set()
    for line in body.splitlines():
        fm = re.match(r"  (\w+)\??:", line)
        if fm:
            fields.add(fm.group(1))
    return fields


def test_world_context_entity_mirror_matches_ts() -> None:
    """WorldContextEntity (continuity slice) — Pydantic ↔ TS field parity."""
    assert set(generate.WorldContextEntity.model_fields.keys()) == _ts_interface_fields(
        "WorldContextEntity"
    )


def test_scene_view_mirror_carries_focus_id() -> None:
    """The exact bug that slipped: `focus_id` must round-trip through SceneView,
    not get silently dropped on validation."""
    assert "focus_id" in generate.SceneView.model_fields
    sv = generate.SceneView.model_validate(_FIXTURE["samples"]["SceneView"])
    assert sv.focus_id == "g1"


def test_scene_view_observer_pose_round_trips() -> None:
    """The observer pose is persisted on the node + restored on revisit, so the
    entered angle stays stable. Lock that it survives validation by VALUE, not
    just by field name (the mirror test checks keys only)."""
    sv = generate.SceneView.model_validate(_FIXTURE["samples"]["SceneView"])
    assert sv.observer is not None
    op = _FIXTURE["samples"]["SceneView"]["observer"]
    assert sv.observer.pos.x == op["pos"]["x"]
    assert sv.observer.eye_height == op["eye_height"]
    assert sv.observer.gaze == op["gaze"]
    assert sv.observer.pitch == op["pitch"]
    assert sv.observer.fov == op["fov"]


def test_scene_view_view_spec_round_trips() -> None:
    """The deliberate camera (view grammar) must survive validation by VALUE —
    it is persisted on the node and restored on re-enter, so a user-pinned
    projection can't silently degrade to the legacy hardcoded view."""
    sv = generate.SceneView.model_validate(_FIXTURE["samples"]["SceneView"])
    assert sv.view is not None
    assert sv.view.projection == "eye_level"
    assert sv.view.pitch_deg == -10
    assert sv.view.azimuth_deg == 45
    assert sv.view.camera_height == "eye"  # the qualitative register validates
    assert sv.view.fov_deg == 90
    assert sv.view.source == "user"
    # Legacy nodes (no view) stay valid and default to None.
    legacy = {k: v for k, v in _FIXTURE["samples"]["SceneView"].items() if k != "view"}
    assert generate.SceneView.model_validate(legacy).view is None


def test_generate_body_carries_geo_round_trip_fields() -> None:
    """GenerateBody must accept + preserve the geo-tap request fields end to end
    (scene_view incl. focus_id, expected_layout) — the path the web proxy
    forwards verbatim. Guards against a future geo field being dropped here."""
    body_fields = set(generate.GenerateBody.model_fields.keys())
    # Full field parity (not just a subset): the same drift class as the
    # SceneView.focus_id bug also bites GenerateBody — a conditional spread on
    # the TS sender bypasses excess-property checks, so tsc never flags a field
    # present on the Pydantic mirror but missing from the source-of-truth
    # interface. Assert the two field sets are equal so any divergence fails.
    assert body_fields == _ts_interface_fields("GenerateRequestBody")
    body = generate.GenerateBody.model_validate(
        {
            "query": "q",
            "session_id": "s",
            "scene_view": _FIXTURE["samples"]["SceneView"],
            "expected_layout": [_FIXTURE["samples"]["ProjectedEntity"]],
        }
    )
    assert body.scene_view is not None
    assert body.scene_view.focus_id == "g1"
    assert body.expected_layout[0].label == "Lighthouse"
