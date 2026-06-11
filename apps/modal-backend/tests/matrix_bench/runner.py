"""Matrix bench chassis — scenarios x arms x models x prompt-variants.

DRY-RUN IS THE DEFAULT. Without MATRIX_BENCH_RUN=1 the runner walks the
sweep, resolves the cache, prints the per-cell table (cached? / est $) and
the total to-bill figure, touches no network, and exits 0 — that table is
the mandatory cost preview AND the free CI smoke. With MATRIX_BENCH_RUN=1
it runs uncached cells through injected gen/extract/judge functions, hard-
capped by the budget ledger (charge BEFORE every paid call).

Run it (standalone, .env auto-loaded, judge pinned to Gemini):
    cd apps/modal-backend && .venv/bin/python -m tests.matrix_bench.runner
or:  make eval-matrix-dry   /   make eval-matrix

Scenario types plug in via `run_matrix(scenarios=...)` — the recon bench
(tests/recon_bench) registers the map-corpus scenarios; the chassis itself
is scenario-agnostic and fully testable with mock functions.
"""
from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tests.matrix_bench._budget import JUDGE_CALL_FLAT, BudgetExceeded, Ledger
from tests.matrix_bench._cache import CellCache, cell_key, text_sha
from tests.matrix_bench._record import (
    SWEEPS_DIR,
    Cell,
    expand_cells,
    load_prompt,
    load_sweep,
    new_record,
)

_REPORTS = Path(__file__).resolve().parent / "reports"

# Extraction (detector + segmenter + view estimate) — flat, mirrors spend.py's
# honest-coarse style.
EXTRACT_FLAT = 0.01

# gen_fn(cell, scenario_payload, prompt_template) -> {"jpeg": bytes,
#   "model": str, "inputs": {...}}  (inputs = the rendered prompt + refs etc.)
GenFn = Callable[[Cell, Any, str], dict[str, Any]]
# judge_fn(cell, scenario_payload, jpeg) -> (score, cost_usd)
JudgeFn = Callable[[Cell, Any, bytes], tuple[float, float]]
# extract_fn(cell, scenario_payload, jpeg) -> (outputs dict, cost_usd)
ExtractFn = Callable[[Cell, Any, bytes], tuple[dict[str, Any], float]]
# score_fn(cell, scenario_payload, outputs, judge_scores) -> scores (incl composite)
ScoreFn = Callable[[Cell, Any, dict[str, Any], dict[str, float]], dict[str, float]]


@dataclass(frozen=True)
class Scenario:
    id: str
    desc_sha: str  # digest of the scenario's ground truth — part of cell identity
    payload: Any = None  # opaque to the chassis; scenario types interpret


def estimate_cell(
    cell: Cell, n_judges: int, has_extract: bool
) -> float:
    from providers import spend

    return (
        spend.estimate_image(cell.model)
        + n_judges * JUDGE_CALL_FLAT
        + (EXTRACT_FLAT if has_extract else 0.0)
    )


def _table(rows: list[tuple[Cell, bool, float]]) -> str:
    lines = [f"{'cell':60} {'cached':>6} {'est $':>7}"]
    for cell, cached, est in rows:
        lines.append(f"{cell.label[:60]:60} {'yes' if cached else 'no':>6} {est:>7.3f}")
    return "\n".join(lines)


