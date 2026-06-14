"""Free baseline-drift guard: validate the committed eval baselines + the pure
compare() verdicts. The paid runners call compare() with their fresh metric so a
silent eval regression fails loud against the committed band. FREE (no spend)."""
from __future__ import annotations

from tests._baseline import compare, load_baselines


def test_baselines_well_formed() -> None:
    baselines = load_baselines()
    assert baselines, "no eval baselines committed"
    for name, spec in baselines.items():
        for key in ("metric", "baseline", "regression_band", "n_min"):
            assert key in spec, f"{name} missing {key!r}"
        assert float(spec["regression_band"]) > 0, f"{name}: band must be > 0"
        assert int(spec["n_min"]) >= 1, f"{name}: n_min must be >= 1"


def test_compare_verdicts() -> None:
    # layout_fidelity baseline 0.33 ± 0.15
    assert compare("layout_fidelity", 0.33, 2).status == "PASS"
    assert compare("layout_fidelity", 0.10, 2).status == "REGRESSION"
    assert compare("layout_fidelity", 0.60, 2).status == "IMPROVED"
    assert compare("layout_fidelity", 0.33, 1).status == "LOW_N"
    # grounding baseline 0.55 ± 0.15
    assert compare("grounding", 0.55, 2).status == "PASS"
    assert compare("grounding", 0.30, 2).status == "REGRESSION"
    # height_order baseline 0.75 ± 0.15
    assert compare("height_order", 0.75, 3).status == "PASS"
    assert compare("height_order", 0.50, 3).status == "REGRESSION"
    # ux_task_success baseline
    assert compare("ux_task_success", 0.6, 3).status == "PASS"


def test_regression_is_not_ok_others_are() -> None:
    assert compare("layout_fidelity", 0.10, 2).ok is False
    assert compare("layout_fidelity", 0.33, 2).ok is True
    assert compare("layout_fidelity", 0.60, 2).ok is True  # improvement isn't a failure
