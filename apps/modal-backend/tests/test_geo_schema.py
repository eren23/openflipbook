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
