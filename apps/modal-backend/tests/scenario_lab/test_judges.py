"""Free unit tests for the scenario-lab judge wiring added alongside the
live-visual run: POV projection selection, the _NA-renormalising composite,
the cache artifacts (before/after) mechanism, and the composite_mean summary
the regression gate reads. All pure / no network."""
from __future__ import annotations

from tests.matrix_bench import report as report_mod
from tests.matrix_bench._cache import CellCache
from tests.scenario_lab.runner import _NA, _projection_for, lab_fns


def test_projection_for_maps_pov_dimensions() -> None:
    assert _projection_for({"dimensions": ["pov_top_down", "layout"]}) == "top_down"
    assert _projection_for({"dimensions": ["interior", "pov_eye_level"]}) == "eye_level"
    assert _projection_for({"dimensions": ["interior"]}) == "eye_level"
    assert _projection_for({"dimensions": ["pov_oblique"]}) == "oblique"
    # No POV intent declared → None (judge returns _NA, not a 0).
    assert _projection_for({"dimensions": ["layout", "detection"]}) is None


def test_composite_renormalises_over_applied_judges() -> None:
    sweep = {"composite_weights": {"layout_fidelity": 0.5, "view_conformance": 0.5}}
    score_fn = lab_fns(sweep)["score_fn"]

    # Both judges applied → straight weighted mean.
    both = score_fn(None, {}, {}, {"layout_fidelity": 0.8, "view_conformance": 0.6})
    assert both["composite"] == 0.7

    # view_conformance not applicable (_NA) → composite is layout alone, NOT
    # dragged down to 0.4 by averaging in a -1.
    one = score_fn(None, {}, {}, {"layout_fidelity": 0.8, "view_conformance": _NA})
    assert one["composite"] == 0.8


def test_cache_artifacts_roundtrip_and_no_traversal(tmp_path) -> None:
    cache = CellCache(root=tmp_path)
    cache.store(
        "abc123",
        {"cell_key": "abc123"},
        jpeg=b"main-image",
        artifacts={"source.jpg": b"before-bytes", "../escape.jpg": b"nope"},
    )
    assert cache.image_path("abc123").read_bytes() == b"main-image"
    assert cache.artifact_path("abc123", "source.jpg").read_bytes() == b"before-bytes"
    # The traversal attempt was written as a basename inside the cell dir only.
    assert (tmp_path / "abc123" / "escape.jpg").exists()
    assert not (tmp_path / "escape.jpg").exists()


def test_summary_exposes_composite_mean_for_gate() -> None:
    report = {
        "cells": [
            {"scores": {"composite": 0.6}, "cost_usd": {}, "model": "m", "prompt_variant": "v",
             "timing_s": {}},
            {"scores": {"composite": 0.8}, "cost_usd": {}, "model": "m", "prompt_variant": "v",
             "timing_s": {}},
            {"status": "failed"},
        ]
    }
    summary = report_mod.summarize(report)
    assert summary["composite_mean"] == 0.7
    assert summary["n_composite"] == 2
    assert summary["failed_cells"] == 1
