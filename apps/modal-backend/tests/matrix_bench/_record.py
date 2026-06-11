"""Sweep configs, cell expansion, prompt-variant rendering, run records.

Prompt variants are VERSIONED FILES (prompts/<name>.v<N>.txt) with named
{placeholders}; evolution = copy v1 → v2, edit, point the sweep at it. The
old version's cells stay cached, only the new one bills. The run record is
the "inputs/outputs in great detail" requirement: everything needed to
reproduce or audit a cell rides in one JSON object.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"
SWEEPS_DIR = Path(__file__).resolve().parent / "sweeps"

_REQUIRED_SWEEP_KEYS = ("name", "scenarios", "arms", "models", "variants", "judges")


@dataclass(frozen=True)
class Cell:
    scenario_id: str
    arm: str
    model: str
    variant: str  # prompt file stem, e.g. "recon_base.v1"
    params: dict[str, Any] = field(default_factory=dict)

    @property
    def label(self) -> str:
        return f"{self.scenario_id}/{self.arm}/{self.model}/{self.variant}"


def load_sweep(path: Path) -> dict[str, Any]:
    sweep = json.loads(path.read_text())
    missing = [k for k in _REQUIRED_SWEEP_KEYS if k not in sweep]
    if missing:
        raise ValueError(f"sweep {path.name} missing keys: {missing}")
    for k in ("scenarios", "arms", "models", "variants", "judges"):
        if not isinstance(sweep[k], list) or not all(
            isinstance(v, str) for v in sweep[k]
        ):
            raise ValueError(f"sweep {path.name}: '{k}' must be a list of strings")
    sweep.setdefault("params", {})
    sweep.setdefault("budget_usd", 3.0)
    sweep.setdefault("composite_weights", {})
    return sweep


def expand_cells(sweep: dict[str, Any], scenario_ids: list[str]) -> list[Cell]:
    """The full product — scenario order outermost so a budget-partial run
    still covers whole scenarios before starting the next."""
    return [
        Cell(sid, arm, model, variant, dict(sweep.get("params", {})))
        for sid in scenario_ids
        for arm in sweep["arms"]
        for model in sweep["models"]
        for variant in sweep["variants"]
    ]


def load_prompt(variant: str, prompts_dir: Path | None = None) -> str:
    p = (prompts_dir or PROMPTS_DIR) / f"{variant}.txt"
    if not p.exists():
        raise FileNotFoundError(
            f"prompt variant '{variant}' not found at {p} — variants are "
            "versioned files; copy an existing one and bump the version"
        )
    return p.read_text()


class _StrictSlots(dict):
    def __missing__(self, key: str) -> str:
        raise KeyError(
            f"prompt template references {{{key}}} but no value was provided"
        )


def render_prompt(template: str, **slots: str) -> str:
    """Fill named {placeholders}; a referenced-but-missing slot raises (a
    silently empty slot would bill a garbage cell)."""
    return template.format_map(_StrictSlots(slots)).strip()


def new_record(
    cell: Cell,
    *,
    cell_id: str,
    run_at: str,
    prompt_sha: str,
    desc_sha: str,
    inputs: dict[str, Any],
    outputs: dict[str, Any],
    timing_s: dict[str, float],
    cost_usd: dict[str, float],
    scores: dict[str, float],
    cache: dict[str, str],
) -> dict[str, Any]:
    cost = dict(cost_usd)
    cost["total"] = round(sum(cost.values()), 6)
    return {
        "cell_key": cell_id,
        "run_at": run_at,
        "scenario_id": cell.scenario_id,
        "arm": cell.arm,
        "model": cell.model,
        "prompt_variant": cell.variant,
        "prompt_sha": prompt_sha,
        "description_sha": desc_sha,
        "params": cell.params,
        "inputs": inputs,
        "outputs": outputs,
        "timing_s": {k: round(v, 3) for k, v in timing_s.items()},
        "cost_usd": cost,
        "scores": scores,
        "cache": cache,
    }


_REQUIRED_RECORD_KEYS = (
    "cell_key", "run_at", "scenario_id", "arm", "model", "prompt_variant",
    "prompt_sha", "description_sha", "params", "inputs", "outputs",
    "timing_s", "cost_usd", "scores", "cache",
)


def validate_record(record: dict[str, Any]) -> list[str]:
    """Schema lint for tests + report ingestion: missing keys, not errors."""
    return [k for k in _REQUIRED_RECORD_KEYS if k not in record]
