"""Multi-model leaderboard for the click bench.

Runs the click bench once per model and renders a markdown table — the
"which VLMs actually ground a tap" artifact. The heavy lifting (load, annotate,
call the resolver, score) is the existing `runner.run_bench`; this just loops it
across models and aggregates the summaries.

CLI::

    cd apps/modal-backend
    .venv/bin/python -m tests.click_bench.leaderboard \
        --fixtures tests/click_bench/fixtures/synthetic.json \
        --models google/gemini-3-flash-preview,qwen/qwen3-vl-8b-instruct \
        --out tests/click_bench/reports/leaderboard.md

Needs OPENROUTER_API_KEY (each model runs a real VLM call per case). With the
multi-provider PR merged you can also bench local models by setting
LLM_PROVIDER/LLM_BASE_URL before invoking.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import statistics
from pathlib import Path
from typing import Any

from .runner import run_bench

# Metrics that vary run-to-run (VLM non-determinism) — these get mean±stdev
# across `--runs`. Count keys (n, n_*) are deterministic, carried from run 1.
_AGG_METRICS = (
    "subject_pass_rate",
    "composite_mean",
    "composite_median",
    "rejection_recall",
    "groundable_accuracy",
    "latency_p50_ms",
    "latency_p95_ms",
    "latency_mean_ms",
)


def aggregate_summaries(summaries: list[dict[str, Any]]) -> dict[str, Any]:
    """Fold N per-run summaries into one: each varying metric becomes its mean,
    with a parallel `std` map (sample stdev, 0.0 for a single run). Counts are
    carried from the first run. Pure — the denoise math for `--runs`."""
    if not summaries:
        return {"runs": 0}
    out: dict[str, Any] = dict(summaries[0])
    std: dict[str, float] = {}
    for key in _AGG_METRICS:
        vals = [
            s[key]
            for s in summaries
            if isinstance(s.get(key), (int, float)) and not isinstance(s.get(key), bool)
        ]
        if not vals:
            continue
        out[key] = round(statistics.mean(vals), 4)
        std[key] = round(statistics.stdev(vals), 4) if len(vals) > 1 else 0.0
    out["runs"] = len(summaries)
    out["std"] = std
    return out

_HEADERS = [
    "Model",
    "n",
    "Subject pass",
    "Composite",
    "Rejection recall",
    "Groundable acc",
    "p50 ms",
]


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _fmt_pct(v: Any, sd: Any = None) -> str:
    if not _is_number(v):
        return "—"
    tail = f" ±{sd * 100:.0f}" if _is_number(sd) and sd > 0 else ""
    return f"{v * 100:.0f}%{tail}"


def _fmt_num(v: Any, nd: int = 3, sd: Any = None) -> str:
    if not _is_number(v):
        return "—"
    tail = f" ±{sd:.{nd}f}" if _is_number(sd) and sd > 0 else ""
    return f"{v:.{nd}f}{tail}"


def _row_cells(row: dict[str, Any]) -> list[str]:
    s = row.get("summary", {})
    # `std` present only for multi-run (aggregate_summaries); single runs render
    # byte-identically because every std lookup returns None.
    std = s.get("std", {})
    return [
        str(row.get("model", "?")),
        str(s.get("n", "—")),
        _fmt_pct(s.get("subject_pass_rate"), std.get("subject_pass_rate")),
        _fmt_num(s.get("composite_mean"), sd=std.get("composite_mean")),
        _fmt_pct(s.get("rejection_recall"), std.get("rejection_recall")),
        _fmt_pct(s.get("groundable_accuracy"), std.get("groundable_accuracy")),
        _fmt_num(s.get("latency_p50_ms"), nd=0, sd=std.get("latency_p50_ms")),
    ]


def render_markdown(rows: list[dict[str, Any]]) -> str:
    """Render leaderboard rows ({model, summary}) as a markdown table, sorted
    by subject pass rate descending. Tolerant of summaries missing any metric."""
    ordered = sorted(
        rows,
        key=lambda r: r.get("summary", {}).get("subject_pass_rate") or 0.0,
        reverse=True,
    )
    lines = [
        "| " + " | ".join(_HEADERS) + " |",
        "| " + " | ".join("---" for _ in _HEADERS) + " |",
    ]
    for r in ordered:
        lines.append("| " + " | ".join(_row_cells(r)) + " |")
    return "\n".join(lines)


async def run_leaderboard(
    fixtures_path: Path,
    models: list[str],
    *,
    runs: int = 1,
    reports_dir: Path | None = None,
) -> list[dict[str, Any]]:
    """Run the bench `runs` times per model and return rows ready for
    render_markdown. With runs>1 each row's summary is the mean±stdev across
    runs (VLM click resolution is non-deterministic — one run can't rank)."""
    rows: list[dict[str, Any]] = []
    for model in models:
        slug = model.replace("/", "_")
        summaries: list[dict[str, Any]] = []
        for i in range(max(1, runs)):
            suffix = "" if runs == 1 else f".run{i + 1}"
            out_path = reports_dir / f"{slug}{suffix}.json" if reports_dir else None
            report = await run_bench(
                fixtures_path, model_override=model, out_path=out_path
            )
            summaries.append(report.summary)
        summary = aggregate_summaries(summaries) if runs > 1 else summaries[0]
        rows.append({"model": model, "summary": summary})
    return rows


def _cli() -> None:
    parser = argparse.ArgumentParser(description="click-bench multi-model leaderboard")
    parser.add_argument(
        "--fixtures",
        type=Path,
        default=Path(__file__).parent / "fixtures" / "v1.json",
    )
    parser.add_argument(
        "--models",
        type=str,
        required=True,
        help="comma-separated VLM slugs to bench",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="write the markdown table here (also printed to stdout)",
    )
    parser.add_argument(
        "--runs",
        type=int,
        default=1,
        help="runs per model; >1 reports mean±stdev (denoises VLM variance)",
    )
    args = parser.parse_args()

    if not os.environ.get("OPENROUTER_API_KEY"):
        raise SystemExit("OPENROUTER_API_KEY is required to run the leaderboard.")

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    reports_dir = args.out.parent / "models" if args.out else None
    rows = asyncio.run(
        run_leaderboard(args.fixtures, models, runs=args.runs, reports_dir=reports_dir)
    )
    md = render_markdown(rows)
    print(md)
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(md + "\n")


if __name__ == "__main__":
    _cli()
