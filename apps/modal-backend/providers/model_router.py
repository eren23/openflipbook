"""Per-operation image-model router.

Every image operation has a default model and an env override, and a pure
`select_operation` decides which op a tap generation uses: entering a place or a
sub-map with a region crop zoom-continues (a faithful Kontext zoom of the map);
everything else is a fresh generation.

`outpaint`/`inpaint`/`upscale` slots are declared for the verify→repair loop
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
    """Which image operation a tap generation uses.

    A sub-map (`place_submap`) with a region crop ZOOM-CONTINUES the map (Kontext)
    — a faithful, style-preserving closer MAP of the SAME walls/buildings the map
    shows, from the same overhead viewpoint.

    Stepping INSIDE a place (`place_scene`) is a view CHANGE — exterior to interior
    — which a strict zoom can't do (Kontext just zooms the crop, the "did you only
    zoom in?" failure). So a scene is a FRESH, reference-conditioned generation: it
    renders the interior while the region crop + the place's appearance keep its
    architecture, materials and style continuous with the map.

    Everything else is a fresh generation. (outpaint/inpaint/upscale are invoked
    explicitly by callers — the repair loop — not chosen here.)"""
    if render_mode == "place_submap" and has_region:
        return "zoom_continue"
    return "fresh"
