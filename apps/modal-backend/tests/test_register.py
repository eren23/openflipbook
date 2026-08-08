"""Unit tests for the prod register entry point (providers.register).

The fit + fit-health gate are golden-tested through the recon bench
(tests/recon_bench/test_recon.py, which now imports them from here). These pin
`register_positions` — the read-side use that snaps a fresh render's detections
onto the persistent-world frame.
"""
from __future__ import annotations

import pytest

from providers.register import register_positions


def _drift(p: tuple[float, float], s: float = 0.65, dx: float = 18.0, dy: float = 14.0):
    return (s * p[0] + dx, s * p[1] + dy)


def test_register_positions_healthy_snaps_to_world_frame() -> None:
    # A coherent global drift (scale 0.65 + shift) of the stored world. The fit
    # is healthy, so recurring entities snap back to ~their world positions and a
    # NEW entity (only this render sees it) is placed by the SAME transform.
    world = {"a": (20.0, 10.0), "b": (70.0, 40.0), "c": (40.0, 50.0), "d": (30.0, 20.0)}
    detected = {k: _drift(v) for k, v in world.items()}
    detected["e"] = _drift((55.0, 25.0))  # a new entity, not yet in the world
    out = register_positions(world, detected)
    assert out is not None
    for k in world:
        assert out[k] == pytest.approx(world[k], abs=0.5)
    assert out["e"] == pytest.approx((55.0, 25.0), abs=0.5)  # invert of its drift


def test_register_positions_clamped_scale_returns_none() -> None:
    # True scale 3.0 saturates the fitter — inverting is the -35 hazard, so skip.
    world = {"a": (20.0, 10.0), "b": (70.0, 40.0), "c": (40.0, 50.0), "d": (30.0, 20.0)}
    detected = {k: (3.0 * v[0] + 5, 3.0 * v[1] + 5) for k, v in world.items()}
    assert register_positions(world, detected) is None


def test_register_positions_scatter_returns_none() -> None:
    # In-range scale but the layout doesn't fit any global similarity (high
    # residual) — the scrambled case; keep raw.
    world = {"a": (10.0, 10.0), "b": (50.0, 30.0), "c": (90.0, 50.0), "d": (30.0, 45.0)}
    detected = {"a": (25.0, -5.0), "b": (35.0, 45.0), "c": (105.0, 35.0), "d": (15.0, 60.0)}
    assert register_positions(world, detected) is None


def test_register_positions_too_few_matches_returns_none() -> None:
    # Only 2 labels shared — can't over-determine the 4-DOF fit; keep raw.
    world = {"a": (20.0, 10.0), "b": (70.0, 40.0)}
    detected = {"a": _drift((20.0, 10.0)), "b": _drift((70.0, 40.0)), "c": _drift((40.0, 50.0))}
    assert register_positions(world, detected) is None
