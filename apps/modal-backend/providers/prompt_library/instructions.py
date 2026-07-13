"""Enter / zoom / outward instruction templates — view- and family-aware.

view=None reproduces the pre-grammar providers/image_edit strings BYTE-FOR-BYTE
(the legacy builders moved here verbatim; image_edit delegates). With a view,
the docs/research/10 per-family skeletons apply — shared shape
[anchor] -> [transform] -> [invariants] -> [medium rider] -> [guards] ->
[SCENE LAYOUT], with the transform register flipped per family:
  nano (Gemini lineage)  scene RE-DESCRIBER; image roles named in text.
  gpt_image              change-first + preserve list + trailing Constraints.
  kontext                preserve-only; a projection change is OUT of its
                         grammar (subject rotates instead) — enter falls back
                         to scene-level phrasing and policy SHOULD route
                         enters to nano instead (research/10 §5, our 3.33/10).
One transform per prompt; the full invariant block restates on every call.
"""
from __future__ import annotations

from providers.prompt_library import camera
from providers.prompt_library.style import (
    LETTERING_GUARD,
    NO_LETTERING,
    medium_lock,
)
from providers.prompt_library.types import ViewSpec

# Gemini-family edits drift aspect without this (research/10 §4.6). Text guard
# belongs on nano/gemini instructions only; gpt gets "Keep the aspect ratio."
# inside its constraints block; Kontext gets neither (512-token frugality).
ASPECT_GUARD = "Do not change the input aspect ratio."

model_family = camera.model_family  # re-export: instructions is the public home

_ENTER_PROJECTIONS = ("eye_level", "oblique", "isometric", "top_down")


# --- Legacy bodies (verbatim moves; the view=None contract) -------------------

def _legacy_zoom_instruction(
    page_title: str,
    facts: list[str],
    layout_clause: str = "",
    register: str = "map",
) -> str:
    """register="map" is the original, golden-pinned string. register="view"
    (place_closeup: zooming into a thing inside a PERSPECTIVE scene) swaps the
    cartographic words for view-neutral ones — same skeleton, the reference
    pixels carry the camera."""
    title = page_title.strip() or "this place"
    noun = "map" if register == "map" else "view"
    viewpoint = (
        "from the SAME overhead map viewpoint"
        if register == "map"
        else "from the SAME viewpoint the reference shows"
    )
    drift = (
        "switch to an eye-level or interior view"
        if register == "map"
        else "change the camera angle or projection"
    )
    text = (
        f'Zoom into "{title}" — the area at the centre of this image — and draw a '
        f"closer, richer {noun} of it. Keep the exact walls, buildings, towers and "
        "landmarks the reference already shows, in the same hand-drawn engraving "
        f"style, palette and line work, {viewpoint}; do "
        f"not reinvent them, restyle them, or {drift}"
        ". As you move closer, elaborate them with finer architectural detail"
    )
    named = [f.strip() for f in facts if f and f.strip()]
    if named:
        text += ", working in the features that belong here: " + "; ".join(named[:8])
    text += (
        f". A closer, faithful continuation of this exact {noun}, not a new scene. "
        "Keep any lettering sparse and legible — no garbled text."
    )
    if layout_clause.strip():
        text += "\n\n" + layout_clause.strip()
    return text.strip()


