"""Numeric judges over a ladder-proof run's artifacts.

    .venv/bin/python -m tests.ladder_judge <run_dir>

For each scenario dir with {1_region_promised.jpg, 2_closeup.jpg, 3_enter.jpg}:
  hop1 (map region → closeup): score_step_in + score_continuation
  hop2 (closeup → enter):      score_step_in
Writes scores.json per scenario and a summary into <run_dir>/scores.json.
Secondary signal only — the eyes-on subagent verdicts are primary.
PAID: ~5 Gemini calls per scenario (~$0.03).
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path


def _load_env() -> None:
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    os.environ.setdefault("WORLD_BENCH_JUDGE_MODEL", "google/gemini-3-flash-preview")


async def _score_dir(d: Path) -> dict | None:
    from providers import judge

    region = d / "1_region_promised.jpg"
    closeup = d / "2_closeup.jpg"
    enter = d / "3_enter.jpg"
    if not closeup.exists():
        return None
    out: dict = {"scenario": d.name}
    if region.exists():
        r = region.read_bytes()
        c = closeup.read_bytes()
        out["hop1_step_in"] = (await judge.score_step_in(r, c)).score
        cont = await judge.score_continuation(r, c)
        out["hop1_continuation"] = cont.score
        out["hop1_rationale"] = cont.rationale
    if enter.exists():
        c = closeup.read_bytes()
        e = enter.read_bytes()
        si = await judge.score_step_in(c, e)
        out["hop2_step_in"] = si.score
        out["hop2_rationale"] = si.rationale
    (d / "scores.json").write_text(json.dumps(out, indent=1))
    return out


async def _run(run_dir: Path) -> int:
    rows = []
    for d in sorted(run_dir.iterdir()):
        if not d.is_dir():
            continue
        row = await _score_dir(d)
        if row:
            rows.append(row)
            print(
                f"{row['scenario']:8} hop1 step_in={row.get('hop1_step_in')} "
                f"cont={row.get('hop1_continuation')} | hop2 step_in={row.get('hop2_step_in')}"
            )
    (run_dir / "scores.json").write_text(json.dumps(rows, indent=1))
    print(f"wrote {run_dir / 'scores.json'}")
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python -m tests.ladder_judge <run_dir>")
        return 2
    _load_env()
    return asyncio.run(_run(Path(sys.argv[1]).resolve()))


if __name__ == "__main__":
    raise SystemExit(main())
