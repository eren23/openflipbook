"""camera_clause — the deliberate camera/projection, named in prompt text.

The view grammar's voice box: a ViewSpec (+ optional observer pose) becomes ONE
deterministic clause the image model can follow. Vocabulary per
docs/research/08-camera-prompting.md: qualitative registers carry, numbers ride
as parentheticals; projection is a property of the ARTWORK on hand-drawn
mediums (camera-hardware nouns only on photo mediums); positive register first,
short negative guard last, medium rider naming the projection's specific drift.

view=None -> "" — legacy renders keep their hardcoded text (byte-identity).
family="kontext" -> the PRESERVE form only: Kontext is never asked to move the
camera (it rotates the subject instead — docs/research/10 §4.1/§5).
"""
from __future__ import annotations

import math

from providers.geometry import ObserverPose as ObserverPoseDict
from providers.prompt_library.types import ViewSpec

PROJECTIONS = ("top_down", "oblique", "isometric", "eye_level")

# Per-projection language. positive = projection as a property of the artwork,
# naming what is VISIBLE; negative = the failure attractors, short and
# explicit; medium_rider = re-names the medium and bans this projection's
# specific drift (photoreal ortho / tilt-shift / glossy 3D render / photo).
_PROJECTION_LANGUAGE: dict[str, dict[str, str]] = {
    "top_down": {
        "positive": (
            "Drawn in flat top-down plan view, looking straight down from "
            "directly overhead: every building seen roof-on, no facades "
            "visible, no horizon anywhere on the sheet, uniform scale across "
            "the whole map."
        ),
        "negative": (
            "NO perspective, no isometric tilt, no vanishing point, no 3D depth."
        ),
        "medium_rider": (
            "This stays a {medium} map — same palette and line work; not a "
            "satellite photo, not a photoreal orthophoto, not a CAD blueprint."
        ),
    },
    "oblique": {
        "positive": (
            "Drawn as a high-angle oblique aerial view, looking down on the "
            "scene: rooftops AND the front faces of buildings are both "
            "visible, like a three-quarter city-builder map."
        ),
        "negative": (
            "Not straight down and not at ground level — keep the elevated "
            "three-quarter angle; no fisheye distortion."
        ),
        "medium_rider": (
            "Keep it a {medium} — same palette and line work; not a "
            "photograph, no tilt-shift miniature effect, no 3D render."
        ),
    },
    "isometric": {
        "positive": (
            "Drawn as an isometric illustration — axonometric parallel "
            "projection, all vertical lines parallel, no vanishing point — "
            "like a game-art diorama seen from an elevated corner."
        ),
        "negative": (
            "No perspective foreshortening, no horizon, no camera lens effects."
        ),
        "medium_rider": (
            "Rendered with flat shading and clean hand-drawn linework in the "
            "same {medium} — NOT a glossy 3D render, no Blender or Octane "
            "look, no soft studio lighting."
        ),
    },
    "eye_level": {
        "positive": (
            "Seen from a person's eye level standing inside the place, "
            "looking ahead: natural perspective with a visible horizon, "
            "nearby things large, distant things smaller."
        ),
        "negative": (
            "Not an overhead, map, or aerial view — the viewer is INSIDE the "
            "scene, feet on the ground."
        ),
        "medium_rider": (
            "Keep it a {medium} — same palette and line work; NOT a "
            "photograph, no photorealism."
        ),
    },
}

# Raised-eye variant: an eye_level vista from the walls/rooftop must not claim
# "feet on the ground" while the height phrase says rooftop (A2 audit: the
# clause must never contradict its own pose).
_EYE_LEVEL_RAISED_NEGATIVE = (
    "Not an overhead, map, or aerial view — the viewer is INSIDE the scene."
)

# gpt-image grammar: restate the guard as a trailing constraints block (the
# officially endorsed exclusion-list form; repeat verbatim on every edit turn).
GPT_CONSTRAINTS: dict[str, str] = {
    "top_down": (
        "Top-down plan view only. Rooftops only; no building sides visible. "
        "No horizon. No isometric tilt, no vanishing point."
    ),
    "oblique": (
        "Keep a consistent 45-degree high angle. Not top-down, not eye-level. "
        "No fisheye distortion."
    ),
    "isometric": (
        "Isometric parallel projection only; flat 2D illustration, not a 3D render."
    ),
    "eye_level": "Eye-level first-person view only. No bird's-eye or map view.",
}