def _legacy_enter_instruction(
    page_title: str,
    facts: list[str],
    *,
    style_anchor: str | None = None,
    subject_context: str | None = None,
    surroundings: str | None = None,
    layout_clause: str = "",
    surroundings_pov: bool = False,
    surroundings_behind: str | None = None,
    interior: bool = False,
    exterior_appearance: str | None = None,
) -> str:
    title = page_title.strip() or "this place"
    anchor = f'"{title}"'
    if subject_context and subject_context.strip():
        anchor += f" ({subject_context.strip()})"
    if interior:
        # INTERIOR ENTERS: the tapped place is a discrete enterable building —
        # the arrival must be INDOORS, not yet another exterior shot of it.
        text = (
            f"Step through the entrance INTO {anchor} and draw the INDOOR "
            "view from ground level within it — an enclosed interior with "
            "its inner walls, floor and ceiling or rafters visible. NOT the "
            "building's exterior, NOT its facade, NOT the surrounding "
            "streets or grounds. The interior must plausibly belong to the "
            "exact building the image shows: same materials, palette and "
            "construction"
        )
        if exterior_appearance and exterior_appearance.strip():
            text += f" — {exterior_appearance.strip()}"
        text += (
            ", an inner space that fits the building's shell (a round tower "
            "encloses a round chamber; a tall building implies stairs, "
            "galleries or upper floors)"
        )
    else:
        text = (
            f"Step INSIDE {anchor} — the place this image shows — and draw the view "
            "from ground level within it. This is the SAME place seen from the "
            "inside, not a new one and not the overhead map view: keep the exact "
            "architecture, walls, towers, materials, colours and landmarks the "
            "image shows, and reveal what they enclose"
        )
    named = [f.strip() for f in facts if f and f.strip()]
    if named:
        text += ", working in what belongs here: " + "; ".join(named[:8])
    text += "."
    if surroundings_pov:
        text += _pov_surroundings_text(surroundings, surroundings_behind)
    elif surroundings and surroundings.strip():
        text += (
            (
                " Through windows and doorways, keep the neighbours where "
                f"the parent image had them: {surroundings.strip()}"
            )
            if interior
            else (
                " Through openings and beyond the walls, keep the neighbours where "
                f"the map placed them: {surroundings.strip()}"
            )
        )
        if not text.endswith("."):
            text += "."
    text += " Keep the exact art medium of the reference"
    if style_anchor and style_anchor.strip():
        text += f" — {style_anchor.strip()} —"
    text += (
        " same palette and line work; NOT a photograph, no photorealism. "
        "Keep any lettering sparse and legible — no garbled text."
    )
    if layout_clause.strip():
        text += "\n\n" + layout_clause.strip()
    return text.strip()


# --- View-aware fragments ------------------------------------------------------

def _facing_fragment(view: ViewSpec) -> str:
    az = view.get("azimuth_deg")
    if az is None:
        return ""
    return f", facing {camera.compass_word(float(az))}"


def _corner_fragment(view: ViewSpec) -> str:
    """'viewed from the X' wind = opposite of the facing bearing."""
    az = view.get("azimuth_deg")
    if az is None:
        return ""
    return f" from the {camera.compass_word(float(az) + 180.0)}"


def _transform_sentence(view: ViewSpec) -> str:
    """The one view-change sentence (target-state re-description register)."""
    proj = str(view.get("projection") or "")
    if proj == "eye_level":
        reg = camera.height_register(view.get("camera_height")) or "eye"
        facing = _facing_fragment(view)
        if reg in ("ground", "eye"):
            return (
                "Step inside this exact place and draw what a person standing "
                "there sees: the view from ground level at eye level (camera "
                f"about 1.7 m up){facing}."
            )
        ch = view.get("camera_height")
        metric = (
            f" (about {float(ch):.0f} m up)"
            if isinstance(ch, (int, float))
            else ""
        )
        return (
            "Step inside this exact place and draw the view "
            f"{camera.HEIGHT_PHRASES[reg]}{metric}{facing}, keeping every "
            "structure's true proportions."
        )
    if proj == "top_down":
        # The owner's "a castle would go in 2D" ask, on the ENTER path: a
        # closer PLAN of the place itself (the 2D-plan pill's honored form).
        return (
            "Redraw this exact place as a flat top-down plan map of it, "
            "closer in: looking straight down from directly overhead, every "
            "structure seen roof-on, no facades visible, no horizon. "
            "Courtyards and open baileys stay OPEN — draw the inner "
            "structures within the walls; never seal an open compound under "
            "an invented roof."
        )
    if proj == "oblique":
        pd = abs(float(view.get("pitch_deg") or 45.0))
        return (
            f"Redraw this exact place as a high-angle oblique aerial view"
            f"{_corner_fragment(view)}: camera pitched about {pd:.0f} degrees "
            "below horizontal, rooftops AND the front faces of buildings both "
            "visible, the horizon just visible at the top of frame."
        )
    # isometric
    iso_pd = view.get("pitch_deg")
    pitch_bit = (
        f", camera pitched about {abs(float(iso_pd)):.0f} degrees"
        if iso_pd is not None
        else ""
    )
    return (
        f"Redraw this exact place as an isometric illustration"
        f"{_corner_fragment(view)}: three-quarter elevated view{pitch_bit}, "
        "parallel edges, no perspective convergence, no horizon."
    )


