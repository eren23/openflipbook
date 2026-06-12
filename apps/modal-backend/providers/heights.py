"""Pure height inference + scoring — the segmenter's brain. No I/O.

ABSOLUTE meters come from an ANCHORED RELATIVE LADDER, never from map
pixels: map symbology draws buildings oversized (a house spans a district's
worth of world units), so world-unit sizes are not metric. The segmenter
gives each entity rel_height (0..1 of the tallest visible); ONE anchor with
a known absolute height scales the whole ladder. Anchor resolution order:

  1. an AUTHORED height (corpus ground truth / user-set) — most trusted;
  2. a CATEGORY PRIOR (a person is ~1.7 m, a tower ~25 m);
  3. the VLM's own est_height_m guesses (median entity) — last resort.

scale_tier provides a sanity BAND only: flags, never silent clamps.
"""
from __future__ import annotations

from math import log2
from typing import TypedDict


class HeightInput(TypedDict, total=False):
    label: str
    rel_height: float  # 0..1 of the tallest visible (segmenter output)
    est_height_m: float | None  # the VLM's raw absolute guess
    visual: str


# Mirrors SCALE_TIER_METERS in packages/config (kept in sync by hand, like
# model_router._SCALE_LADDER): the characteristic EXTENT of a frame at each
# rung — the ceiling for how tall anything inside it can plausibly be.
_TIER_METERS: dict[str, float] = {
    "universe": 8.8e26,
    "galaxy": 9.5e20,
    "star_system": 1.5e13,
    "planet": 1.3e7,
    "world": 1.3e7,
    "region": 3e5,
    "city": 1.5e4,
    "district": 1.5e3,
    "place": 1.2e2,
    "room": 1.0e1,
    "object": 1.0e0,
}

# Keyword → meters, FIRST match wins (ordered specific → generic). Coarse on
# purpose: the prior anchors a ladder, it doesn't measure a building.
CATEGORY_PRIORS: tuple[tuple[str, float], ...] = (
    ("person", 1.7),
    ("figure", 1.7),
    ("door", 2.1),
    ("lighthouse", 30.0),
    ("skyscraper", 150.0),
    ("cathedral", 40.0),
    ("church", 20.0),
    ("temple", 18.0),
    ("tower", 25.0),
    ("castle", 20.0),
    ("palace", 18.0),
    ("fortress", 15.0),
    ("hall", 12.0),
    ("warehouse", 10.0),
    ("tavern", 8.0),
    ("house", 8.0),
    ("shop", 8.0),
    ("hut", 4.0),
    ("cottage", 5.0),
    ("tent", 3.0),
    ("gate", 8.0),
    ("wall", 6.0),
    ("bridge", 10.0),
    ("fountain", 5.0),
    ("statue", 6.0),
    ("ship", 15.0),
    ("boat", 4.0),
    ("tree", 12.0),
    ("forest", 15.0),
    ("hill", 60.0),
    ("mountain", 800.0),
)


def prior_height_m(label: str, visual: str = "") -> float | None:
    """Category prior for an entity, by keyword over label + appearance."""
    text = f"{label} {visual}".lower()
    for keyword, meters in CATEGORY_PRIORS:
        if keyword in text:
            return meters
    return None


def resolve_anchor(
    entities: list[HeightInput],
    authored: dict[str, float] | None = None,
) -> tuple[str, float, float] | None:
    """(anchor_label, anchor_height_m, anchor_rel) or None when nothing in
    the frame carries a usable absolute. Order: authored > prior > VLM est."""
    usable = [e for e in entities if float(e.get("rel_height", 0.0)) > 0.0]
    if authored:
        for e in usable:
            label = str(e.get("label", ""))
            if label in authored and authored[label] > 0:
                return label, authored[label], float(e["rel_height"])
    for e in usable:
        prior = prior_height_m(str(e.get("label", "")), str(e.get("visual", "")))
        if prior is not None:
            return str(e["label"]), prior, float(e["rel_height"])
    with_est = [
        e for e in usable
        if isinstance(e.get("est_height_m"), (int, float)) and float(e["est_height_m"] or 0) > 0
    ]
    if with_est:
        with_est.sort(key=lambda e: float(e["est_height_m"] or 0))
        mid = with_est[len(with_est) // 2]
        return str(mid["label"]), float(mid["est_height_m"] or 0), float(mid["rel_height"])
    return None


def infer_heights_m(
    entities: list[HeightInput],
    authored: dict[str, float] | None = None,
) -> dict[str, float]:
    """Absolute meters per label: the relative ladder scaled off one anchor.
    Entities with rel_height 0 (the segmenter saw no height) are skipped.
    No anchor at all → fall back to each entity's own raw est_height_m."""
    anchor = resolve_anchor(entities, authored)
    out: dict[str, float] = {}
    if anchor is None:
        for e in entities:
            est = e.get("est_height_m")
            if isinstance(est, (int, float)) and est > 0:
                out[str(e["label"])] = float(est)
        return out
    _, anchor_m, anchor_rel = anchor
    for e in entities:
        rel = float(e.get("rel_height", 0.0))
        if rel <= 0.0:
            continue
        out[str(e["label"])] = anchor_m * (rel / anchor_rel)
    return out


def tier_sanity_band(scale_tier: str | None) -> tuple[float, float]:
    """Plausible absolute heights for entities INSIDE a frame at this rung —
    the ceiling is the rung's characteristic extent (a `place`-tier courtyard
    can't contain a 5 km spire). Unknown tier → effectively unbounded."""
    ceiling = _TIER_METERS.get(scale_tier or "")
    return (0.1, ceiling) if ceiling else (0.1, float("inf"))


def flag_implausible(
    heights_m: dict[str, float], scale_tier: str | None
) -> list[str]:
    """Human-readable flags for heights outside the tier band. Flags only —
    the caller decides; nothing is clamped silently."""
    lo, hi = tier_sanity_band(scale_tier)
    return [
        f"{label}: {h:.1f} m outside [{lo:.1f}, {hi:.1f}] for tier "
        f"{scale_tier or '?'}"
        for label, h in sorted(heights_m.items())
        if not (lo <= h <= hi)
    ]


def height_order_score(
    expected_m: dict[str, float], observed_m: dict[str, float]
) -> float:
    """Pairwise order agreement over labels present in BOTH (is the tower
    still taller than the house?). Expected ties are skipped. Fewer than 2
    comparable labels → 0.0: nothing demonstrably right earns no credit."""
    common = sorted(set(expected_m) & set(observed_m))
    agree = total = 0
    for i, a in enumerate(common):
        for b in common[i + 1:]:
            if expected_m[a] == expected_m[b]:
                continue
            total += 1
            if (expected_m[a] > expected_m[b]) == (observed_m[a] > observed_m[b]):
                agree += 1
    return agree / total if total else 0.0


def height_abs_score(
    expected_m: dict[str, float], observed_m: dict[str, float]
) -> float:
    """Fraction of common labels whose absolute height lands within x2 of
    ground truth (|log2(obs/exp)| <= 1) — generous on purpose; absolute
    height from one image is an estimate, not a measurement. No common
    labels → 0.0."""
    common = [
        k for k in expected_m
        if k in observed_m and expected_m[k] > 0 and observed_m[k] > 0
    ]
    if not common:
        return 0.0
    hits = sum(1 for k in common if abs(log2(observed_m[k] / expected_m[k])) <= 1.0)
    return hits / len(common)