# gpt-image: the face-visibility sentence is the reliable viewpoint lever —
# lead with it (research/08 §1b).
_GPT_LEAD: dict[str, str] = {
    "oblique": "BOTH the rooftops and the front facades are visible.",
}

# Kontext / preserve grammar — full sentences (camera_clause family="kontext")
# and inline fragments (zoom-continue instruction). NEVER a change form.
_KEEP_VIEW: dict[str, str] = {
    "top_down": (
        "Maintain the identical flat top-down overhead viewpoint, framing, "
        "and scale; do not tilt the view or add perspective."
    ),
    "oblique": (
        "Maintain the identical oblique high-angle viewpoint, camera angle, "
        "framing, and perspective."
    ),
    "isometric": (
        "Maintain the identical isometric projection, axis directions, "
        "framing, and perspective."
    ),
    "eye_level": (
        "Maintain the identical eye-level viewpoint, subject placement, "
        "camera angle, framing, and perspective."
    ),
}
_KEEP_INLINE: dict[str, str] = {
    "top_down": (
        "the exact same overhead camera angle, position and framing, "
        "looking straight down"
    ),
    "oblique": (
        "the exact same high-angle three-quarter camera angle, position and framing"
    ),
    "isometric": (
        "the exact same isometric projection, axis directions, position and framing"
    ),
    "eye_level": "the exact same eye-level camera angle, position and framing",
}

# 8-wind compass, in compass-bearing order (0=N, clockwise). Names hyphenated
# to match geo-tap.ts cardinal().
_WINDS = (
    "north", "north-east", "east", "south-east",
    "south", "south-west", "west", "north-west",
)

# Height registers (A2 audit: eye 1.7 / rooftop >=10 / aerial >=30 world units).
HEIGHT_PHRASES: dict[str, str] = {
    "ground": "from ground level",
    "eye": "from standing eye level",
    "rooftop": "from rooftop height, just above the surrounding buildings",
    "aerial": "from high above the whole area",
}

# Pitch buckets (research/08 §2): the WORD carries; the visibility half is the
# actually load-bearing part; the degree number rides as a parenthetical.
_PITCH_PHRASES: dict[str, tuple[str, str]] = {
    "steep": (
        "tilted steeply downward",
        "mostly rooftops, only thin slivers of the facades visible",
    ),
    "classic": (
        "tilted down at a classic 45-degree angle",
        "rooftops and facades equally visible",
    ),
    "shallow": (
        "tilted gently downward",
        "mostly facades, rooftops barely visible",
    ),
}

# FOV: scene-coverage words on drawn mediums; lens-mm ONLY on photo mediums
# (mm imports photorealism). Default band 70-100° (wire default 90) is silent.
_FOV_DRAWN: dict[str, str] = {
    "wide": "a wide field of view taking in the whole scene edge to edge",
    "normal": "a natural field of view",
    "narrow": "a tight, zoomed-in view of just the subject",
}
_FOV_PHOTO: dict[str, str] = {
    "wide": "a wide-angle 24mm lens",
    "normal": "a 50mm lens at natural framing",
    "narrow": "an 85mm telephoto lens",
}


def is_photo_medium(medium: str | None) -> bool:
    """Camera-hardware nouns (lens/mm/drone) are photorealism levers — allowed
    only when the world's medium is itself photographic."""
    return "photo" in (medium or "").lower()


def compass_word(bearing_deg: float) -> str:
    """Compass bearing (0=N, clockwise) -> 8-wind name, same names and the same
    Math.round semantics as geo-tap.ts cardinal() (int(x+0.5), not banker's
    rounding — they differ exactly at the 22.5° bin edges)."""
    return _WINDS[int(((bearing_deg % 360.0) / 45.0) + 0.5) % 8]