def _interior_transform_sentence() -> str:
    """The interior enter's one view-change sentence (INTERIOR_ENTERS): step
    THROUGH the entrance and render the enclosed interior, never the facade."""
    return (
        "Step through the entrance INTO it and draw the INDOOR view from "
        "ground level within: an enclosed interior with its inner walls, "
        "floor and ceiling or rafters visible — NOT the building's exterior, "
        "NOT its facade, NOT the surrounding streets or grounds."
    )


def _interior_invariants_sentence(
    named: list[str], exterior_appearance: str | None
) -> str:
    """The interior twin of _invariants_sentence: the inside can't show the
    exterior's landmarks, so kinship is MATERIAL + SHELL instead — the indoor
    space must read as belonging to the exact building the reference shows."""
    text = (
        "The interior must plausibly belong to the exact building the image "
        "shows: same materials, palette and construction"
    )
    if exterior_appearance and exterior_appearance.strip():
        text += f" — {exterior_appearance.strip()}"
    text += (
        ", an inner space that fits the building's shell (a round tower "
        "encloses a round chamber; a tall building implies stairs, galleries "
        "or upper floors)"
    )
    if named:
        text += ", and containing what belongs here: " + "; ".join(named[:8])
    return text + "."


def _lr_consistent_with_map(view: ViewSpec) -> bool:
    """Map left/right only survives a north-ish facing (or a plan view) —
    facing south INVERTS it (V1 red-team finding 12)."""
    proj = str(view.get("projection") or "")
    if proj == "top_down":
        return True
    az = view.get("azimuth_deg")
    if az is None:
        return False
    delta = abs(((float(az) + 180.0) % 360.0) - 180.0)
    return delta <= 45.0


def _invariants_sentence(named: list[str], view: ViewSpec) -> str:
    text = (
        "This is the SAME place as the map, not a new one: keep its "
        "architecture and structure shapes, materials, colour palette"
    )
    if named:
        text += ", and exactly these landmarks: " + "; ".join(named[:8])
    if _lr_consistent_with_map(view):
        return text + ". Keep left/right relations consistent with the map."
    return text + ". Keep their relative positions as seen from this viewpoint."


def _pov_surroundings_text(surroundings: str | None, behind: str | None) -> str:
    """Sightline-culled surroundings (client geometry: observer pose + view
    frustum decided what the camera can actually see). View-relative wording;
    everything outside the frustum is BANNED from the backdrop by name, and
    an empty visible list is said out loud as an empty backdrop. The live
    failure this kills: the lighthouse enter faced open sea, and the
    map-bearing neighbours ("to the east, the docks") were painted into the
    background anyway."""
    s = (surroundings or "").strip()
    b = (behind or "").strip()
    if not s and not b:
        return ""
    text = ""
    if s:
        text += f" From this viewpoint the only mapped landmarks in sight are: {s}"
        if not text.endswith("."):
            text += "."
        text += (
            " They stay exactly where stated, distant — do NOT widen or pull "
            "back the framing to include more."
        )
    else:
        text += (
            " No other mapped landmark is visible from this viewpoint — beyond "
            "the subject the backdrop stays open and empty (sky, terrain or "
            "water, as the reference implies); do NOT introduce distant "
            "buildings, docks, piers, towers or streets."
        )
    if b:
        text += f" Out of frame behind the camera (NOT visible, do not draw): {b}."
    return text


