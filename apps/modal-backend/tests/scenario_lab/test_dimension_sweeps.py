"""Free tests for scenario_lab dimension filtering and sweep loading."""
from __future__ import annotations

import json
from pathlib import Path

from tests.matrix_bench._record import load_sweep
from tests.scenario_lab import filter_by_dimensions, list_scenarios
from tests.scenario_lab.runner import lab_scenarios

_SWEEPS = Path(__file__).resolve().parent / "sweeps"


def test_dimension_filter_narrows_scenarios() -> None:
    all_s = list_scenarios(verified_only=True)
    layout_only = filter_by_dimensions(all_s, ["layout"])
    assert layout_only
    assert all("layout" in s["dimensions"] for s in layout_only)


def test_lab_scenarios_respects_dimension_filter() -> None:
    sweep = load_sweep(_SWEEPS / "pov.json")
    scenarios = lab_scenarios(sweep)
    assert scenarios
    ids = {s.id for s in scenarios}
    assert any("loft-interior" in i for i in ids)


def test_all_sweeps_load() -> None:
    for path in _SWEEPS.glob("*.json"):
        sweep = load_sweep(path)
        assert sweep["name"] == path.stem


def test_model_roster_committed() -> None:
    roster = json.loads(
        (Path(__file__).resolve().parent / "models.json").read_text()
    )
    assert len(roster["models"]) >= 5
    assert len(roster["edit_models"]) >= 3
