"""(place, scale, enter_as) -> the deliberate camera. Pure + table-driven.

No env reads, no I/O. generate.py gates with VIEW_GRAMMAR and passes plain
values; this module never sees a request object. All wording lives in
camera.py / instructions.py — policy emits ViewSpec dicts only.

Dead signals (audited, never consulted here): entity height (constant 4 for
every extraction seed), observer eye_height/pitch/fov (synthesized constants),
level "street"/"building" (the height>=12 gate can never fire). The trusted
signals, in cascade order: an explicit "eye" level pill; the click
classifier's place_kind (locale-proof); the focus entity's kind; the
English word tables (fallback); a REAL footprint; the scale-ladder rung.

Policy never picks isometric: auto-establishing is oblique (the proven aerial
register); isometric is an aesthetic with a known 3D-render drift trap, so it
is pill-only (the user opts in).
"""
from __future__ import annotations

import re

from providers.prompt_library.types import ViewSpec

# SCALE_LADDER mirror (packages/config; coarsest->finest). Membership only.
_ASTRO_TIERS = frozenset({"universe", "galaxy", "star_system"})
_EYE_TIERS = frozenset({"room", "object"})
# Deliberately conservative (V1 red-team: word tables are English-only, so an
# unmatched non-English interior at tier "place"/"district" must fall to the
# safe eye_level default, not become an aerial establishing shot).
_ESTABLISHING_TIERS = frozenset({"planet", "world", "region", "city"})

_NON_PLACE_KINDS = frozenset({"person", "item", "creature"})

# Place-type word tables (lowercase; single words match on \b, phrases on
# substring). English-only FALLBACK — the classifier's locale-proof
# place_kind wins over these. Tunable lists; adding a word is not a
# behavior-contract change.
_INTERIOR_WORDS: tuple[str, ...] = (
    "room", "hall", "chamber", "tavern", "inn", "pub", "bar", "shop", "store",
    "library", "kitchen", "cellar", "vault", "study", "bedroom", "workshop",
    "forge", "office", "cabin", "hut", "cottage", "tent", "sanctum", "crypt",
    "throne room", "great hall", "interior", "inside",
)
_COMPLEX_WORDS: tuple[str, ...] = (
    "castle", "fortress", "citadel", "keep", "palace", "campus", "university",
    "harbor", "harbour", "port", "docks", "shipyard", "market", "square",
    "plaza", "bazaar", "village", "town", "city", "district", "quarter",
    "garden", "park", "monastery", "abbey", "cathedral", "temple complex",
    "arena", "stadium", "farm", "estate", "manor", "ruins", "necropolis",
)

_PERSPECTIVE_SEED_FOOTPRINT = (6.0, 6.0)  # A1: deriveGeo perspective constant — not real
_MAP_FRAME_W = 100.0  # MAP_IMAGE_FRAME width (geo-tap.ts)
_COMPLEX_FRAC, _TINY_FRAC = 0.10, 0.02


def _spec(
    projection: str,
    pitch: float,
    height: str | None,
    azimuth: float | None = None,
    source: str = "policy",
) -> ViewSpec:
    out: ViewSpec = {"projection": projection, "pitch_deg": pitch, "source": source}
    if height is not None:
        out["camera_height"] = height
    if azimuth is not None:
        out["azimuth_deg"] = azimuth
    return out


def top_down_map() -> ViewSpec:
    """The LOCKED root-map camera: flat 2D plan, stated every render.
    azimuth 0 = the north-at-top map pin."""
    return _spec("top_down", -90.0, "aerial", azimuth=0.0)


def oblique_establishing() -> ViewSpec:
    """The castle register: 2.5D high-angle establishing shot."""
    return _spec("oblique", -45.0, "aerial")


def eye_level_scene() -> ViewSpec:
    """The interior register — today's eval-proven enter, stated explicitly."""
    return _spec("eye_level", 0.0, "eye")


def _matches(text: str, words: tuple[str, ...]) -> bool:
    return any(
        (" " in w and w in text)
        or (" " not in w and re.search(rf"\b{re.escape(w)}\b", text))
        for w in words
    )