def _surroundings_sentence(
    surroundings: str | None,
    *,
    pov: bool = False,
    behind: str | None = None,
    interior: bool = False,
) -> str:
    """Neighbours framed EXPLICITLY as map bearings — the instruction's own
    facing is view-relative, and mixing registers silently is the A2
    contradiction this grammar exists to kill. pov=True (sightline-culled
    client geometry) swaps to the view-relative wording instead. interior
    (INTERIOR_ENTERS) rewords the lead-in only — indoors, the neighbours are
    glimpsed through windows and doorways, not 'beyond the walls'."""
    if pov:
        return _pov_surroundings_text(surroundings, behind)
    if not (surroundings and surroundings.strip()):
        return ""
    text = (
        (
            " Through windows and doorways, keep the neighbours where the "
            f"parent image had them: {surroundings.strip()}"
        )
        if interior
        else (
            " Through openings and beyond the walls, keep the neighbours where the "
            f"map placed them (map bearings, not view directions): {surroundings.strip()}"
        )
    )
    if not text.endswith("."):
        text += "."
    # Anti-widen: the live failure was the model zooming OUT to fit every
    # named neighbour into frame (a courtyard tap re-drawing the whole city,
    # 10/10 on plain same-place). The neighbours are context, not subjects.
    text += (
        " The neighbours stay distant glimpses at the edges of frame — do NOT "
        "widen or pull back the framing to include them."
    )
    return text


def _medium_sentence(proj: str, style_anchor: str | None, ref_name: str) -> str:
    """Medium rider, ADJACENT failure-attractor bans per projection.
    isometric re-names itself an illustration and bans the 3D-render register
    (never the bare token "3D"); oblique adds the tilt-shift ban."""
    if proj == "isometric":
        text = f"Keep the flat illustrated medium of {ref_name}"
        if style_anchor and style_anchor.strip():
            text += f" — {style_anchor.strip()} —"
        text += (
            " flat shading and clean linework; this is an isometric "
            "illustration, NOT a photorealistic 3D render, no glossy CG look. "
            + LETTERING_GUARD
        )
        return text
    text = medium_lock(style_anchor, ref_name=ref_name)
    if proj == "oblique":
        text += " No tilt-shift miniature effect, no 3D render."
    return text


# --- Per-family enter builders -------------------------------------------------

def _enter_nano(
    title: str,
    named: list[str],
    *,
    style_anchor: str | None,
    subject_context: str | None,
    surroundings: str | None,
    layout_clause: str,
    view: ViewSpec,
    style_ref: bool,
    surroundings_pov: bool = False,
    surroundings_behind: str | None = None,
    interior: bool = False,
    exterior_appearance: str | None = None,
) -> str:
    anchor = f'"{title}"'
    if subject_context and subject_context.strip():
        anchor += f" ({subject_context.strip()})"
    if style_ref:
        text = (
            f"Image 1 is the overhead map of {anchor}; Image 2 is only a "
            "style reference — take no content from it. "
        )
        ref_name = "Image 2"
    else:
        text = f"The provided image is the overhead map of {anchor}. "
        ref_name = "the reference"
    proj = str(view.get("projection") or "")
    if interior:
        text += _interior_transform_sentence()
        text += " " + _interior_invariants_sentence(named, exterior_appearance)
    else:
        text += _transform_sentence(view)
        text += " " + _invariants_sentence(named, view)
    text += _surroundings_sentence(
        surroundings,
        pov=surroundings_pov,
        behind=surroundings_behind,
        interior=interior,
    )
    text += " " + _medium_sentence(proj, style_anchor, ref_name)
    text += f" {ASPECT_GUARD}"
    if layout_clause.strip():
        text += "\n\n" + layout_clause.strip()
    return text.strip()


