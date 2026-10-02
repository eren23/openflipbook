"""Paint a drawn route: a keyframe at every shot, a clip between neighbours.

A route gives cameras; a shot gives that camera plus the places it can see and
how much of the frame each one covers. Both come free from the block render,
so the walk knows what every picture is OF before it spends anything.

Two paid halves, in this order:

* **Keyframes.** Each shot's block render is handed to the edit model that
  holds a camera (research 34 measured five: qwen-image-edit-2511 at IoU
  0.944, centre within 0.5%, area 1.00 -- the rest re-frame). The geometry
  comes from the render, the subject from what the shot sees.
* **Clips.** Neighbouring keyframes (index n and n+1) go to the descent
  slot, which honours `end_image_url` and lands square on the arrival frame.
  Measured over a chained walk: joins differ by 6-7 against 22 between
  neighbouring keyframes, so a seam reads as motion rather than a cut. A
  skipped shot is a cut: no clip spans the gap it leaves.

Nothing is concatenated here -- the runtime image carries no ffmpeg, and an
ordered list of clips plays back to back just as well.
"""

from __future__ import annotations

import math
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


@dataclass(frozen=True)
class WalkShot:
    """One camera on the route, and what the block render says it sees."""

    index: int
    control_data_url: str
    sees: list[tuple[str, float]] = field(default_factory=list)
    # The map around this camera, if the caller cropped one. Its presence is
    # what switches a shot from "a street with this geometry" to "this town".
    surroundings_data_url: str | None = None
    # Observer gaze, radians: 0 faces +x (east); map y points down (south).
    gaze: float | None = None


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
    gaze: float | None = None,
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
        from providers.prompt_library.camera import gaze_to_compass

        # The map is the only geometry sent. The camera is words, because a box
        # proxy alongside it is the conflicting instruction research 19 caught.
        # The crop is centred ahead of the walker, so they stand behind centre.
        where = (
            ""
            if gaze is None
            else f"You stand just {gaze_to_compass(gaze + math.pi)} of the centre of Image 1, "
            f"facing {gaze_to_compass(gaze)}; north is up. "
        )
        return (
            "Image 1 is this town's own map seen from directly above, and it is the truth about "
            "what stands here: draw THESE buildings, with their own roof colours, shapes and "
            f"arrangement, and the spaces between them. {where}You are standing among them facing "
            f"{subject}. Draw what that person actually sees at eye level, about 1.7 metres "
            "above the ground: those same buildings seen from the street, with doorways, "
            "shuttered windows, awnings, barrels and crates, worn cobbles underfoot and a soft "
            f"overcast sky. {style}. A view from INSIDE the town at human height -- not a map, "
            "not an aerial or bird's-eye view. No lettering, no words, no people."
        )
    return (
        "Image 1 is a flat-colour block render from an exact camera: each colour is one "
        "building with a pitched roof, the dark-brown ground is the ground and the pale-grey "
        "sky is sky. The block colours only name the blocks -- do not paint walls in those "
        "colours. Every wall, roofline and corner sits where it puts them, and no "
        f"building stands where it shows sky. This view looks at {subject}. Draw it at "
        "eye level as a place a person is standing in, and let the street be lived in: "
        "recessed doorways, shuttered windows, awnings, barrels and crates, worn "
        f"cobbles, a soft overcast sky. {style}. Do not move the camera. No lettering, "
        "no words, no people."
    )


def _frame_model(grounded: bool) -> str:
    """The enter model when a shot carries its map, else the camera-holder."""
    if grounded:
        return os.environ.get("FAL_WALK_ENTER_MODEL") or ENTER_MODEL
    return os.environ.get("FAL_WALK_KEYFRAME_MODEL") or KEYFRAME_MODEL


def _clip_usd(clip_seconds: int) -> float:
    """One clip on the descent slot, at the seconds it will actually bill."""
    from providers import video

    return video.estimate_usd(clip_seconds, descent=True)


def linked(indices: list[int]) -> list[int]:
    """Positions whose next shot is the very next index: those get a clip."""
    return [i for i in range(len(indices) - 1) if indices[i + 1] == indices[i] + 1]


def painted(indices: list[int]) -> list[int]:
    """Positions worth painting: all of a lone shot, else only those a clip reaches.

    A shot with no neighbour would be paid for and shown, then never walked to.
    """
    if len(indices) < 2:
        return list(range(len(indices)))
    return sorted({p for i in linked(indices) for p in (i, i + 1)})


def estimate_usd(
    shots: int,
    clip_seconds: int = DEFAULT_CLIP_SECONDS,
    grounded: bool = False,
    links: int | None = None,
) -> float:
    """What a walk would cost, before any of it runs.

    `links` is how many clips it makes (see `linked`); unset means every
    neighbour is linked.
    """
    from providers import spend

    shots = max(0, min(shots, MAX_SHOTS))
    links = max(0, shots - 1 if links is None else min(links, shots - 1))
    frames = spend.estimate_image(_frame_model(grounded)) * shots
    return round(frames + _clip_usd(clip_seconds) * links, 4)


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
    shots = [shots[p] for p in painted([s.index for s in shots])]
    if not shots:
        raise ValueError("no shot on this route has a neighbour to walk to")

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
        async with span("walk.keyframe", shot=shot.index, grounded=grounded):
            image = await image_edit.edit_image(
                shot.surroundings_data_url or shot.control_data_url,
                shot_instruction(shot.sees, medium, grounded, shot.gaze),
                model_override=model_override,
                style_ref_url=style_ref_url,
            )
        keyframes.append(encode_data_url(image.jpeg_bytes, image.mime_type))

    clips: list[WalkClip] = []
    clip_usd = _clip_usd(clip_seconds)
    for i in linked([s.index for s in shots]):
        spend.reserve(session_id, clip_usd)
        spent += clip_usd
        async with span("walk.clip", frm=i, to=i + 1):
            clip = await video.animate_image(
                image_data_url=keyframes[i],
                prompt=_clip_prompt(shots[i], shots[i + 1]),
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


def _clip_prompt(frm: WalkShot, to: WalkShot) -> str:
    """The move between two shots: the turn the gaze makes, toward what is gained.

    /play units are not metres, so the walk forward stays unmeasured.
    """
    from providers import video

    ahead = [label for label, share in to.sees if share >= 0.02][:2]
    turn = 0.0
    if frm.gaze is not None and to.gaze is not None:
        # Map y points down, so a growing gaze turns right. Short way round.
        turn = (math.degrees(to.gaze - frm.gaze) + 180) % 360 - 180
    return video.move_prompt(turn_deg=turn, forward_m=None, subject=" and ".join(ahead))