def default_view(
    *,
    render_mode: str | None,
    world_mode: bool,
    level: str | None = None,
    scale_tier: str | None = None,
    has_observer: bool = False,
    has_region: bool = False,
    enter_as: str | None = None,
    place_form: str | None = None,
    subject: str | None = None,
    subject_context: str | None = None,
    focus_kind: str | None = None,
    focus_footprint: tuple[float, float] | None = None,
) -> ViewSpec | None:
    """The deliberate camera for a render, or None (legacy bytes).

    enter_as is accepted but no cell branches on it — render_mode already
    encodes the same decision; a second switch for the same fact is how the
    audit's dead gates were born."""
    del enter_as
    rmode = (render_mode or "").strip().lower()
    if rmode == "scale_parent":
        # OUTWARD fresh container: containers are maps (the ascend route mints
        # level map / observer null); astro rungs get no architectural register.
        tier = (scale_tier or "").strip().lower()
        return None if tier in _ASTRO_TIERS else top_down_map()
    if rmode == "place_scene":
        return _scene_view(
            level,
            scale_tier,
            place_form,
            subject,
            subject_context,
            focus_kind,
            focus_footprint,
        )
    if rmode == "place_submap":
        # WITH a region crop this is a Kontext zoom-continue: projection is
        # dictated by the reference pixels (preserve-form rides the inherited
        # view on the wire, not policy). WITHOUT one it is a FRESH map render
        # — the describe-a-place ROOT lands here (V1 finding 1) — and gets the
        # locked flat top-down camera. Non-world callers never see camera
        # text (the invariant), whatever render_mode they claim.
        if not world_mode:
            return None
        return None if has_region else top_down_map()
    if rmode == "":
        # Query path: the only world-map cell. Map-shaped = no observer pose.
        is_map_shaped = not has_observer and level in (None, "map")
        if world_mode and is_map_shaped:
            return top_down_map()
        return None
    return None  # explainer, unknown render modes: legacy bytes


def _scene_view(
    level: str | None,
    scale_tier: str | None,
    place_form: str | None,
    subject: str | None,
    subject_context: str | None,
    focus_kind: str | None,
    focus_footprint: tuple[float, float] | None,
) -> ViewSpec | None:
    # S1 — the only meaningful level pill (street/building are dead constants).
    if (level or "").lower() == "eye":
        return eye_level_scene()
    # S2 — you don't establish-shot a character/item.
    if (focus_kind or "").lower() in _NON_PLACE_KINDS:
        return eye_level_scene()
    # S3'/S4' — the classifier's locale-proof read (V1 finding 6) beats words.
    pk = (place_form or "").strip().lower()
    if pk == "interior":
        return eye_level_scene()
    if pk in ("complex", "landscape"):
        return oblique_establishing()
    # S3/S4 — English word-table fallback; interior beats complex on conflict
    # ("the castle's great hall" -> eye level).
    text = " ".join(s for s in (subject, subject_context) if s).lower()
    if text and _matches(text, _INTERIOR_WORDS):
        return eye_level_scene()
    if text and _matches(text, _COMPLEX_WORDS):
        return oblique_establishing()
    # S5 — footprint is the ONE trustworthy geometric size signal (A1), and
    # only when it isn't the perspective-seed constant.
    if focus_footprint:
        w, d = float(focus_footprint[0]), float(focus_footprint[1])
        if w > 0 and d > 0 and (w, d) != _PERSPECTIVE_SEED_FOOTPRINT:
            frac = max(w, d) / _MAP_FRAME_W
            if frac >= _COMPLEX_FRAC:
                return oblique_establishing()
            if frac <= _TINY_FRAC:
                return eye_level_scene()
    # S6 — the scale-ladder rung (conservative set, see _ESTABLISHING_TIERS).
    tier = (scale_tier or "").strip().lower()
    if tier in _EYE_TIERS:
        return eye_level_scene()
    if tier in _ESTABLISHING_TIERS:
        return oblique_establishing()
    if tier in _ASTRO_TIERS:
        return None
    # S7 — the unknown default: eye level, stated explicitly. Today's
    # eval-proven enter behavior (9.33/10 medium), now deliberate; escalation
    # to an establishing shot requires positive large-scale evidence.
    return eye_level_scene()


# --- The estimator bridge -----------------------------------------------------

_EST_PROJECTION = {
    "top_down": "top_down",
    "oblique": "oblique",
    "perspective": "eye_level",
}


def estimate_to_view_spec(est: dict[str, object]) -> ViewSpec:
    """The view ESTIMATOR's read-out of a rendered image, as a ViewSpec.

    Minimal on purpose: projection + pitch only — never fabricate
    camera_height/azimuth the estimator didn't measure. isometric is
    unreachable from estimates (the estimator reads iso renders as oblique,
    which is the correct conformance band)."""
    proj = _EST_PROJECTION.get(str(est.get("projection", "")).lower(), "top_down")
    try:
        pitch = float(est.get("pitch_deg", -90.0))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        pitch = -90.0
    return {"projection": proj, "pitch_deg": pitch, "source": "estimated"}
