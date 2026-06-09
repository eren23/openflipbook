"""Baseline-drift guard — pure comparison of a fresh eval metric against the
committed band in eval_baselines.json. No I/O beyond reading that file; never
raises on a normal verdict. A paid runner calls compare() with its fresh metric;
the free test_eval_baselines.py pins this logic + the committed file.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_PATH = Path(__file__).resolve().parent / "eval_baselines.json"


@dataclass(frozen=True)
class Verdict:
    status: str  # PASS | REGRESSION | IMPROVED | LOW_N
    detail: str

    @property
    def ok(self) -> bool:
        return self.status != "REGRESSION"


def load_baselines() -> dict[str, dict[str, Any]]:
    return json.loads(_PATH.read_text())["baselines"]


def compare(name: str, value: float, n: int) -> Verdict:
    """Classify a fresh metric against the committed baseline band."""
    spec = load_baselines()[name]
    if n < int(spec["n_min"]):
        return Verdict("LOW_N", f"{name}: n={n} < n_min={spec['n_min']} — not trustworthy")
    base = float(spec["baseline"])
    band = float(spec["regression_band"])
    if value < base - band:
        return Verdict("REGRESSION", f"{name}: {value:.3f} < {base} - {band} (band floor)")
    if value > base + band:
        return Verdict("IMPROVED", f"{name}: {value:.3f} > {base} + {band} — re-baseline?")
    return Verdict("PASS", f"{name}: {value:.3f} within ±{band} of {base}")