def _enter_gpt(
    title: str,
    named: list[str],
    *,
    style_anchor: str | None,
    subject_context: str | None,
    surroundings: str | None,
    layout_clause: str,
    view: ViewSpec,
    style_ref: bool,
    surroundings_pov: bool = False,
    surroundings_behind: str | None = None,
    interior: bool = False,
    exterior_appearance: str | None = None,
) -> str:
    proj = str(view.get("projection") or "")
    ctx = (
        f" ({subject_context.strip()})"
        if subject_context and subject_context.strip()
        else ""
    )
    if interior:
        # INTERIOR ENTERS: the change-first sentence goes INDOORS — the
        # camera doesn't just drop to eye level in front of the facade.
        change = (
            f'Change the scene: step through the entrance INTO "{title}"{ctx} '
            "and render the INDOOR view from ground level within it — an "
            "enclosed interior with its inner walls, floor and ceiling or "
            "rafters visible; NOT the building's exterior, NOT its facade, "
            "NOT the surrounding streets or grounds."
        )
    elif proj == "eye_level":
        change = (
            "Change only the camera: move it from the overhead map view "
            "(Image 1) to eye level, about 1.7 m up, standing inside "
            f'"{title}"{ctx}{_facing_fragment(view)}.'
        )
    elif proj == "top_down":
        change = (
            "Change only the framing: re-render Image 1 as a flat top-down "
            f'plan map of "{title}"{ctx}, closer in, looking straight down.'
        )
    elif proj == "oblique":
        pd = abs(float(view.get("pitch_deg") or 45.0))
        change = (
            "Change only the camera: re-render Image 1 as a high-angle "
            f"oblique aerial view{_corner_fragment(view)}, pitched about "
            f"{pd:.0f} degrees below horizontal, rooftops and front facades "
            "both visible."
        )
    else:  # isometric
        change = (
            "Change only the camera: re-render Image 1 as an isometric "
            f"illustration{_corner_fragment(view)}, parallel edges, no "
            "perspective convergence."
        )
    refs = "Image 1 is the map — the place itself."
    ref_name = "the reference"
    if style_ref:
        refs += " Image 2 is a style reference only — take no content from it."
        ref_name = "Image 2"
    if interior:
        text = (
            f"{change} {refs} "
            + _interior_invariants_sentence(named, exterior_appearance)
        )
    else:
        text = (
            f"{change} {refs} Preserve: the architecture and building shapes, "
            "materials, colour palette"
        )
        if named:
            text += f", this exact landmark set ({'; '.join(named[:8])})"
        if _lr_consistent_with_map(view):
            text += ", and their left/right relations as the map implies."
        else:
            text += ", and their relative positions as seen from this viewpoint."
    if surroundings_pov:
        text += _pov_surroundings_text(surroundings, surroundings_behind)
    elif interior:
        text += _surroundings_sentence(surroundings, interior=True)
    elif surroundings and surroundings.strip():
        text += (
            " Keep the neighbours where the map placed them (map bearings): "
            f"{surroundings.strip()}"
        )
        if not text.endswith("."):
            text += "."
        # Anti-widen (see _surroundings_sentence): neighbours are context,
        # not subjects — never a reason to pull the camera back.
        text += (
            " The neighbours stay distant glimpses at the edges of frame — do "
            "NOT widen or pull back the framing to include them."
        )
    text += " " + _medium_sentence(proj, style_anchor, ref_name)
    text += (
        " Constraints: "
        + camera.GPT_CONSTRAINTS[proj]
        + " Consistent lighting and shadows; no extra landmarks, no text or "
        "watermarks. Keep the aspect ratio."
    )
    if layout_clause.strip():
        text += "\n\n" + layout_clause.strip()
    return text.strip()