def run_matrix(
    scenarios: list[Scenario],
    sweep: dict[str, Any],
    *,
    gen_fn: GenFn,
    judge_fns: dict[str, JudgeFn] | None = None,
    extract_fn: ExtractFn | None = None,
    score_fn: ScoreFn | None = None,
    live: bool = False,
    allow_partial: bool = False,
    cache: CellCache | None = None,
    ledger: Ledger | None = None,
    prompts_dir: Path | None = None,
    report_path: Path | None = None,
    run_at: str = "",
    log: Callable[[str], None] = print,
) -> dict[str, Any]:
    judge_fns = judge_fns or {}
    missing_judges = [j for j in sweep["judges"] if j not in judge_fns]
    if live and missing_judges:
        raise ValueError(f"sweep names judges with no implementation: {missing_judges}")
    cache = cache or CellCache()
    by_id = {s.id: s for s in scenarios}
    cells = expand_cells(sweep, [s.id for s in scenarios])

    # Resolve every cell against the cache BEFORE any spend — the preview.
    resolved: list[tuple[Cell, str, str, dict[str, Any] | None, float]] = []
    for cell in cells:
        template = load_prompt(cell.variant, prompts_dir)
        psha = text_sha(template)
        key = cell_key(
            cell.scenario_id, by_id[cell.scenario_id].desc_sha,
            cell.arm, cell.model, psha, cell.params,
        )
        cached = cache.load(key)
        est = (
            0.0
            if cached is not None
            else estimate_cell(cell, len(sweep["judges"]), extract_fn is not None)
        )
        resolved.append((cell, key, psha, cached, est))

    to_bill = round(sum(est for *_, est in resolved), 4)
    log(_table([(c, cached is not None, est) for c, _, _, cached, est in resolved]))
    log(f"total to-bill: ${to_bill:.2f} ({sum(1 for *_, c, _ in resolved if c is None)} uncached cells)")

    report: dict[str, Any] = {
        "sweep": sweep["name"],
        "run_at": run_at,
        "live": live,
        "to_bill_usd": to_bill,
        "cells": [],
        "stopped_reason": None,
    }

    if not live:
        report["cells"] = [
            cached
            if cached is not None
            else {"cell_key": key, "status": "would_run", "label": cell.label,
                  "est_usd": round(est, 4)}
            for cell, key, _, cached, est in resolved
        ]
        _write_report(report, report_path)
        return report

    ledger = ledger or Ledger(cap_usd=float(sweep["budget_usd"]))
    if to_bill > ledger.remaining_usd + 1e-9 and not allow_partial:
        raise BudgetExceeded(
            f"sweep needs ${to_bill:.2f} but only ${ledger.remaining_usd:.2f} "
            "remains under the cap — trim the sweep, raise MATRIX_BUDGET_USD, "
            "or set MATRIX_ALLOW_PARTIAL=1 to run until the cap"
        )

    for cell, key, psha, cached, est in resolved:
        if cached is not None:
            report["cells"].append(cached)
            continue
        try:
            ledger.charge(est)
        except BudgetExceeded:
            report["stopped_reason"] = f"budget exhausted before {cell.label}"
            log(f"STOP: {report['stopped_reason']}")
            break

        # One flaky provider call must not torch the rest of the sweep (paid
        # cells already cached stay cached; this cell records its failure and
        # re-runs next time — its charge stays spent, honestly).
        try:
            scenario = by_id[cell.scenario_id]
            template = load_prompt(cell.variant, prompts_dir)
            timing: dict[str, float] = {}
            cost: dict[str, float] = {}

            t0 = time.monotonic()
            gen = gen_fn(cell, scenario.payload, template)
            timing["gen"] = time.monotonic() - t0
            jpeg: bytes = gen["jpeg"]
            from providers import spend

            cost["image"] = spend.estimate_image(gen.get("model") or cell.model)

            outputs: dict[str, Any] = {"model": gen.get("model") or cell.model}
            if extract_fn is not None:
                t0 = time.monotonic()
                extracted, ex_cost = extract_fn(cell, scenario.payload, jpeg)
                timing["extract"] = time.monotonic() - t0
                cost["extract"] = ex_cost
                outputs.update(extracted)

            judge_scores: dict[str, float] = {}
            t0 = time.monotonic()
            judge_cost = 0.0
            for name in sweep["judges"]:
                score, j_cost = judge_fns[name](cell, scenario.payload, jpeg)
                judge_scores[name] = score
                judge_cost += j_cost
            timing["judges"] = time.monotonic() - t0
            cost["judges"] = judge_cost

            scores = (
                score_fn(cell, scenario.payload, outputs, judge_scores)
                if score_fn is not None
                else dict(judge_scores)
            )

            record = new_record(
                cell,
                cell_id=key,
                run_at=run_at,
                prompt_sha=psha,
                desc_sha=scenario.desc_sha,
                inputs=dict(gen.get("inputs", {})),
                outputs=outputs,
                timing_s=timing,
                cost_usd=cost,
                scores=scores,
                cache={"image": "miss", "judges": "miss"},
            )
        except Exception as exc:
            err = f"{type(exc).__name__}: {exc}"
            log(f"FAILED {cell.label}: {err}")
            report["cells"].append(
                {"cell_key": key, "label": cell.label, "status": "failed", "error": err}
            )
            continue
        cache.store(key, record, jpeg)
        report["cells"].append(record)
        log(f"ran {cell.label}: scores={scores} (${record['cost_usd']['total']:.3f})")

    report["spent_usd"] = round(ledger.spent_usd, 4)
    _write_report(report, report_path)
    return report


def _write_report(report: dict[str, Any], path: Path | None) -> None:
    out = path or (_REPORTS / "matrix_latest.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1))


def _load_env() -> None:
    """Best-effort .env load + pin the judge to Gemini (not the .env's qwen
    VLM, which rate-limits — see memory project_qwen_ratelimit)."""
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    os.environ.setdefault("WORLD_BENCH_JUDGE_MODEL", "google/gemini-3-flash-preview")


def main() -> int:
    _load_env()
    sweep_path = Path(os.environ.get("MATRIX_SWEEP", "")) if os.environ.get(
        "MATRIX_SWEEP"
    ) else SWEEPS_DIR / "default.json"
    sweep = load_sweep(sweep_path)
    if os.environ.get("MATRIX_BUDGET_USD"):
        sweep["budget_usd"] = float(os.environ["MATRIX_BUDGET_USD"])

    # Scenario providers register here as they land. "corpus:*" → the
    # map-corpus reconstruction scenarios (tests/recon_bench, PR B4).
    try:
        from tests.recon_bench.runner import corpus_scenarios, recon_fns
    except ImportError:
        print(
            "matrix: no scenario providers available yet — the recon bench "
            "(tests/recon_bench) registers the map-corpus scenarios. "
            "Sweep + cache + budget validated; nothing to run."
        )
        return 0

    scenarios = corpus_scenarios(sweep["scenarios"])
    fns = recon_fns(sweep)
    report = run_matrix(
        scenarios,
        sweep,
        live=os.environ.get("MATRIX_BENCH_RUN") == "1",
        allow_partial=os.environ.get("MATRIX_ALLOW_PARTIAL") == "1",
        run_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        **fns,
    )
    return 0 if report.get("stopped_reason") is None else 1


if __name__ == "__main__":
    raise SystemExit(main())
