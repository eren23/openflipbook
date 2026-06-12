"""Matrix-bench chassis gate (free): cell identity, cache hit/miss, the
budget refusal order (charge BEFORE the call), dry-run cost math, Pareto
goldens, prompt rendering, and a full mock-provider end-to-end — the whole
loop without spending a cent."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from tests.matrix_bench._budget import BudgetExceeded, Ledger
from tests.matrix_bench._cache import (
    CellCache,
    JudgeCache,
    cell_key,
    params_sha,
)
from tests.matrix_bench._pareto import (
    aggregate_configs,
    near_best_findings,
    pareto_front,
)
from tests.matrix_bench._record import (
    Cell,
    expand_cells,
    load_sweep,
    render_prompt,
    validate_record,
)
from tests.matrix_bench.runner import Scenario, run_matrix

# --- cell identity ---------------------------------------------------------


def test_cell_key_stable_golden() -> None:
    """The key must NEVER drift across refactors — a drift invalidates every
    cached cell and silently re-bills the whole matrix."""
    key = cell_key("s1", "d" * 12, "graph", "fal-ai/nano-banana", "p" * 12, {"a": 1})
    assert key == cell_key("s1", "d" * 12, "graph", "fal-ai/nano-banana", "p" * 12, {"a": 1})
    assert len(key) == 20
    assert key == "59a039bb0a00651525a2"


def test_cell_key_sensitive_to_every_component() -> None:
    base = ("s1", "d" * 12, "graph", "m", "p" * 12, {"a": 1})
    k0 = cell_key(*base)
    variants = [
        ("s2", "d" * 12, "graph", "m", "p" * 12, {"a": 1}),
        ("s1", "e" * 12, "graph", "m", "p" * 12, {"a": 1}),
        ("s1", "d" * 12, "direct", "m", "p" * 12, {"a": 1}),
        ("s1", "d" * 12, "graph", "m2", "p" * 12, {"a": 1}),
        ("s1", "d" * 12, "graph", "m", "q" * 12, {"a": 1}),
        ("s1", "d" * 12, "graph", "m", "p" * 12, {"a": 2}),
    ]
    assert all(cell_key(*v) != k0 for v in variants)


def test_params_sha_order_insensitive() -> None:
    assert params_sha({"a": 1, "b": 2}) == params_sha({"b": 2, "a": 1})


# --- budget ----------------------------------------------------------------


def test_ledger_charges_before_the_call_and_never_partially() -> None:
    ledger = Ledger(cap_usd=1.0)
    ledger.charge(0.6)
    with pytest.raises(BudgetExceeded):
        ledger.charge(0.5)  # would cross — refused BEFORE any spend
    assert ledger.spent_usd == 0.6  # the failed charge mutated nothing
    ledger.charge(0.4)  # exactly to the cap is fine
    assert ledger.remaining_usd == 0.0


# --- sweep / prompts -------------------------------------------------------


def _sweep(**over: Any) -> dict[str, Any]:
    s: dict[str, Any] = {
        "name": "t",
        "scenarios": ["corpus:*"],
        "arms": ["graph"],
        "models": ["fal-ai/nano-banana"],
        "variants": ["v1"],
        "judges": ["j"],
        "params": {},
        "budget_usd": 1.0,
        "composite_weights": {},
    }
    s.update(over)
    return s


def test_load_sweep_validates(tmp_path: Path) -> None:
    p = tmp_path / "bad.json"
    p.write_text('{"name": "x"}')
    with pytest.raises(ValueError, match="missing keys"):
        load_sweep(p)


def test_expand_cells_scenario_outermost() -> None:
    cells = expand_cells(
        _sweep(models=["m1", "m2"], variants=["v1", "v2"]), ["s1", "s2"]
    )
    assert len(cells) == 8
    # Whole scenarios complete before the next starts (budget-partial runs
    # then cover full scenarios, not a ragged diagonal).
    assert [c.scenario_id for c in cells[:4]] == ["s1"] * 4


def test_render_prompt_fills_and_rejects_missing() -> None:
    assert render_prompt("map of {style}!", style="ink") == "map of ink!"
    with pytest.raises(KeyError, match="style"):
        render_prompt("map of {style}", description="x")


# --- cache -----------------------------------------------------------------


def test_cell_cache_roundtrip_and_corrupt_is_miss(tmp_path: Path) -> None:
    cache = CellCache(tmp_path)
    assert cache.load("k1") is None
    cache.store("k1", {"cell_key": "k1"}, jpeg=b"\xff\xd8jpeg")
    assert cache.load("k1") == {"cell_key": "k1"}
    assert cache.image_path("k1").read_bytes() == b"\xff\xd8jpeg"
    (tmp_path / "k1" / "record.json").write_text("{not json")
    assert cache.load("k1") is None  # corrupt = miss, the cell just re-runs


def test_judge_cache_roundtrip(tmp_path: Path) -> None:
    jc = JudgeCache(tmp_path)
    assert jc.load("j1") is None
    jc.store("j1", {"score": 7.0})
    assert jc.load("j1") == {"score": 7.0}


# --- pareto ----------------------------------------------------------------


def _rec(model: str, variant: str, quality: float, cost: float, lat: float) -> dict[str, Any]:
    return {
        "model": model,
        "prompt_variant": variant,
        "scores": {"composite": quality},
        "cost_usd": {"total": cost},
        "timing_s": {"gen": lat},
    }


def test_pareto_front_drops_dominated() -> None:
    configs = aggregate_configs(
        [
            _rec("pro", "v1", 0.9, 0.15, 12.0),
            _rec("nano", "v1", 0.85, 0.04, 5.0),
            _rec("mid", "v1", 0.80, 0.08, 10.0),  # dominated by nano everywhere
        ]
    )
    front = pareto_front(configs)
    names = {c["model"] for c in front}
    assert names == {"pro", "nano"}


def test_near_best_findings_surfaces_the_tradeoff() -> None:
    configs = aggregate_configs(
        [
            _rec("pro", "v1", 0.9, 0.15, 12.0),
            _rec("nano", "v1", 0.85, 0.04, 5.0),
        ]
    )
    findings = near_best_findings(configs)
    assert len(findings) == 1
    assert "nano @ v1" in findings[0]
    assert "94% of the best" in findings[0]
    assert "27% of its cost" in findings[0]


# --- the loop, end to end (mock providers, $0) ------------------------------


def _scenario() -> Scenario:
    return Scenario(id="s1", desc_sha="d" * 12, payload={"style": "ink"})


def _prompts(tmp_path: Path) -> Path:
    d = tmp_path / "prompts"
    d.mkdir()
    (d / "v1.txt").write_text("map in {style}")
    return d


def test_dry_run_estimates_without_calling_anything(tmp_path: Path) -> None:
    calls: list[str] = []

    def gen(cell: Cell, payload: Any, template: str) -> dict[str, Any]:
        calls.append("gen")
        return {"jpeg": b"x", "model": cell.model, "inputs": {}}

    report = run_matrix(
        [_scenario()],
        _sweep(),
        gen_fn=gen,
        judge_fns={"j": lambda c, p, b: (0.5, 0.005)},
        live=False,
        cache=CellCache(tmp_path / "cache"),
        prompts_dir=_prompts(tmp_path),
        report_path=tmp_path / "report.json",
        log=lambda s: None,
    )
    assert calls == []  # dry-run touches nothing paid
    assert report["live"] is False
    # nano-banana $0.039 + 1 judge x $0.005
    assert report["to_bill_usd"] == pytest.approx(0.044)
    assert report["cells"][0]["status"] == "would_run"
    assert (tmp_path / "report.json").exists()


def test_live_mock_end_to_end_then_full_cache_hit(tmp_path: Path) -> None:
    gen_calls: list[str] = []

    def gen(cell: Cell, payload: Any, template: str) -> dict[str, Any]:
        gen_calls.append(cell.label)
        return {
            "jpeg": b"\xff\xd8fake",
            "model": cell.model,
            "inputs": {"prompt_text": render_prompt(template, **payload)},
        }

    def judge(cell: Cell, payload: Any, jpeg: bytes) -> tuple[float, float]:
        return 7.5, 0.005

    def score(
        cell: Cell, payload: Any, outputs: dict[str, Any], judges: dict[str, float]
    ) -> dict[str, float]:
        return {**judges, "composite": judges["j"] / 10.0}

    kwargs: dict[str, Any] = dict(
        gen_fn=gen,
        judge_fns={"j": judge},
        score_fn=score,
        cache=CellCache(tmp_path / "cache"),
        prompts_dir=_prompts(tmp_path),
        report_path=tmp_path / "report.json",
        run_at="2026-06-12T00:00:00Z",
        log=lambda s: None,
    )
    first = run_matrix([_scenario()], _sweep(), live=True, **kwargs)
    assert gen_calls == ["s1/graph/fal-ai/nano-banana/v1"]
    rec = first["cells"][0]
    assert validate_record(rec) == []
    assert rec["scores"]["composite"] == pytest.approx(0.75)
    assert rec["inputs"]["prompt_text"] == "map in ink"
    assert rec["cost_usd"]["total"] == pytest.approx(0.039 + 0.005)
    assert first["stopped_reason"] is None

    second = run_matrix([_scenario()], _sweep(), live=True, **kwargs)
    assert gen_calls == ["s1/graph/fal-ai/nano-banana/v1"]  # no re-bill
    assert second["to_bill_usd"] == 0.0
    assert second["cells"][0]["cell_key"] == rec["cell_key"]


def test_preflight_refuses_over_cap_unless_partial(tmp_path: Path) -> None:
    def gen(cell: Cell, payload: Any, template: str) -> dict[str, Any]:
        return {"jpeg": b"x", "model": cell.model, "inputs": {}}

    sweep = _sweep(models=["fal-ai/nano-banana-pro"], budget_usd=0.01)
    kwargs: dict[str, Any] = dict(
        gen_fn=gen,
        judge_fns={"j": lambda c, p, b: (1.0, 0.005)},
        cache=CellCache(tmp_path / "cache"),
        prompts_dir=_prompts(tmp_path),
        report_path=tmp_path / "report.json",
        log=lambda s: None,
    )
    with pytest.raises(BudgetExceeded, match="trim the sweep"):
        run_matrix([_scenario()], sweep, live=True, **kwargs)
    # allow_partial runs to the cap, then stops with a reason — no raise.
    report = run_matrix(
        [_scenario()], sweep, live=True, allow_partial=True, **kwargs
    )
    assert report["stopped_reason"] is not None
    assert report["cells"] == []


def test_live_refuses_unimplemented_judges(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="no implementation"):
        run_matrix(
            [_scenario()],
            _sweep(judges=["ghost"]),
            gen_fn=lambda c, p, t: {"jpeg": b"x", "inputs": {}},
            judge_fns={},
            live=True,
            cache=CellCache(tmp_path / "cache"),
            prompts_dir=_prompts(tmp_path),
            log=lambda s: None,
        )


# --- report aggregation ------------------------------------------------------


def test_summary_tables_pareto_and_spend() -> None:
    from tests.matrix_bench.report import format_summary, summarize

    def cell(model: str, variant: str, q: float, img: float, lat: float) -> dict[str, Any]:
        return {
            "model": model,
            "prompt_variant": variant,
            "scores": {"composite": q},
            "cost_usd": {"image": img, "judges": 0.015, "extract": 0.01,
                         "total": img + 0.025},
            "timing_s": {"gen": lat, "judges": 2.0},
        }

    report = {
        "cells": [
            cell("pro", "v1", 0.9, 0.15, 12.0),
            cell("nano", "v1", 0.85, 0.039, 5.0),
            cell("mid", "v1", 0.7, 0.08, 10.0),  # dominated
            {"cell_key": "x", "label": "broken", "status": "failed", "error": "boom"},
        ]
    }
    s = summarize(report)
    by = {(c["model"], c["variant"]): c for c in s["configs"]}
    assert by[("pro", "v1")]["pareto"] and by[("nano", "v1")]["pareto"]
    assert not by[("mid", "v1")]["pareto"]
    assert s["failed_cells"] == 1 and s["scored_cells"] == 3
    assert s["spend_usd"]["image"] == pytest.approx(0.269)
    text = format_summary(s)
    assert "nano @ v1" in text and "tradeoffs:" in text and "1 failed" in text
