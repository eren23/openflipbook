#!/usr/bin/env python3
"""The scoreboard, from log lines the backend already writes.

    docker compose logs --no-log-prefix backend | python3 scripts/decisions_report.py
    modal app logs <app> | python3 scripts/decisions_report.py --site render.accept

Per site: how often the decision model agreed with the rule that decides
today, how confident it was when it did not, what it cost, and what would
have happened at each threshold had the site been live. Agreement is not
correctness -- a site that agrees with the incumbent always has learned
nothing -- so the disagreements are printed in full for eyeballing.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from typing import Any

BINS = [(0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 0.9), (0.9, 1.0001)]


def rows(stream: Any, site: str | None, include_mock: bool) -> list[dict[str, Any]]:
    out = []
    for line in stream:
        brace = line.find("{")
        if brace < 0:
            continue
        try:
            rec = json.loads(line[brace:])
        except ValueError:
            continue
        if rec.get("span") != "decision.row":
            continue
        if site and rec.get("site") != site:
            continue
        if rec.get("mock") and not include_mock:
            continue
        out.append(rec)
    return out


def pct(n: float, d: float) -> str:
    return f"{n / d:.0%}" if d else "-"


def calibration(pairs: list[tuple[float, bool]]) -> list[str]:
    """Predicted confidence against how often it was right, in bins."""
    lines = []
    for lo, hi in BINS:
        got = [ok for p, ok in pairs if lo <= p < hi]
        if got:
            mean_p = sum(p for p, _ in pairs if lo <= p < hi) / len(got)
            lines.append(f"    {lo:.1f}-{min(hi, 1.0):.1f}  n={len(got):4d}  said {mean_p:.2f}  was right {sum(got) / len(got):.2f}")
    return lines


def sweep(pairs: list[tuple[float, str, str]]) -> list[str]:
    """If the site were live at each threshold: how often it would fire, and
    how often firing would have contradicted the incumbent."""
    lines = []
    for thr in [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95]:
        fired = [(p, v, inc) for p, v, inc in pairs if p >= thr and v != inc]
        lines.append(f"    thr {thr:.2f}  would fire {len(fired):4d}  ({pct(len(fired), len(pairs))} of rows)")
    return lines


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site")
    ap.add_argument("--include-mock", action="store_true")
    ap.add_argument("--disagreements", type=int, default=5)
    args = ap.parse_args()

    by_site: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows(sys.stdin, args.site, args.include_mock):
        by_site[r["site"]].append(r)
    if not by_site:
        print("no decision rows on stdin (DECISION_MODE unset? mock rows need --include-mock)")
        return

    for site, rs in sorted(by_site.items()):
        errors = [r for r in rs if r.get("error")]
        ok = [r for r in rs if not r.get("error")]
        lat = sorted(r["latency_ms"] for r in ok)
        cost = sum(r.get("cost_usd") or 0.0 for r in rs)
        print(f"\n== {site}   n={len(rs)}  errors={len(errors)}  "
              f"p50={lat[len(lat) // 2] if lat else 0}ms  p95={lat[int(len(lat) * 0.95)] if lat else 0}ms  ${cost:.5f}")
        modes = {r["mode"] for r in rs}
        applied = sum(1 for r in rs if r.get("applied"))
        print(f"   modes={','.join(sorted(modes))}  applied={applied}")

        questions = sorted({q for r in ok for q in (r.get("verdict") or {})})
        for q in questions:
            judged = [r for r in ok if (r["verdict"] or {}).get(q) and (r["incumbent"] or {}).get(q)]
            if not judged:
                continue
            agree = [r for r in judged if r["verdict"][q] == r["incumbent"][q]]
            print(f"   {q}: n={len(judged)}  agreed {pct(len(agree), len(judged))}  "
                  f"disagreed {len(judged) - len(agree)}")
            pairs = [(r["p"].get(q, 0.0), r["verdict"][q] == r["incumbent"][q]) for r in judged]
            for line in calibration(pairs):
                print(line)
            for line in sweep([(r["p"].get(q, 0.0), r["verdict"][q], r["incumbent"][q]) for r in judged]):
                print(line)
            if len(agree) == len(judged) and len(judged) >= 20:
                print("    NOTE: never disagreed in 20+ rows — this site may be echoing the rule; "
                      "check the state carries evidence the rule does not.")
            shown = [r for r in judged if r["verdict"][q] != r["incumbent"][q]]
            shown.sort(key=lambda r: -r["p"].get(q, 0.0))
            for r in shown[: args.disagreements]:
                state = json.dumps(r["state"])[:240]
                print(f"    - p={r['p'].get(q, 0):.2f} said {r['verdict'][q]!r} rule said "
                      f"{r['incumbent'][q]!r} trace={r.get('trace_id')}\n      {state}")


if __name__ == "__main__":
    main()
