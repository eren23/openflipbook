"""Pareto analysis over matrix cells — the "90% faster, style a bit off"
tradeoff surface. Pure; golden-tested for free.

Cells aggregate to CONFIGS (model x prompt-variant, means over scenarios);
the front is non-dominated on (quality max, cost min, latency min); findings
are the human sentences the report prints ("nano-banana @ recon_base.v1:
94% of the best composite at 26% of its cost, 2.5x faster").
"""
from __future__ import annotations

from typing import Any


def aggregate_configs(
    records: list[dict[str, Any]], quality_key: str = "composite"
) -> list[dict[str, Any]]:
    """Mean quality/cost/latency per (model, variant) over all its cells."""
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for r in records:
        groups.setdefault((r["model"], r["prompt_variant"]), []).append(r)
    configs: list[dict[str, Any]] = []
    for (model, variant), cells in sorted(groups.items()):
        quals = [c["scores"].get(quality_key) for c in cells]
        quals = [q for q in quals if isinstance(q, (int, float))]
        if not quals:
            continue  # nothing scored — nothing to rank
        costs = [float(c["cost_usd"].get("total", 0.0)) for c in cells]
        lats = [sum(c.get("timing_s", {}).values()) for c in cells]
        n = len(cells)
        configs.append(
            {
                "model": model,
                "variant": variant,
                "n": n,
                "quality": sum(quals) / len(quals),
                "cost_usd": sum(costs) / n,
                "latency_s": sum(lats) / n,
            }
        )
    return configs


def _dominates(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """a beats-or-ties b everywhere and beats it somewhere."""
    ge = (
        a["quality"] >= b["quality"]
        and a["cost_usd"] <= b["cost_usd"]
        and a["latency_s"] <= b["latency_s"]
    )
    gt = (
        a["quality"] > b["quality"]
        or a["cost_usd"] < b["cost_usd"]
        or a["latency_s"] < b["latency_s"]
    )
    return ge and gt


def pareto_front(configs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        c
        for c in configs
        if not any(_dominates(o, c) for o in configs if o is not c)
    ]


def near_best_findings(
    configs: list[dict[str, Any]],
    quality_slack: float = 0.10,
    min_saving: float = 0.30,
) -> list[str]:
    """Configs within `quality_slack` of the best quality that save at least
    `min_saving` (fraction) on cost or latency vs the best-quality config."""
    if not configs:
        return []
    best = max(configs, key=lambda c: c["quality"])
    floor = best["quality"] * (1.0 - quality_slack)
    out: list[str] = []
    for c in configs:
        if c is best or c["quality"] < floor:
            continue
        cost_save = 1.0 - (c["cost_usd"] / best["cost_usd"]) if best["cost_usd"] > 0 else 0.0
        speedup = best["latency_s"] / c["latency_s"] if c["latency_s"] > 0 else 1.0
        if cost_save >= min_saving or speedup >= 1.0 / (1.0 - min_saving):
            pct_q = 100.0 * c["quality"] / best["quality"] if best["quality"] > 0 else 0.0
            pct_c = 100.0 * c["cost_usd"] / best["cost_usd"] if best["cost_usd"] > 0 else 0.0
            out.append(
                f"{c['model']} @ {c['variant']}: {pct_q:.0f}% of the best "
                f"composite ({best['model']} @ {best['variant']}) at "
                f"{pct_c:.0f}% of its cost, {speedup:.1f}x faster"
            )
    return out