def gaze_to_compass(gaze_rad: float) -> str:
    """Observer gaze (radians, 0=+x=east, +y=south) -> compass word.
    bearing = (degrees(gaze) + 90) % 360, matching geo-tap.ts's frame."""
    return compass_word((math.degrees(gaze_rad) + 90.0) % 360.0)


def pitch_bucket(pitch_deg: float) -> str:
    """Downward-tilt degrees -> register. The two ends are projection
    coercions (policy should have picked top_down / eye_level); the middle
    three are oblique flavors."""
    if pitch_deg >= 80.0:
        return "top_down"
    if pitch_deg >= 55.0:
        return "steep"
    if pitch_deg >= 35.0:
        return "classic"
    if pitch_deg >= 15.0:
        return "shallow"
    return "eye_level"


def height_register(camera_height: str | float | None) -> str | None:
    """camera_height (register string or world units) -> register, or None."""
    if camera_height is None:
        return None
    if isinstance(camera_height, str):
        return camera_height if camera_height in HEIGHT_PHRASES else None
    h = float(camera_height)
    if h <= 0.6:
        return "ground"
    if h < 10.0:
        return "eye"
    if h < 30.0:
        return "rooftop"
    return "aerial"


def keep_view_clause(view: ViewSpec | None) -> str:
    """The preserve-form sentence for this view (Kontext's whole grammar)."""
    if view is None:
        return ""
    return _KEEP_VIEW.get(str(view.get("projection") or ""), "")


def keep_view_fragment(view: ViewSpec | None) -> str:
    """The inline 'maintaining ...' fragment for zoom-continue instructions."""
    if view is None:
        return ""
    return _KEEP_INLINE.get(str(view.get("projection") or ""), "")


def model_family(slug: str | None) -> str:
    """Bucket a model slug into a prompt-grammar family. riverflow speaks the
    gpt-image constraints grammar best of the tested registers (it is an
    instruction-following chat-image model, not a caption model)."""
    s = (slug or "").lower()
    if "nano-banana" in s or "gemini" in s:
        return "nano"
    if "kontext" in s:
        return "kontext"
    if "gpt-image" in s or "gpt_image" in s or "riverflow" in s:
        return "gpt_image"
    return "other"


def _height_fragment(
    view: ViewSpec, observer: ObserverPoseDict | None, proj: str
) -> tuple[str | None, str]:
    """(register, phrase). Phrase is "" when silent: top_down never speaks
    height; eye_level skips its own default registers (ground/eye)."""
    reg = height_register(view.get("camera_height"))
    if reg is None and observer is not None and observer.get("eye_height") is not None:
        reg = height_register(float(observer["eye_height"]))
    if reg is None or proj == "top_down":
        return reg, ""
    if proj == "eye_level" and reg in ("ground", "eye"):
        return reg, ""
    phrase = HEIGHT_PHRASES[reg]
    ch = view.get("camera_height")
    if isinstance(ch, (int, float)) and float(ch) >= 3.0:
        phrase += f" (about {float(ch):.0f} m up)"
    return reg, phrase


def _pitch_fragment(
    view: ViewSpec, observer: ObserverPoseDict | None, proj: str
) -> str:
    """Pitch phrase for oblique/isometric only — top_down and eye_level ARE
    their pitch register. Oblique defaults to the classic 45° register (the
    corpus token that selects oblique at all)."""
    if proj not in ("oblique", "isometric"):
        return ""
    pd = view.get("pitch_deg")
    if pd is None and observer is not None:
        op = observer.get("pitch")
        if op is not None and float(op) < 0.0:
            pd = -math.degrees(float(op))
    if pd is None:
        if proj != "oblique":
            return ""
        pd = 45.0
    bucket = pitch_bucket(abs(float(pd)))
    if bucket not in _PITCH_PHRASES:
        return ""
    tilt, visibility = _PITCH_PHRASES[bucket]
    return f"{tilt} (about {abs(float(pd)):.0f} degrees below horizontal) — {visibility}"