def _enter_kontext(
    title: str,
    named: list[str],
    *,
    style_anchor: str | None,
    subject_context: str | None,
    surroundings: str | None,
    layout_clause: str,
    view: ViewSpec,
    surroundings_pov: bool = False,
    surroundings_behind: str | None = None,
    interior: bool = False,
    exterior_appearance: str | None = None,
) -> str:
    """FORCED fallback only — Kontext rotates the subject, not the camera
    (3.33/10 same-place on view change). Scene-level phrasing, full medium in
    text (no style-ref slot). Policy should route enters to nano instead."""
    proj = str(view.get("projection") or "")
    ctx = (
        f" ({subject_context.strip()})"
        if subject_context and subject_context.strip()
        else ""
    )
    medium = (style_anchor or "").strip() or "hand-drawn illustration"
    if interior:
        # Interior enter, Kontext grammar (frugal): one change sentence, the
        # belongs-to-this-building preserve list, the medium.
        text = (
            f'Step through the entrance INTO this exact "{title}"{ctx} and '
            "change the view to its enclosed INDOOR interior seen from ground "
            "level — inner walls, floor and ceiling or rafters visible, NOT "
            "the building's exterior, NOT its facade, NOT the surrounding "
            "streets or grounds — while keeping an interior that plausibly "
            "belongs to it: same materials, palette and construction"
        )
        if exterior_appearance and exterior_appearance.strip():
            text += f" — {exterior_appearance.strip()}"
        text += (
            ", an inner space that fits the building's shell (a round tower "
            "encloses a round chamber; a tall building implies stairs, "
            "galleries or upper floors)"
        )
    elif proj == "eye_level":
        head = f'Change the view to ground level inside this exact "{title}"{ctx}'
    elif proj == "top_down":
        head = (
            f'Change the view of this exact "{title}"{ctx} to a flat '
            "top-down plan view, looking straight down"
        )
    elif proj == "isometric":
        head = (
            f'Change the view of this exact "{title}"{ctx} to an isometric '
            "illustration with parallel edges and no perspective convergence"
        )
    else:
        head = (
            f'Change the view of this exact "{title}"{ctx} to a high-angle '
            "three-quarter aerial view"
        )
    if not interior:
        text = (
            f"{head} while preserving its exact architecture, walls, materials, "
            "colours and landmarks"
        )
    if named:
        text += f" ({'; '.join(named[:8])})"
    text += (
        f", and the same {medium} medium — not a photograph, no photorealism. "
        + LETTERING_GUARD
    )
    if surroundings_pov:
        text += _pov_surroundings_text(surroundings, surroundings_behind)
    elif surroundings and surroundings.strip():
        text += (
            f" Through windows and doorways keep: {surroundings.strip()}"
            if interior
            else f" Beyond the walls keep: {surroundings.strip()}"
        )
        if not text.endswith("."):
            text += "."
    if layout_clause.strip():
        text += "\n\n" + layout_clause.strip()
    return text.strip()


# --- Public builders -------------------------------------------------------------

