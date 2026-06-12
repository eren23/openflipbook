"""Per-operation image-model router.

Every image operation has a default model and an env override, and a pure
`select_operation` decides which op a tap generation uses: a sub-map with a
region crop zoom-continues (a faithful Kontext zoom of the map); entering a
place routes through an EDIT endpoint (the only path where the parent-region
ref actually bites); everything else is a fresh generation.

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
    # Entering a place: an instruction-driven EDIT of the tapped region crop —
    # nano edit slugs honour image_urls (verified via scripts/verify-fal-models.py)
    # and tolerate a view change, where Kontext strict-zooms. The enter eval
    # (tests/continuity_bench/enter_runner.py) A/Bs the candidates.
    "enter_scene": ("fal-ai/nano-banana-pro/edit", "FAL_ENTER_MODEL"),
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

    Stepping INSIDE a place (`place_scene`) is a view CHANGE — overhead map to
    ground level — routed through an EDIT endpoint conditioned on the tapped
    region crop. Fresh text-to-image is NOT an option here: fal's text-to-image
    endpoints accept-but-ignore reference images (research/01), so a "fresh,
    reference-conditioned" scene was really an unconditioned reinvention —
    different walls/shapes every time. The edit endpoint is where refs bite;
    the instruction (build_enter_instruction) carries the view change. The call
    site still needs a source image, hence no has_region condition here — it
    falls back to fresh only when there is nothing to condition on.

    Everything else is a fresh generation. (outpaint/inpaint/upscale are invoked
    explicitly by callers — the repair loop — not chosen here.)"""
    if render_mode in ("place_submap", "place_closeup") and has_region:
        return "zoom_continue"
    if render_mode == "place_scene":
        return "enter_scene"
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


# Steep view TRANSFORMS (an overhead map crop re-rendered at eye level or as a
# closer plan) land ~2.5/10 on the nano family — it drifts back to its aerial
# attractor — but 8/10 on gpt-image-2/edit, at equal same-place fidelity
# (view-bench A/B, 2026-06-10). Aerial registers (oblique/isometric) are 9-10
# on BOTH, so the cheaper incumbent keeps those.
STEEP_ENTER_PROJECTIONS = frozenset({"eye_level", "top_down"})
STEEP_ENTER_DEFAULT = "openai/gpt-image-2/edit"


def select_enter_model(projection: str | None) -> str | None:
    """The enter model for a deliberate camera: steep transforms route to the
    gpt family (FAL_ENTER_MODEL_STEEP override); everything else — including
    the legacy no-view enter — keeps the enter_scene slot."""
    if projection in STEEP_ENTER_PROJECTIONS:
        return os.environ.get("FAL_ENTER_MODEL_STEEP") or STEEP_ENTER_DEFAULT
    return resolve_model("enter_scene")


# ── Capability registry + fallback chains (Wave 4) ───────────────────────────
# Data, not behavior: what each slug can do, what it costs, how it fails over.
# Longest-prefix matching (same posture as providers/spend.py's price table);
# costs mirror docs/COSTS.md — spend.py owns the billing copy of these numbers.

from dataclasses import dataclass  # noqa: E402


@dataclass(frozen=True)
class ModelCaps:
    label: str  # short human name for pickers
    supports_edit: bool  # honours an image input as an EDIT target
    supports_refs: bool  # honours reference images on fresh generation
    legible_text: bool  # renders crisp in-image labels (the map-text gotcha)
    est_cost: float  # $/image, ≈ docs/COSTS.md
    est_latency_s: float  # typical wall-clock per image


CAPABILITIES: tuple[tuple[str, ModelCaps], ...] = (
    ("fal-ai/nano-banana-pro", ModelCaps("nano-banana-pro", True, True, True, 0.15, 25)),
    ("fal-ai/nano-banana-2", ModelCaps("nano-banana-2", True, True, True, 0.08, 18)),
    ("fal-ai/nano-banana", ModelCaps("nano-banana", True, True, False, 0.039, 10)),
    ("fal-ai/flux-pro/kontext", ModelCaps("flux kontext", True, False, True, 0.04, 20)),
    ("fal-ai/flux-pro/v1/fill", ModelCaps("flux fill (inpaint)", True, False, True, 0.10, 25)),
    ("fal-ai/bria", ModelCaps("bria expand", True, False, True, 0.04, 15)),
    ("openrouter:sourceful/riverflow-v2.5-pro", ModelCaps("riverflow pro", False, False, True, 0.24, 150)),
    ("openai/gpt-image-2", ModelCaps("gpt-image-2", True, False, True, 0.17, 90)),
)


def capabilities_for(slug: str) -> ModelCaps | None:
    s = (slug or "").lower()
    best: ModelCaps | None = None
    best_len = -1
    for prefix, caps in CAPABILITIES:
        if s.startswith(prefix) and len(prefix) > best_len:
            best, best_len = caps, len(prefix)
    return best


def registry() -> list[dict[str, object]]:
    """The picker payload: every known slug with its caps. Served by
    GET /models for the dev model dropdown."""
    return [
        {
            "slug": prefix,
            "label": caps.label,
            "supports_edit": caps.supports_edit,
            "supports_refs": caps.supports_refs,
            "legible_text": caps.legible_text,
            "est_cost": caps.est_cost,
            "est_latency_s": caps.est_latency_s,
        }
        for prefix, caps in CAPABILITIES
    ]


# Fresh-generation failover order (PROVIDER_FALLBACK=1): when a slug's call
# fails terminally, the next one takes the prompt. Chains step DOWN in cost —
# a degraded page beats an error frame, and the final's image_model says
# honestly which model actually rendered. Fresh-gen only by design: edit /
# continue ops carry semantics (refs, masks) a substitute may not honour.
FALLBACK_CHAINS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("openrouter:sourceful/riverflow-v2.5-pro", ("fal-ai/nano-banana-pro", "fal-ai/nano-banana")),
    ("fal-ai/nano-banana-pro", ("fal-ai/nano-banana-2", "fal-ai/nano-banana")),
    ("fal-ai/nano-banana-2", ("fal-ai/nano-banana",)),
    ("fal-ai/nano-banana", ("fal-ai/nano-banana-2",)),
)


def fallback_chain(slug: str) -> tuple[str, ...]:
    s = (slug or "").lower()
    best: tuple[str, ...] = ()
    best_len = -1
    for prefix, chain in FALLBACK_CHAINS:
        if s.startswith(prefix) and len(prefix) > best_len:
            best, best_len = chain, len(prefix)
    return tuple(c for c in best if c != slug)
