"""Compare latest bench reports against committed eval_baselines.json."""
from __future__ import annotations

import json
from pathlib import Path

from tests._baseline import compare, load_baselines

_REPORT_DIRS = [
    Path(__file__).resolve().parent / "reports",
    Path(__file__).resolve().parent.parent / "world_bench" / "reports",
    Path(__file__).resolve().parent.parent / "continuity_bench" / "reports",
    Path(__file__).resolve().parent.parent / "recon_bench" / "reports",
]

_METRIC_MAP = {
    "layout_latest.json": ("layout_fidelity", "mean_lift", "n_cases"),
    "style_latest.json": ("style_medium_lock", "mean_lift", "n_cases"),
    "grounding_latest.json": ("grounding", "grounding_mean", "n_cases"),
    "enter_latest.json": ("enter_same_place", "mean_lift", "n_cases"),
    # lab_latest.json is handled specially: per-sweep composite gate below.
    "lab_latest.json": None,
}


def _compare_lab(path: Path) -> bool:
    """Gate the scenario-lab composite against a per-sweep baseline named
    `lab_<sweep>`. If no baseline is committed yet, print the composite so it
    can be promoted — never silently pass an ungated run."""
    report = json.loads(path.read_text())
    summary = report.get("summary", {})
    sweep = report.get("sweep", "?")
    mean = summary.get("composite_mean")
    n = int(summary.get("n_composite", 0) or 0)
    if mean is None:
        print(f"{path}: no composite scores (sweep={sweep}) — nothing to gate")
        return False
    baseline_name = f"lab_{sweep}"
    if baseline_name not in load_baselines():
        print(
            f"{path}: NO BASELINE for {baseline_name} — "
            f"composite={float(mean):.3f} over n={n}; commit one to gate it"
        )
        return False
    verdict = compare(baseline_name, float(mean), n)
    print(f"{path}: {verdict.status} — {verdict.detail}")
    return verdict.status == "REGRESSION"


def main() -> int:
    any_fail = False
    for report_dir in _REPORT_DIRS:
        if not report_dir.exists():
            continue
        for name, spec in _METRIC_MAP.items():
            path = report_dir / name
            if not path.exists():
                continue
            if name == "lab_latest.json":
                any_fail = _compare_lab(path) or any_fail
                continue
            if spec is None:
                continue
            baseline_name, metric_key, n_key = spec
            report = json.loads(path.read_text())
            summary = report.get("summary", {})
            if metric_key not in summary:
                continue
            verdict = compare(baseline_name, float(summary[metric_key]), int(summary[n_key]))
            print(f"{path}: {verdict.status} — {verdict.detail}")
            if verdict.status == "REGRESSION":
                any_fail = True
    return 1 if any_fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
