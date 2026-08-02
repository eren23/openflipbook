"""Coordinate-scale coercion for VLM-emitted image positions.

VLMs mix normalized fractions, percentages and per-mille values in the same
reply. Keep the ladder deterministic at every parse boundary so geometry does
not silently turn pixel-looking coordinates into edge-clamped boxes.
"""
from __future__ import annotations

from typing import Any


def coerce_unit(
    value: Any,
    *,
    clamp: bool = True,
    percent: bool = False,
    drop_beyond_ladder: bool = False,
) -> float | None:
    """Coerce a coordinate-ish value to [0,1].

    With ``percent=True``: (2,100] is treated as percent, (100,1000] as
    per-mille, and values beyond 1000 can be dropped instead of clamped when the
    caller cannot know the source image pixel dimensions.
    """
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    if percent and 2.0 < f <= 100.0:
        f = f / 100.0
    elif percent and 100.0 < f <= 1000.0:
        f = f / 1000.0
    elif percent and drop_beyond_ladder and abs(f) > 1000.0:
        return None
    if f < 0.0:
        return 0.0 if clamp else None
    if f > 1.0:
        return 1.0 if clamp else None
    return f
