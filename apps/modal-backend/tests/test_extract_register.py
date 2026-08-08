"""§4 Step 3b — the extract-seam pose register wire (_register_detection_centres).

The register geometry + gate are tested in tests/test_register.py; these pin the
generate.py wire: prior positions ↔ this render's detections get remapped onto
the world frame when the fit is healthy, and left raw otherwise. The endpoint
gates the whole thing behind POSE_REGISTER_FIX (default off) — off is a no-op.
"""
from __future__ import annotations

import pytest

from generate import PriorEntity, _register_detection_centres


def _pe(name: str, x: float, y: float) -> PriorEntity:
    return PriorEntity(kind="place", name=name, x_pct=x, y_pct=y)


def _det(x: float, y: float) -> dict:
    return {"label": "", "x_pct": x, "y_pct": y, "w_pct": 0.1, "h_pct": 0.08, "score": 0.9}


def test_register_detection_centres_healthy_snaps_to_world() -> None:
    # This render drew the world under a coherent global drift (scale 0.65 +
    # shift). A healthy fit snaps every recurring centre back to its stored
    # world position; the detector's box size (w/h) is untouched.
    world = {"a": (0.2, 0.2), "b": (0.7, 0.7), "c": (0.4, 0.5), "d": (0.3, 0.3)}
    prior = [_pe(n, x, y) for n, (x, y) in world.items()]
    s, dx, dy = 0.65, 0.18, 0.14
    by_label = {n: _det(s * x + dx, s * y + dy) for n, (x, y) in world.items()}
    n = _register_detection_centres(by_label, prior)
    assert n == 4
    for name, (x, y) in world.items():
        assert by_label[name]["x_pct"] == pytest.approx(x, abs=0.02)
        assert by_label[name]["y_pct"] == pytest.approx(y, abs=0.02)
    assert by_label["a"]["w_pct"] == 0.1 and by_label["a"]["h_pct"] == 0.08  # size kept


def test_register_detection_centres_no_prior_positions_is_noop() -> None:
    # Prior entities without stored positions can't anchor a fit → raw centres
    # stand (the first-visit / not-yet-localized case).
    prior = [PriorEntity(kind="place", name=n) for n in ("a", "b", "c")]
    by_label = {"a": _det(0.3, 0.3), "b": _det(0.6, 0.6), "c": _det(0.4, 0.45)}
    before = {k: (v["x_pct"], v["y_pct"]) for k, v in by_label.items()}
    assert _register_detection_centres(by_label, prior) == 0
    assert {k: (v["x_pct"], v["y_pct"]) for k, v in by_label.items()} == before