def _faithful_zoom_instruction(
    page_title: str,
    layout_clause: str = "",
    register: str = "map",
) -> str:
    """The CLOSEUP zoom (scene_view.closeup): a faithful magnification that
    GAINS detail. Two failure modes bound this register. Elaborate-with-facts
    invented structures (a 20x12 crop of a palace icon redrawn as a riverside
    compound — the planner's city-wide facts rode in), so facts never ride a
    magnification. But pure magnify-only overcorrected into a photocopier:
    the same icon redrawn bigger and mushier, nothing gained — the rung felt
    pointless. The contract: every structure the reference shows, exactly
    where it is, rendered at the finer detail level a dedicated inset plate
    of that landmark would carry. New detail belongs INSIDE existing
    structures; nothing new appears."""
    title = page_title.strip() or "this place"
    noun = "map" if register == "map" else "view"
    viewpoint = (
        "from the SAME overhead map viewpoint"
        if register == "map"
        else "from the SAME viewpoint the reference shows"
    )
    plate = (
        "A master cartographer's close-up inset of this exact map"
        if register == "map"
        else "A faithful close-up of this exact view at finer detail"
    )
    text = (
        f'Zoom into "{title}" — the area at the centre of this image — and '
        f"redraw it as a DETAILED INSET of this exact {noun}: the same "
        "place, magnified, drawn at a much finer level of detail. Keep "
        "exactly the walls, buildings, towers and landmarks the reference "
        "shows — the same arrangement, proportions and relative positions, "
        f"the same style, palette and line work, {viewpoint}. Render each "
        f"of those structures with the fine-grained detail the wider {noun} "
        "was too small to show: individual stones and roof tiles, windows "
        "and doorways, stairs, timbers, battlements, foliage — the "
        "small-scale texture that belongs to what is already drawn, in the "
        "same hand. Do NOT add new structures, water, roads, or features "
        "that are not in the reference; do not move, mirror, restyle or "
        f"reinterpret anything. {plate}, not a new scene. Keep any "
        "lettering sparse and legible — no garbled text."
    )
    if layout_clause.strip():
        text += "\n\n" + layout_clause.strip()
    return text.strip()


def build_zoom_instruction(
    page_title: str,
    facts: list[str],
    layout_clause: str = "",
    *,
    style_anchor: str | None = None,
    view: ViewSpec | None = None,
    family: str | None = None,
    label_free: bool = False,
    register: str = "map",
    faithful: bool = False,
) -> str:
    """Zoom-continue: same place, SAME camera, finer detail. view=None ->
    today's exact string. With a view, the keep-camera fragment is spelled per
    projection in PRESERVE form — any projection is honored, none is ever a
    change (Kontext's native grammar; harmless on nano/gpt). label_free
    (DOM-labels mode) swaps the lettering guard for the full no-text
    directive. register="view" (place_closeup: the source is a perspective
    SCENE, not a map) swaps the cartographic words on the legacy skeleton.
    faithful (closeup rung) switches to pure magnification — no facts, no
    elaboration. Defaults keep every instruction byte-identical."""
    if label_free:
        text = build_zoom_instruction(
            page_title,
            facts,
            layout_clause,
            style_anchor=style_anchor,
            view=view,
            family=family,
            register=register,
            faithful=faithful,
        )
        if LETTERING_GUARD in text:
            return text.replace(LETTERING_GUARD, NO_LETTERING)
        return f"{text} {NO_LETTERING}"
    if faithful:
        # The closeup rung ignores the view-aware variants too — the
        # reference pixels carry the camera, and facts never ride a
        # magnification.
        return _faithful_zoom_instruction(page_title, layout_clause, register)
    if view is None:
        return _legacy_zoom_instruction(page_title, facts, layout_clause, register)
    proj = str(view.get("projection") or "")
    keep = camera.keep_view_fragment(view)
    if not keep:
        return _legacy_zoom_instruction(page_title, facts, layout_clause, register)
    title = page_title.strip() or "this place"
    noun = "map" if proj == "top_down" else "view"
    drift = (
        "an eye-level or interior view"
        if proj == "top_down"
        else "a different viewpoint or projection"
    )
    medium = (style_anchor or "").strip() or "hand-drawn"
    text = (
        f'Zoom into "{title}" — the area at the centre of this image — while '
        f"maintaining {keep}. Keep every existing wall, building, tower and "
        "landmark the reference already shows, the palette and the line work "
        f"identical — same {medium} style; do not reinvent them, restyle "
        f"them, or switch to {drift}. As you move closer, reveal finer "
        "architectural detail of the same structures"
    )
    named = [f.strip() for f in facts if f and f.strip()]
    if named:
        text += ", working in the features that belong here: " + "; ".join(named[:8])
    text += (
        f". A closer, faithful continuation of this exact {noun}, not a new "
        "scene. " + LETTERING_GUARD
    )
    if (family or "") == "gpt_image":
        text += (
            " Constraints: no viewpoint change; no extra landmarks; keep the "
            "aspect ratio."
        )
    if layout_clause.strip():
        text += "\n\n" + layout_clause.strip()
    return text.strip()


