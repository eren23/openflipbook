"""Multi-hop drift chain bench — map → closeup → enter (Risk #1).

Wraps ladder-proof artifacts with numeric judges. Dry-run lists scenarios;
live scores an existing ladder-proof run directory.

    make chain-bench-dry
    LADDER_RUN=ladder-proof-runs/<ts> make chain-bench
"""
from __future__ import annotations

import json
import os
import statistics
from pathlib import Path


def _ladder_run_dir() -> Path | None:
    env = os.environ.get("LADDER_RUN", "")
    if env:
        p = Path(env)
        return p if p.is_absolute() else Path.cwd() / p
    repo = Path(__file__).resolve().parents[4]
    runs = repo / "ladder-proof-runs"
    if not runs.exists():
        return None
    dirs = sorted([d for d in runs.iterdir() if d.is_dir()], reverse=True)
    return dirs[0] if dirs else None


def summarize_hops(rows: list[dict]) -> dict:
    hop2 = [r["hop2_step_in"] for r in rows if r.get("hop2_step_in") is not None]
    hop1_cont = [r["hop1_continuation"] for r in rows if r.get("hop1_continuation") is not None]
    return {
        "n_cases": len(rows),
        "hop1_continuation_mean": round(statistics.mean(hop1_cont), 3) if hop1_cont else None,
        "hop2_step_in_mean": round(statistics.mean(hop2), 3) if hop2 else None,
    }


def main() -> int:
    live = os.environ.get("CHAIN_BENCH_RUN") == "1"
    run_dir = _ladder_run_dir()

    if not live or not run_dir:
        print("chain_bench: dry-run — expected hops: map → closeup → enter")
        for sid in ("city", "castle", "harbor", "forest", "scifi"):
            print(f"  {sid}")
        print("\nRun: make ladder-proof && CHAIN_BENCH_RUN=1 LADDER_RUN=<dir> make chain-bench")
        return 0

    scores_file = run_dir / "scores.json"
    if not scores_file.exists():
        print(f"scoring via ladder_judge on {run_dir}")
        os.environ.setdefault("WORLD_BENCH_JUDGE_MODEL", "google/gemini-3-flash-preview")
        import asyncio

        from tests.ladder_judge import _run

        return asyncio.run(_run(run_dir))

    rows = json.loads(scores_file.read_text())
    summary = summarize_hops(rows)
    out = {"scenarios": rows, "summary": summary}
    (run_dir / "chain_summary.json").write_text(json.dumps(out, indent=2))
    print(json.dumps(summary, indent=2))

    if summary.get("hop2_step_in_mean") is not None:
        from tests._baseline import compare, load_baselines

        if "continuity" in load_baselines():
            v = compare("continuity", summary["hop2_step_in_mean"], summary["n_cases"])
            print(f"baseline: {v.status} — {v.detail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
