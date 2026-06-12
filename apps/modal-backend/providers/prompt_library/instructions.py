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
) -> str:
    title = page_title.strip() or "this place"
    anchor = f'"{title}"'
    if subject_context and subject_context.strip():
        anchor += f" ({subject_context.strip()})"
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
    if surroundings and surroundings.strip():
        text += (
            " Through openings and beyond the walls, keep the neighbours where "
            f"the map placed them: {surroundings.strip()}"
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


def _surroundings_sentence(surroundings: str | None) -> str:
    """Neighbours framed EXPLICITLY as map bearings — the instruction's own
    facing is view-relative, and mixing registers silently is the A2
    contradiction this grammar exists to kill."""
    if not (surroundings and surroundings.strip()):
        return ""
    text = (
        " Through openings and beyond the walls, keep the neighbours where the "
        f"map placed them (map bearings, not view directions): {surroundings.strip()}"
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
    text += _transform_sentence(view)
    text += " " + _invariants_sentence(named, view)
    text += _surroundings_sentence(surroundings)
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
) -> str:
    proj = str(view.get("projection") or "")
    ctx = (
        f" ({subject_context.strip()})"
        if subject_context and subject_context.strip()
        else ""
    )
    if proj == "eye_level":
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
    if surroundings and surroundings.strip():
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
    if proj == "eye_level":
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
    if surroundings and surroundings.strip():
        text += f" Beyond the walls keep: {surroundings.strip()}"
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
    """The CLOSEUP zoom (scene_view.closeup): a faithful MAGNIFICATION. The
    elaborate-with-facts register invites invention — the live failure was a
    20x12 crop of a stylized palace icon redrawn as a riverside compound
    because the planner's city-wide facts rode in. No facts, no elaboration:
    magnify what the reference shows and nothing else."""
    title = page_title.strip() or "this place"
    noun = "map" if register == "map" else "view"
    viewpoint = (
        "from the SAME overhead map viewpoint"
        if register == "map"
        else "from the SAME viewpoint the reference shows"
    )
    text = (
        f'Zoom into "{title}" — the area at the centre of this image — and '
        "MAGNIFY it faithfully. Draw exactly the walls, buildings, towers and "
        "landmarks the reference already shows, in the same style, palette "
        f"and line work, {viewpoint}; keep their exact arrangement, "
        "proportions and relative positions. Do NOT add structures, water, "
        "roads, or features that are not in the reference; do not reinvent "
        "or restyle anything — only sharpen the existing detail as you "
        f"magnify. A closer, faithful magnification of this exact {noun}, "
        "not a new scene. Keep any lettering sparse and legible — no "
        "garbled text."
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
) -> str:
    """Enter: a view CHANGE that keeps the place. view=None -> today's exact
    string. All four projections are honored — top_down renders the place as
    a closer plan map (the 2D pill's honored form, V1 finding 2)."""
    if view is None or str(view.get("projection") or "") not in _ENTER_PROJECTIONS:
        return _legacy_enter_instruction(
            page_title,
            facts,
            style_anchor=style_anchor,
            subject_context=subject_context,
            surroundings=surroundings,
            layout_clause=layout_clause,
        )
    title = page_title.strip() or "this place"
    named = [f.strip() for f in facts if f and f.strip()]
    fam = family or "nano"
    if fam == "kontext":
        return _enter_kontext(
            title, named,
            style_anchor=style_anchor, subject_context=subject_context,
            surroundings=surroundings, layout_clause=layout_clause, view=view,
        )
    if fam == "gpt_image":
        return _enter_gpt(
            title, named,
            style_anchor=style_anchor, subject_context=subject_context,
            surroundings=surroundings, layout_clause=layout_clause, view=view,
            style_ref=style_ref,
        )
    return _enter_nano(
        title, named,
        style_anchor=style_anchor, subject_context=subject_context,
        surroundings=surroundings, layout_clause=layout_clause, view=view,
        style_ref=style_ref,
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
