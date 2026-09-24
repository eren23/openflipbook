"""Paint a drawn route: a keyframe at every shot, a clip between neighbours.

A route gives cameras; a shot gives that camera plus the places it can see and
how much of the frame each one covers. Both come free from the block render,
so the walk knows what every picture is OF before it spends anything.

Two paid halves, in this order:

* **Keyframes.** Each shot's block render is handed to the edit model that
  holds a camera (research 34 measured five: qwen-image-edit-2511 at IoU
  0.944, centre within 0.5%, area 1.00 -- the rest re-frame). The geometry
  comes from the render, the subject from what the shot sees.
* **Clips.** Consecutive keyframes go to the descent slot, which honours
  `end_image_url` and lands square on the arrival frame. Measured over a
  chained walk: joins differ by 6-7 against 22 between neighbouring
  keyframes, so a seam reads as motion rather than a cut.

Nothing is concatenated here -- the runtime image carries no ffmpeg, and an
ordered list of clips plays back to back just as well.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

# The one edit model measured to keep the camera it was given (research 34).
KEYFRAME_MODEL = "fal-ai/qwen-image-edit-2511"
# The enter path's model, for a shot that carries the MAP around its camera.
# Given only a depth render a model draws a competent generic street: the
# geometry is right and the town is not the one on the map. Handed the map
# itself it draws the buildings that are actually there -- the same model and
# the same move as tapping a place to enter it (#172 benched it at 9.0).
#
# The box render is deliberately NOT sent with it. Research 19 ran this model
# against a simplified proxy guide four times and it failed architecture every
# run: "the prompt prioritized guide silhouette/arrangement, so the model
# received conflicting architectural instructions. The guide's simplified form
# appears in the generated results." A box proxy IS that guide. With the map
# alone the camera is described in words instead.
ENTER_MODEL = "fal-ai/nano-banana-pro/edit"
# A walk is many paid calls in a row, so it gets its own ceiling rather than
# riding the per-generation render budget.
MAX_SHOTS = 12
DEFAULT_CLIP_SECONDS = 5
# Rides every shot after the first, whose Image 2 is the keyframe before it.
# It is a reference for HOW the town is drawn, not what to draw: told to keep
# "every building exactly as it is drawn there", live keyframes re-drew the
# previous view, and a walk through the town kept circling one square
# (2026-09-24).
CHAIN_CLAUSE = (
    " Image 2 is the previous stop of this walk, some way back along the route. "
    "Use it only for how this town is drawn: a building that appears in both views "
    "keeps the same roof colour, materials and details, and the light and palette "
    "match. This view has moved on: draw what stands in front of this camera now, "
    "and do not repeat Image 2's view."
)


@dataclass(frozen=True)
class WalkShot:
    """One camera on the route, and what the block render says it sees."""

    index: int
    control_data_url: str
    sees: list[tuple[str, float]] = field(default_factory=list)
    # The map around this camera, if the caller cropped one. Its presence is
    # what switches a shot from "a street with this geometry" to "this town".
    surroundings_data_url: str | None = None


@dataclass(frozen=True)
class WalkClip:
    from_shot: int
    to_shot: int
    video_url: str
    model: str
    seconds: float


@dataclass(frozen=True)
class Walk:
    keyframes: list[str]
    clips: list[WalkClip]
    spent_usd: float


def shot_instruction(
    sees: list[tuple[str, float]],
    medium: str | None = None,
    grounded: bool = False,
) -> str:
    """What to paint at one camera, from the geometry and the names in frame.

    The block render is the camera and the placement; the labels are the
    subject. Naming them stops the model inventing a generic street -- the
    thing a depth map alone always comes back as (research 34: "geometry
    followed exactly, but drawn literally").
    """
    named = [label for label, share in sees if share >= 0.01][:4]
    subject = (
        "the buildings this camera faces"
        if not named
        else ", ".join(named[:-1]) + " and " + named[-1]
        if len(named) > 1
        else named[0]
    )
    style = medium or "hand-drawn ink and watercolour"
    if grounded:
        # The map is the only geometry sent. The camera is words, because a box
        # proxy alongside it is the conflicting instruction research 19 caught.
        return (
            "Image 1 is this town's own map seen from directly above, and it is the truth about "
            "what stands here: draw THESE buildings, with their own roof colours, shapes and "
            f"arrangement, and the spaces between them. You are standing among them facing "
            f"{subject}. Draw what that person actually sees at eye level, about 1.7 metres "
            "above the ground: those same buildings seen from the street, with doorways, "
            "shuttered windows, awnings, barrels and crates, worn cobbles underfoot and a soft "
            f"overcast sky. {style}. A view from INSIDE the town at human height -- not a map, "
            "not an aerial or bird's-eye view. No lettering, no words, no people."
        )
    return (
        "Image 1 is a depth render from an exact camera: bright is near, dark is far, "
        "black is sky. Every wall, roofline and corner sits where it puts them, and no "
        f"building stands where it shows sky. This view looks at {subject}. Draw it at "
        "eye level as a place a person is standing in, and let the street be lived in: "
        "doorways with real depth, shuttered windows, awnings, barrels and crates, worn "
        f"cobbles, a soft overcast sky. {style}. Do not move the camera. No lettering, "
        "no words, no people."
    )


def _frame_model(grounded: bool) -> str:
    """The enter model when a shot carries its map, else the camera-holder."""
    if grounded:
        return os.environ.get("FAL_WALK_ENTER_MODEL") or ENTER_MODEL
    return os.environ.get("FAL_WALK_KEYFRAME_MODEL") or KEYFRAME_MODEL


def _clip_model() -> str:
    """Whichever slug the descent slot will actually call."""
    from providers import video

    return os.environ.get("FAL_DESCENT_MODEL") or video.DESCENT_ANIMATE_MODEL


def estimate_usd(
    shots: int, clip_seconds: int = DEFAULT_CLIP_SECONDS, grounded: bool = False
) -> float:
    """What a walk of this many shots would cost, before any of it runs."""
    from providers import spend

    shots = max(0, min(shots, MAX_SHOTS))
    frames = spend.estimate_image(_frame_model(grounded)) * shots
    clips = spend.estimate_video(_clip_model()) * max(0, shots - 1)
    return round(frames + clips, 4)


async def paint(
    *,
    session_id: str,
    shots: list[WalkShot],
    style_ref_url: str | None = None,
    medium: str | None = None,
    clip_seconds: int = DEFAULT_CLIP_SECONDS,
) -> Walk:
    """Paint every shot, then link the neighbours."""
    from obs import log, span
    from providers import image_edit, spend, video
    from providers.image import encode_data_url

    if not shots:
        raise ValueError("a walk needs at least one shot")
    if len(shots) > MAX_SHOTS:
        raise ValueError(f"a walk is capped at {MAX_SHOTS} shots, got {len(shots)}")

    spent = 0.0
    keyframes: list[str] = []
    for shot in shots:
        # A shot carrying its map is painted through the enter path, from the
        # map ALONE -- see ENTER_MODEL for why the box render stays behind.
        grounded = bool(shot.surroundings_data_url)
        model_override = _frame_model(grounded)
        frame_usd = spend.estimate_image(model_override)
        # Reserve BEFORE submitting: a timeout cannot prove the provider did
        # not bill, and a walk is many calls in a row where that adds up.
        spend.reserve(session_id, frame_usd)
        spent += frame_usd
        # Painted alone, neighbouring keyframes drew the same street in two
        # different ways, and a clip between them could only jump (2026-09-20:
        # seams measured 55; chained, 5.8). Hand each shot its predecessor.
        previous = keyframes[-1] if keyframes else None
        chained = previous is not None and image_edit.supports_identity_reference(model_override)
        instruction = shot_instruction(shot.sees, medium, grounded)
        if chained:
            instruction += CHAIN_CLAUSE
        async with span("walk.keyframe", shot=shot.index, grounded=grounded, chained=chained):
            image = await image_edit.edit_image(
                shot.surroundings_data_url or shot.control_data_url,
                instruction,
                model_override=model_override,
                style_ref_url=style_ref_url,
                identity_ref_url=previous if chained else None,
            )
        keyframes.append(encode_data_url(image.jpeg_bytes, image.mime_type))

    clips: list[WalkClip] = []
    clip_usd = spend.estimate_video(_clip_model())
    for i in range(len(keyframes) - 1):
        spend.reserve(session_id, clip_usd)
        spent += clip_usd
        async with span("walk.clip", frm=i, to=i + 1):
            clip = await video.animate_image(
                image_data_url=keyframes[i],
                prompt=_clip_prompt(shots[i].sees, shots[i + 1].sees),
                duration=clip_seconds,
                end_image_data_url=keyframes[i + 1],
            )
        clips.append(
            WalkClip(
                from_shot=shots[i].index,
                to_shot=shots[i + 1].index,
                video_url=clip.video_url,
                model=clip.model,
                seconds=clip.duration_seconds,
            )
        )

    log("info", "walk.done", shots=len(shots), clips=len(clips), usd=round(spent, 3))
    return Walk(keyframes=keyframes, clips=clips, spent_usd=round(spent, 4))


def _clip_prompt(frm: list[tuple[str, float]], to: list[tuple[str, float]]) -> str:
    """The move between two shots, named by what is gained along the way."""
    # "A forward walk toward X" sent every live clip into the nearest facade,
    # then snapped it onto the next keyframe (2026-09-24). Describe the walk
    # the route makes: along the street, turning with it, landing on the view.
    ahead = [label for label, share in to if share >= 0.02][:2]
    past = f" past {' and '.join(ahead)}" if ahead else ""
    return (
        f"The camera walks along the street{past} at a steady walking pace and eye "
        "height, turning gradually as the street turns, and arrives exactly on the "
        "final view. It stays in the open street, keeps its distance from the "
        "buildings, and never pushes up to a wall, door or window. Every building, "
        "window, shutter, awning, doorway and the cobbles keep their exact hand-drawn "
        "appearance. One unbroken shot, no cuts, no people, no lettering."
    )
