"""Estimate a generated image's CAMERA so the geometry layer doesn't assume
top-down (many maps are 2.5D, not flat). One VLM call →
{level, projection, pitch_deg}. Mirrors detector.detect: Gemini-default model,
tolerant parse that falls back to a top-down map and never raises.
"""
from __future__ import annotations

import base64
import os
from typing import Any, Literal, TypedDict, cast

# Mirrors the TS `ViewLevel` / `ViewProjection` unions + `ViewEstimate` shape in
# packages/config/src/index.ts — the camera read-out the geometry layer consumes.
ViewLevel = Literal["map", "building", "street", "eye"]
ViewProjection = Literal["top_down", "oblique", "perspective"]


class ViewEstimate(TypedDict):
    level: ViewLevel
    projection: ViewProjection
    pitch_deg: float
    # Coarse SCALE_LADDER rung (B2). Mirrors the optional `scale_tier?` on the TS
    # ViewEstimate; a free str so the ladder is defined once (packages/config).
    scale_tier: str
    # The model's own 0..1 confidence in the read. Gates whether the estimate
    # is trusted enough to PATCH onto the node's persisted view (C12: >= 0.7);
    # absent/invalid replies coerce to 0.5 — informative but never node truth.
    confidence: float


LEVELS: tuple[ViewLevel, ...] = ("map", "building", "street", "eye")
PROJECTIONS: tuple[ViewProjection, ...] = ("top_down", "oblique", "perspective")

# The SCALE_LADDER rungs (coarsest→finest), mirrored from packages/config. A valid
# scale_tier reply is one of these; anything else falls back off the camera level.
SCALE_TIERS: tuple[str, ...] = (
    "universe", "galaxy", "star_system", "planet", "world", "region",
    "city", "district", "place", "room", "object",
)
# Deterministic rung when the model abstains, keyed off the camera level.
LEVEL_TO_TIER: dict[ViewLevel, str] = {
    "map": "city",
    "building": "place",
    "street": "district",
    "eye": "room",
}

# Safe default when estimation fails: a flat top-down map at the city rung.
DEFAULT_VIEW: ViewEstimate = {
    "level": "map",
    "projection": "top_down",
    "pitch_deg": -90.0,
    "scale_tier": "city",
    "confidence": 0.0,  # a fallback is never trusted as node truth
}


def _model() -> str:
    return os.environ.get(
        "WORLD_BENCH_JUDGE_MODEL",
        os.environ.get("OPENROUTER_VLM_MODEL", "google/gemini-3-flash-preview"),
    )


def parse_view(payload: Any) -> ViewEstimate:
    """Coerce a view-estimate reply into a validated dict. Tolerant: an unknown
    level/projection or a non-numeric pitch falls back to the top-down default.

    `payload` is a raw JSON reply of unknown shape, so it stays `Any`; the
    `in LEVELS` / `in PROJECTIONS` membership checks narrow the validated string
    back to its Literal type (LEVELS/PROJECTIONS are typed tuples)."""
    if not isinstance(payload, dict):
        return cast(ViewEstimate, dict(DEFAULT_VIEW))
    level = str(payload.get("level", "")).strip().lower()
    proj = str(payload.get("projection", "")).strip().lower()
    tier = str(payload.get("scale_tier", "")).strip().lower()
    try:
        pitch = float(payload.get("pitch_deg"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        pitch = -90.0
    valid_level: ViewLevel = level if level in LEVELS else "map"
    try:
        conf = float(payload.get("confidence"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        conf = 0.5  # informative default — below the C12 trust gate
    return {
        "level": valid_level,
        "projection": proj if proj in PROJECTIONS else "top_down",
        "pitch_deg": max(-90.0, min(90.0, pitch)),
        # An unknown/absent rung falls back deterministically off the level, so a
        # fresh session is always seeded with *a* tier (the design's cheap seed).
        "scale_tier": tier if tier in SCALE_TIERS else LEVEL_TO_TIER[valid_level],
        "confidence": max(0.0, min(1.0, conf)),
    }


async def estimate_view(image_bytes: bytes, caption: str = "") -> ViewEstimate:
    """Classify the image's camera. One VLM call; degrades to the top-down default
    on any failure (so callers can always seed *something*)."""
    from providers import llm

    b64 = base64.b64encode(image_bytes).decode("ascii")
    system = (
        "You classify the CAMERA + SCALE of an illustration so a geometry engine "
        "knows how to read positions out of it. Return JSON exactly: "
        '{"level":..,"projection":..,"pitch_deg":..,"scale_tier":..,"confidence":..}.\n'
        "level: map (a top-down or bird's-eye map of an area), building (looking at "
        "a single structure), street (standing within a street/scene), eye "
        "(eye-level on one subject).\n"
        "projection: top_down (straight down, flat), oblique (tilted bird's-eye / "
        "isometric / 2.5D), perspective (ground-level with a vanishing point).\n"
        "pitch_deg: camera tilt from horizontal — -90 straight down, -45 tilted "
        "bird's-eye, 0 level/horizon.\n"
        "scale_tier: the real-world SCALE the frame spans, one of universe, galaxy, "
        "star_system, planet, world, region, city, district, place, room, object "
        "(coarsest→finest).\n"
        "confidence: your own 0..1 confidence in this camera read (1 = certain)."
    )
    user = "Classify this image's camera." + (
        f' Caption: "{caption[:200]}"' if caption else ""
    )
    model = _model()
    client = llm._client()
    messages: list[Any] = [
        {"role": "system", "content": system},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{b64}", "detail": "low"},
                },
            ],
        },
    ]
    try:
        resp = await llm._create_with_retry(
            client,
            model=model,
            messages=messages,
            temperature=0.0,
            max_tokens=300,
            **llm._maybe_response_format(model),
        )
    except Exception as exc:
        # Network/upstream failure — degrade to the default view, loudly.
        from obs import log

        log("warn", "view.estimate_failed", error=f"{type(exc).__name__}: {exc}")
        return cast(ViewEstimate, dict(DEFAULT_VIEW))
    raw = resp.choices[0].message.content or "{}"
    payload, failure = llm.salvage_json(raw)
    if failure is not None:
        from obs import log

        log(
            "warn",
            "view.parse_failed",
            finish_reason=getattr(resp.choices[0], "finish_reason", None),
            failure=failure,
        )
        if not isinstance(payload, dict) or not payload:
            return cast(ViewEstimate, dict(DEFAULT_VIEW))
    return parse_view(payload)
