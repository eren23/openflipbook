"""Free schema validation for committed scenario_lab scenarios."""
from __future__ import annotations

import pytest

from tests.scenario_lab import (
    KNOWN_DIMENSIONS,
    SCENARIOS_DIR,
    list_scenarios,
    load_scenario,
    validate_scenario,
)


def test_scenarios_dir_has_verified_entries() -> None:
    verified = list_scenarios(verified_only=True)
    assert len(verified) >= 3, "need at least 3 verified seed scenarios"


def test_all_committed_scenarios_validate() -> None:
    if not SCENARIOS_DIR.exists():
        pytest.skip("no scenarios committed yet")
    for path in SCENARIOS_DIR.glob("*.json"):
        data = load_scenario(path)
        assert data["id"] == path.stem


def test_known_dimensions_non_empty() -> None:
    assert "top_down" in KNOWN_DIMENSIONS
    assert "ux_understand" in KNOWN_DIMENSIONS


def test_validate_catches_bad_dimension() -> None:
    errors = validate_scenario({
        "id": "bad",
        "rev": 1,
        "dimensions": ["not_a_real_dimension"],
        "prompt": "x",
        "review": {"status": "draft"},
    })
    assert any("unknown dimension" in e for e in errors)


def test_migrated_layout_scenes_present() -> None:
    ids = {s["id"] for s in list_scenarios()}
    assert "lighthouse-coast" in ids
    assert "market-square" in ids
