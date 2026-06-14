"""Matrix report aggregation — the tradeoff surface, readable.

Takes a run report (matrix_latest.json / recon_latest.json), aggregates
cells into configs (model x prompt-variant), prints the per-config table,
the Pareto front, the near-best findings ("94% of the best composite at
27% of its cost, 2.4x faster") and the per-operation spend breakdown —
then writes the summary back into the report file.

    .venv/bin/python -m tests.matrix_bench.report [path/to/report.json]

Pure aggregation over recorded cells: running it costs $0, always.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from tests.matrix_bench._pareto import (
    aggregate_configs,
    near_best_findings,
    pareto_front,
)

_DEFAULT = Path(__file__).resolve().parent / "reports" / "matrix_latest.json"

_SPEND_OPS = ("image", "judges", "extract")


def summarize(report: dict[str, Any]) -> dict[str, Any]:
    cells = [c for c in report.get("cells", []) if "scores" in c]
    configs = aggregate_configs(cells)
    front = pareto_front(configs)
    front_keys = {(c["model"], c["variant"]) for c in front}
    spend = {
        op: round(sum(float(c["cost_usd"].get(op, 0.0)) for c in cells), 4)
        for op in _SPEND_OPS
    }
    spend["total"] = round(sum(spend.values()), 4)
    composites = [
        float(c["scores"]["composite"])
        for c in cells
        if "composite" in c.get("scores", {})
    ]
    return {
        "configs": [
            {**c, "pareto": (c["model"], c["variant"]) in front_keys}
            for c in configs
        ],
        "findings": near_best_findings(configs),
        "spend_usd": spend,
        "scored_cells": len(cells),
        "failed_cells": sum(
            1 for c in report.get("cells", []) if c.get("status") == "failed"
        ),
        # Single per-run composite for the regression gate (bench_compare).
        "composite_mean": (
            round(sum(composites) / len(composites), 4) if composites else None
        ),
        "n_composite": len(composites),
    }


def format_summary(summary: dict[str, Any]) -> str:
    lines = [
        f"{'config':46} {'n':>3} {'quality':>8} {'$/cell':>7} {'sec':>6}  pareto"
    ]
    for c in summary["configs"]:
        label = f"{c['model']} @ {c['variant']}"
        lines.append(
            f"{label[:46]:46} {c['n']:>3} {c['quality']:>8.3f} "
            f"{c['cost_usd']:>7.3f} {c['latency_s']:>6.1f}  "
            f"{'*' if c['pareto'] else ''}"
        )
    if summary["findings"]:
        lines.append("tradeoffs:")
        lines.extend(f"  {f}" for f in summary["findings"])
    s = summary["spend_usd"]
    lines.append(
        f"spend this run: ${s['total']:.2f} "
        f"(image ${s['image']:.2f} / judges ${s['judges']:.2f} / "
        f"extract ${s['extract']:.2f}) over {summary['scored_cells']} cells"
        + (f", {summary['failed_cells']} failed" if summary["failed_cells"] else "")
    )
    return "\n".join(lines)


def attach_summary(report_path: Path) -> dict[str, Any]:
    """Summarize a written report and persist the summary back into it."""
    report = json.loads(report_path.read_text())
    summary = summarize(report)
    report["summary"] = summary
    report_path.write_text(json.dumps(report, indent=1))
    return summary


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else _DEFAULT
    if not path.exists():
        print(f"no report at {path} — run a sweep first (make eval-matrix)")
        return 1
    print(format_summary(attach_summary(path)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