def _azimuth_fragment(
    view: ViewSpec, observer: ObserverPoseDict | None, landmark: str | None
) -> str:
    """Relational azimuth: landmark first, compass parenthetical; bare compass
    only as a last resort (low confidence, research/08 §2)."""
    az = view.get("azimuth_deg")
    if az is None and observer is not None and observer.get("gaze") is not None:
        az = (math.degrees(float(observer["gaze"])) + 90.0) % 360.0
    if az is None:
        return ""
    cw = compass_word(float(az))
    if landmark and landmark.strip():
        return f"looking toward {landmark.strip()} (to the {cw})"
    return f"facing {cw}"


def _fov_fragment(view: ViewSpec, photo: bool) -> str:
    fd = view.get("fov_deg")
    if fd is None or 70.0 <= float(fd) <= 100.0:
        return ""
    f = float(fd)
    bucket = "wide" if f >= 70.0 else ("normal" if f >= 40.0 else "narrow")
    if photo:
        return "shot with " + _FOV_PHOTO[bucket]
    return "the framing is " + _FOV_DRAWN[bucket]


def camera_clause(
    view: ViewSpec | None,
    observer: ObserverPoseDict | None = None,
    *,
    medium: str | None = None,
    family: str | None = None,
    landmark: str | None = None,
) -> str:
    """The deliberate-camera clause for fresh/map renders.

    Assembly: [gpt lead-with]? positive register -> pose sentence (height,
    pitch+visibility, azimuth; fov only when non-default; top_down instead
    pins "North is at the top of the map." when azimuth_deg is 0 — the
    policy's map stamp) -> medium rider (re-names the medium, bans this
    projection's drift) -> negative guard last (gpt-image: as a trailing
    Constraints: block). family="kontext" -> preserve form only.
    None view / unknown projection -> "".
    """
    if view is None:
        return ""
    proj = str(view.get("projection") or "")
    lang = _PROJECTION_LANGUAGE.get(proj)
    if lang is None:
        return ""
    fam = family or "nano"
    if fam == "kontext":
        return _KEEP_VIEW[proj]

    medium_name = (medium or "").strip() or "hand-drawn illustration"
    photo = is_photo_medium(medium)

    reg, height_phrase = _height_fragment(view, observer, proj)
    if proj == "top_down":
        # The north pin only when the spec stamped a map orientation
        # (policy's TOP_DOWN_MAP sets azimuth_deg=0); a pinned plan view of a
        # scene has no compass claim to make.
        pose = (
            "North is at the top of the map."
            if view.get("azimuth_deg") == 0.0
            else ""
        )
    else:
        main = [
            f
            for f in (
                height_phrase,
                _pitch_fragment(view, observer, proj),
                _azimuth_fragment(view, observer, landmark),
            )
            if f
        ]
        fov = _fov_fragment(view, photo)
        if main and fov:
            pose = "The view is " + ", ".join(main) + "; " + fov + "."
        elif main:
            pose = "The view is " + ", ".join(main) + "."
        elif fov:
            pose = fov[0].upper() + fov[1:] + "."
        else:
            pose = ""

    negative = lang["negative"]
    if proj == "eye_level" and reg in ("rooftop", "aerial"):
        negative = _EYE_LEVEL_RAISED_NEGATIVE

    parts: list[str] = []
    if fam == "gpt_image" and proj in _GPT_LEAD:
        parts.append(_GPT_LEAD[proj])
    parts.append(lang["positive"])
    if pose:
        parts.append(pose)
    parts.append(lang["medium_rider"].format(medium=medium_name))
    if fam == "gpt_image":
        parts.append("Constraints: " + GPT_CONSTRAINTS[proj])
    else:
        parts.append(negative)
    return " ".join(parts)


def register_reminder(projection: str, family: str | None = None) -> str:
    """The projection's full register (positive + guard) as a retry reminder —
    what the feedback clause re-asserts after a failed attempt. gpt-image gets
    its constraints-block form (the officially endorsed repeat-verbatim
    grammar); unknown projections return ""."""
    lang = _PROJECTION_LANGUAGE.get(projection)
    if lang is None:
        return ""
    if (family or "") == "gpt_image":
        return GPT_CONSTRAINTS[projection]
    return lang["positive"] + " " + lang["negative"]
