"""Per-operation image-model router.

Generalises the scattered hardcoded model choices into one place: every image
operation has a default model (today's working slug) and an env override, and a
pure `select_operation` decides which op a tap generation uses. The decision is
behaviour-identical to the pre-router code (a sub-map entry with a region crop
zoom-continues; everything else is a fresh generation), so it's a safe refactor.

`outpaint`/`inpaint`/`upscale` slots are declared for the P4 verify→repair loop
(and map-pan reuse) but only activate once their FAL_*_MODEL is set AND a
provider function is wired — `scripts/verify-fal-models.py` confirms the slug
before that. fal-only by design (no ControlNet): geometry steers via the
layout-as-prompt constraints in geometry_prompt, not a structure model.
"""
from __future__ import annotations

import os

# op -> (default model slug or None for tier-based, env override key or None).
MODEL_SLOTS: dict[str, tuple[str | None, str | None]] = {
    "fresh": (None, None),  # tier-based via image.py (FAL_IMAGE_MODEL_*)
    "zoom_continue": ("fal-ai/flux-pro/kontext", "FAL_CONTINUE_MODEL"),
    "outpaint": ("fal-ai/bria/expand", "FAL_OUTPAINT_MODEL"),
    "inpaint": ("fal-ai/flux-pro/v1/fill", "FAL_INPAINT_MODEL"),
    "upscale": ("fal-ai/clarity-upscaler", "FAL_UPSCALE_MODEL"),
}


def resolve_model(op: str) -> str | None:
    """The model slug for an op: env override > default. None when the op is
    tier-based (fresh) or unknown."""
    default, env_key = MODEL_SLOTS.get(op, (None, None))
    if env_key:
        return os.environ.get(env_key) or default
    return default


def select_operation(render_mode: str | None, has_region: bool) -> str:
    """Which image operation a tap generation uses. Matches today's behaviour
    exactly: a `place_submap` entry with a region crop zoom-continues; everything
    else is a fresh generation. (outpaint/inpaint/upscale are invoked explicitly
    by callers — the repair loop — not chosen here.)"""
    if render_mode == "place_submap" and has_region:
        return "zoom_continue"
    return "fresh"
