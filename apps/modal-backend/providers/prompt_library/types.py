"""Provider-side twin of the ViewSpec wire shape.

Pydantic validates at the FastAPI boundary (generate.ViewSpec); providers work
on plain dicts via this TypedDict — the same split geometry.py uses for
ProjectedEntity. Field set is parity-locked to packages/config via the
generate.py model + tests/test_geo_schema.py; keep this mirror in step.
"""
from __future__ import annotations

from typing import TypedDict


class _ViewSpecRequired(TypedDict):
    # top_down | oblique | isometric | eye_level
    projection: str


class ViewSpec(_ViewSpecRequired, total=False):
    pitch_deg: float
    azimuth_deg: float
    # "ground" | "eye" | "rooftop" | "aerial" or a metric height in world units.
    camera_height: str | float
    fov_deg: float
    # policy | user | estimated
    source: str