def build_enter_instruction(
    page_title: str,
    facts: list[str],
    *,
    style_anchor: str | None = None,
    subject_context: str | None = None,
    surroundings: str | None = None,
    layout_clause: str = "",
    view: ViewSpec | None = None,
    family: str | None = None,
    style_ref: bool = False,
    surroundings_pov: bool = False,
    surroundings_behind: str | None = None,
    interior: bool = False,
    exterior_appearance: str | None = None,
) -> str:
    """Enter: a view CHANGE that keeps the place. view=None -> today's exact
    string. All four projections are honored — top_down renders the place as
    a closer plan map (the 2D pill's honored form, V1 finding 2). interior
    (INTERIOR_ENTERS) flips the core sentence to the INDOOR register in every
    variant — a discrete building is entered, not re-shot from outside;
    interior=False stays byte-identical."""
    if view is None or str(view.get("projection") or "") not in _ENTER_PROJECTIONS:
        return _legacy_enter_instruction(
            page_title,
            facts,
            style_anchor=style_anchor,
            subject_context=subject_context,
            surroundings=surroundings,
            layout_clause=layout_clause,
            surroundings_pov=surroundings_pov,
            surroundings_behind=surroundings_behind,
            interior=interior,
            exterior_appearance=exterior_appearance,
        )
    title = page_title.strip() or "this place"
    named = [f.strip() for f in facts if f and f.strip()]
    fam = family or "nano"
    if fam == "kontext":
        return _enter_kontext(
            title, named,
            style_anchor=style_anchor, subject_context=subject_context,
            surroundings=surroundings, layout_clause=layout_clause, view=view,
            surroundings_pov=surroundings_pov,
            surroundings_behind=surroundings_behind,
            interior=interior, exterior_appearance=exterior_appearance,
        )
    if fam == "gpt_image":
        return _enter_gpt(
            title, named,
            style_anchor=style_anchor, subject_context=subject_context,
            surroundings=surroundings, layout_clause=layout_clause, view=view,
            surroundings_pov=surroundings_pov,
            surroundings_behind=surroundings_behind,
            style_ref=style_ref,
            interior=interior, exterior_appearance=exterior_appearance,
        )
    return _enter_nano(
        title, named,
        style_anchor=style_anchor, subject_context=subject_context,
        surroundings=surroundings, layout_clause=layout_clause, view=view,
        surroundings_pov=surroundings_pov,
        surroundings_behind=surroundings_behind,
        style_ref=style_ref,
        interior=interior, exterior_appearance=exterior_appearance,
    )


# --- OUTWARD ---------------------------------------------------------------------

_OUTWARD_REGISTER = {
    "top_down": "flat top-down overhead",
    "oblique": "high-angle oblique",
    "isometric": "isometric",
    "eye_level": "eye-level",
}


def outward_clause(view: ViewSpec | None) -> str:
    """Outpaint-semantics rider for the ascend paths: the margin keeps the
    SOURCE's projection; the camera rises/pulls back; NOTHING rescales
    (research/10 §4.5 — naive "zoom out" rescales the subject). "" when None
    (legacy ascend strings stay byte-identical)."""
    if view is None:
        return ""
    proj = str(view.get("projection") or "")
    reg = _OUTWARD_REGISTER.get(proj)
    if reg is None:
        return ""
    motion = "rises" if proj == "top_down" else "pulls back"
    return (
        "Keep the original view exactly the same in position, scale and "
        f"appearance, and keep the same {reg} perspective across the new "
        f"margin — the camera simply {motion}; nothing inside the original "
        "view changes or rescales."
    )
