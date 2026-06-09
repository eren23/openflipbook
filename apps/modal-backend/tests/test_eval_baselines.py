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


def test_regression_is_not_ok_others_are() -> None:
    assert compare("layout_fidelity", 0.10, 2).ok is False
    assert compare("layout_fidelity", 0.33, 2).ok is True
    assert compare("layout_fidelity", 0.60, 2).ok is True  # improvement isn't a failure
