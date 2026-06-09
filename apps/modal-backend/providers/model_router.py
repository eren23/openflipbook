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
    # B2 OUTWARD: a centered BRIA outpaint (reuses the bria slot) paints the
    # container around the source; the medium-flip hop is a tier-based fresh gen.
    "outpaint_zoomout": ("fal-ai/bria/expand", "FAL_OUTPAINT_MODEL"),
    "scale_parent_fresh": (None, None),
    "inpaint": ("fal-ai/flux-pro/v1/fill", "FAL_INPAINT_MODEL"),
    "upscale": ("fal-ai/clarity-upscaler", "FAL_UPSCALE_MODEL"),
}

# Mirrors SCALE_LADDER in packages/config (coarsest→finest); kept in sync by hand
# (the rungs are stable). Used only to classify an OUTWARD hop's medium.
_SCALE_LADDER: tuple[str, ...] = (
    "universe", "galaxy", "star_system", "planet", "world", "region",
    "city", "district", "place", "room", "object",
)


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


def _tier_index(tier: str) -> int:
    try:
        return _SCALE_LADDER.index(tier)
    except ValueError:
        return -1


def coarser_tier(tier: str) -> str | None:
    """The rung one step OUTWARD (coarser) on the ladder, or None if already at the
    coarsest (universe) or the tier is unknown. The OUTWARD branch picks the target
    rung with this."""
    i = _tier_index(tier)
    return _SCALE_LADDER[i - 1] if i > 0 else None


def _is_medium_flip(from_tier: str, to_tier: str) -> bool:
    """A hop crosses the surface↔astronomical boundary when its COARSER endpoint is
    star_system or coarser — a planet surface becomes an orbital/starfield view,
    which a seamless outpaint can't paint. Unknown rungs default to same-plane (the
    safe outpaint path)."""
    fi, ti = _tier_index(from_tier), _tier_index(to_tier)
    if fi < 0 or ti < 0:
        return False
    return min(fi, ti) <= _tier_index("star_system")


def select_outward_op(from_tier: str, to_tier: str) -> str:
    """Pure: which OUTWARD op synthesizes the container that holds the source.

    A same-plane surface hop (city→region) is a centered BRIA outpaint
    (`outpaint_zoomout`) — the source's pixels are preserved and become the central
    sub-region of a wider frame, so style is conserved by construction. A
    medium-flip hop (planet→star_system) can't be outpainted into a new framing, so
    it's a reference-conditioned fresh gen (`scale_parent_fresh`, the riskier path,
    gated SCALE_OUTWARD_RERENDER). `resolve_model()` maps the label to a slug."""
    return "scale_parent_fresh" if _is_medium_flip(from_tier, to_tier) else "outpaint_zoomout"
