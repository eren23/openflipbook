"""Paint a drawn route as one walk, stop by stop.

A route gives cameras: the stops ("snap points") of the walk. At each stop
the block render says where the camera stands, where it goes next, and which
known places it sees, left to right, with their stored descriptions. Only
those places are named, so the model draws what the world holds instead of
inventing a street.

Three paid steps:

* **Keyframe.** The first stop, and each stop after a real turn, is painted
  from its block render and its spec by the edit model that holds a camera
  (research 34: qwen-image-edit-2511, IoU 0.944, the rest re-frame).
* **Legs.** Between stops the camera pushes straight ahead with fal's MiniMax
  H3 camera-controls. The scene stays frozen and only the camera moves, so
  the motion comes from the route, not from the model. Start/end
  image-to-video invented its own move ("just turning to its right",
  2026-09-24). Calibrated the same day on a quay frame: `distance` is a clean
  dolly toward the frame centre (snap max 4.6-7.6 against 20-34 before), but
  `azimuth` ORBITS the subject in the centre -- it is not a head turn. So a
  leg never turns: a turn above TURN_CUT_DEG cuts to a new keyframe at the
  new heading, painted from real geometry.
* **Snap check.** A leg's last frame is judged against the next stop's spec.
  Under the gate it is corrected in place by the camera-holding edit model,
  and the next leg starts from the corrected frame.

The legs are merged into one video by fal's ffmpeg API; the runtime image
carries no ffmpeg.
"""

from __future__ import annotations

import asyncio
import base64
import os
import statistics
from dataclasses import dataclass, field
from typing import Any

# The one edit model measured to keep the camera it was given (research 34).
KEYFRAME_MODEL = "fal-ai/qwen-image-edit-2511"
LEG_MODEL = "minimax/h3-max/camera-controls"
LEG_RESOLUTION = "768P"
EXTRACT_MODEL = "fal-ai/ffmpeg-api/extract-frame"
MERGE_MODEL = "fal-ai/ffmpeg-api/merge-videos"
# A walk is many paid calls in a row, so it gets its own ceiling rather than
# riding the per-generation render budget.
MAX_SHOTS = 12
DEFAULT_CLIP_SECONDS = 5
# Above this the next stop is a cut to a new keyframe. H3's azimuth orbits
# the centre subject, so any turn it draws is a swing around a building.
TURN_CUT_DEG = 12.0
# How close a push may get to the thing ahead, as a share of the start
# distance. Nearer than this the frame is one wall.
MIN_PUSH = 0.3
# Spec-conformance median (0-10) under which a stop is corrected.
SNAP_GATE = 6.0
SNAP_SAMPLES = 3
# Keyframe 0's Image 2 is the town's map: HOW the town is drawn, not where.
STYLE_CLAUSE = (
    " Image 2 shows how this town is drawn. Match its medium, line work, palette "
    "and roof colours. Do not copy its view or its layout."
)

_H_ORDER = ("far-left", "left", "center-left", "center", "center-right", "right", "far-right")
_AHEAD = {"center-left", "center", "center-right"}


@dataclass(frozen=True)
class SeenObject:
    """One known place in a stop's view, from the block render."""

    label: str
    h_pos: str = "center"
    distance: float | None = None
    share: float = 0.0
    visual: str = ""
    # Its block's colour in the control render; None for a grey block.
    color: str | None = None


@dataclass(frozen=True)
class GroundFeature:
    """Water, a quay or a square the blocks skip, placed by side."""

    label: str
    side: str
    visual: str = ""


@dataclass(frozen=True)
class WalkShot:
    """One stop on the route, and what the block render says is there."""

    index: int
    control_data_url: str
    sees: list[tuple[str, float]] = field(default_factory=list)
    objects: list[SeenObject] = field(default_factory=list)
    ground: list[GroundFeature] = field(default_factory=list)
    # The move to the NEXT stop; None on the last one.
    forward: float | None = None
    turn_deg: float = 0.0

    def seen(self) -> list[SeenObject]:
        """The places in view, left to right. An old client sends names only."""
        if self.objects:
            return sorted(
                self.objects,
                key=lambda o: _H_ORDER.index(o.h_pos) if o.h_pos in _H_ORDER else 3,
            )
        return [SeenObject(label=label, share=share) for label, share in self.sees if share >= 0.01]


@dataclass(frozen=True)
class WalkClip:
    from_shot: int
    to_shot: int
    video_url: str
    model: str
    seconds: float


@dataclass(frozen=True)
class Snap:
    """The frame a stop ends on, and whether the snap check changed it."""

    index: int
    image_url: str
    corrected: bool = False
    conformance: float | None = None


@dataclass(frozen=True)
class Walk:
    keyframes: list[str]
    clips: list[WalkClip]
    spent_usd: float
    snaps: list[Snap] = field(default_factory=list)
    video_url: str | None = None


def _nearness(distance: float | None) -> str:
    if distance is None:
        return ""
    if distance < 8:
        return ", close by"
    if distance < 25:
        return ", a short walk away"
    return ", in the distance"


def describe(shot: WalkShot, blocks: bool = False) -> str:
    """The stop in words: the known places in view, left to right, and the ground.

    With `blocks`, each place is tied to its coloured block in the control
    render, so the name lands on the right geometry.
    """
    seen = shot.seen()
    if seen:
        items = [
            f"{o.label} ("
            + (f"the {o.color} block, " if blocks and o.color else "")
            + f"{o.h_pos.replace('-', ' ')}{_nearness(o.distance)})"
            + (f": {o.visual}" if o.visual else "")
            for o in seen
        ]
        text = "From left to right this camera sees: " + "; ".join(items) + "."
    else:
        text = "This camera faces an open street with no named building in view."
    for g in shot.ground:
        if g.side == "behind":
            continue
        where = "ahead of you" if g.side == "ahead" else f"on your {g.side}"
        text += f" {g.label} is {where}" + (f" ({g.visual})" if g.visual else "") + "."
    return text


def keyframe_instruction(shot: WalkShot, medium: str | None = None, styled: bool = False) -> str:
    """What to paint at a stop: the render's geometry, the spec's places, nothing else."""
    style = medium or "hand-drawn ink and watercolour"
    return (
        "Image 1 is a block render from an exact camera at eye level. Each coloured "
        "block is one building, standing where it must stand in the picture; a grey "
        "block is another building; the brown floor is the ground and the pale grey is "
        f"sky. {describe(shot, blocks=True)} Paint each block as the place it is, as "
        "described, keeping its position and size, and fill the rest with plain street, "
        "cobbles and sky. Do not add any other named building, tower or landmark. "
        f"{style}. A view from inside the "
        "town at human height, about 1.7 metres up -- not a map, not an aerial view. Do "
        "not move the camera. No lettering, no words, no people."
        + (STYLE_CLAUSE if styled else "")
    )


def correction_instruction(shot: WalkShot) -> str:
    """Fix a leg's last frame to what stands at the stop, camera untouched."""
    return (
        "Image 1 is a frame from a walk through this town. Keep the camera, the "
        f"framing and the drawing style exactly. {describe(shot)} Change only what is "
        "wrong or missing so the frame shows these places where they are. Do not add "
        "any other named building. No lettering, no words, no people."
    )


def leg_prompt(to: WalkShot) -> str:
    """The move between two stops, named by what comes into view."""
    ahead = [o.label for o in to.seen() if o.h_pos in _AHEAD][:2]
    toward = f" toward {' and '.join(ahead)}" if ahead else ""
    return (
        "The reference image is one frozen instant in this town. Only the camera moves: "
        f"it walks straight ahead at eye level along the open street{toward}. Every "
        "building, boat and object stays exactly where it is and keeps its hand-drawn "
        f"look. As the camera moves on: {describe(to)} No new buildings, no people, no "
        "lettering."
    )


def push(shot: WalkShot) -> list[dict[str, float]]:
    """A straight dolly toward the frame centre, as far as the move goes.

    H3's `distance` is relative to the subject in the centre, so the ratio is
    what is left of the way to it after the move.
    """
    ahead = [o.distance for o in shot.seen() if o.h_pos in _AHEAD and o.distance]
    end = 0.5
    if ahead and shot.forward:
        end = 1.0 - shot.forward / min(ahead)
    end = round(min(0.9, max(MIN_PUSH, end)), 3)
    return [
        {"time": 0.0, "azimuth": 0.0, "elevation": 0.0, "distance": 1.0},
        {"time": 1.0, "azimuth": 0.0, "elevation": 0.0, "distance": end},
    ]


def _cuts_after(shot: WalkShot) -> bool:
    return abs(shot.turn_deg) > TURN_CUT_DEG


def _keyframe_model() -> str:
    return os.environ.get("FAL_WALK_KEYFRAME_MODEL") or KEYFRAME_MODEL


def estimate_usd(shots: int, clip_seconds: int = DEFAULT_CLIP_SECONDS) -> float:
    """What a walk of this many stops can cost at most, before any of it runs.

    Every stop is priced as if it needs an edit (a keyframe or a correction).
    """
    from providers import spend

    shots = max(0, min(shots, MAX_SHOTS))
    frames = spend.estimate_image(_keyframe_model()) * shots
    legs = spend.estimate_video(LEG_MODEL, clip_seconds) * max(0, shots - 1)
    return round(frames + legs, 4)


async def _image_bytes(url: str) -> bytes:
    from providers.image import _fetch_image_bytes

    if url.startswith("data:"):
        return base64.b64decode(url.partition(",")[2])
    data, _mime = await _fetch_image_bytes({"url": url})
    return data


async def _conformance(frame_url: str, shot: WalkShot) -> float | None:
    """Median spec-conformance of a frame, or None when no judge could answer.

    A judge that fails leaves the frame as it is: the walk goes on rather than
    paying for a correction it cannot justify.
    """
    from obs import log
    from providers import judge, mock

    if mock.on():
        return None
    image = await _image_bytes(frame_url)
    spec = {
        "objects": [{"label": o.label, "h_pos": o.h_pos, "visual": o.visual} for o in shot.seen()],
        "ground": [{"label": g.label, "side": g.side} for g in shot.ground],
    }
    results = await asyncio.gather(
        *(judge.score_spec_conformance(image, spec) for _ in range(SNAP_SAMPLES)),
        return_exceptions=True,
    )
    scores = [r.score for r in results if not isinstance(r, BaseException)]
    if not scores:
        log("warning", "walk.snap.judge_failed", shot=shot.index)
        return None
    return float(statistics.median(scores))


async def _last_frame(video_url: str) -> str:
    from providers import mock
    from providers.image import _fal_subscribe, _first_image, encode_data_url

    if mock.on():
        m = mock.mock_image("walk last frame", op="edit")
        return encode_data_url(m.jpeg_bytes, m.mime_type)
    result = await _fal_subscribe(
        EXTRACT_MODEL, {"video_url": video_url, "frame_type": "last"}, require_images=True
    )
    url = _first_image(result).get("url")
    if not isinstance(url, str) or not url:
        raise RuntimeError("fal extract-frame returned no url")
    return url


async def _merge(video_urls: list[str]) -> str | None:
    from providers import mock
    from providers.image import _fal_subscribe

    if len(video_urls) < 2:
        return video_urls[0] if video_urls else None
    if mock.on():
        return video_urls[0]
    result: dict[str, Any] = await _fal_subscribe(MERGE_MODEL, {"video_urls": video_urls})
    url = (result.get("video") or {}).get("url")
    return url if isinstance(url, str) and url else None


async def paint(
    *,
    session_id: str,
    shots: list[WalkShot],
    style_ref_url: str | None = None,
    medium: str | None = None,
    clip_seconds: int = DEFAULT_CLIP_SECONDS,
) -> Walk:
    """Paint the first stop, push to each next one, check it, merge the legs."""
    from obs import log, span
    from providers import image_edit, spend, video
    from providers.image import encode_data_url

    if not shots:
        raise ValueError("a walk needs at least one shot")
    if len(shots) > MAX_SHOTS:
        raise ValueError(f"a walk is capped at {MAX_SHOTS} shots, got {len(shots)}")

    spent = 0.0
    model = _keyframe_model()
    edit_usd = spend.estimate_image(model)
    leg_usd = spend.estimate_video(LEG_MODEL, clip_seconds)
    snaps: list[Snap] = []
    clips: list[WalkClip] = []
    frame = ""
    for i, shot in enumerate(shots):
        if i == 0 or _cuts_after(shots[i - 1]):
            # Reserve BEFORE submitting: a timeout cannot prove the provider
            # did not bill, and a walk is many calls in a row.
            spend.reserve(session_id, edit_usd)
            spent += edit_usd
            async with span("walk.keyframe", shot=shot.index, cut=i > 0):
                image = await image_edit.edit_image(
                    shot.control_data_url,
                    keyframe_instruction(shot, medium, styled=bool(style_ref_url)),
                    model_override=model,
                    style_ref_url=style_ref_url,
                )
            frame = encode_data_url(image.jpeg_bytes, image.mime_type)
            snaps.append(Snap(index=shot.index, image_url=frame))
        else:
            score = await _conformance(frame, shot)
            corrected = score is not None and score < SNAP_GATE
            if corrected:
                spend.reserve(session_id, edit_usd)
                spent += edit_usd
                async with span("walk.correct", shot=shot.index, score=score):
                    image = await image_edit.edit_image(
                        frame, correction_instruction(shot), model_override=model
                    )
                frame = encode_data_url(image.jpeg_bytes, image.mime_type)
            snaps.append(
                Snap(index=shot.index, image_url=frame, corrected=corrected, conformance=score)
            )
        if i == len(shots) - 1:
            break
        spend.reserve(session_id, leg_usd)
        spent += leg_usd
        async with span("walk.leg", frm=shot.index, to=shots[i + 1].index):
            leg = await video.camera_controls(
                image_data_url=frame,
                prompt=leg_prompt(shots[i + 1]),
                trajectory=push(shot),
                duration=clip_seconds,
                resolution=LEG_RESOLUTION,
            )
        clips.append(
            WalkClip(
                from_shot=shot.index,
                to_shot=shots[i + 1].index,
                video_url=leg.video_url,
                model=leg.model,
                seconds=leg.duration_seconds,
            )
        )
        if not _cuts_after(shot):
            frame = await _last_frame(leg.video_url)

    merged = await _merge([c.video_url for c in clips])
    log(
        "info",
        "walk.done",
        shots=len(shots),
        clips=len(clips),
        corrected=sum(s.corrected for s in snaps),
        usd=round(spent, 3),
    )
    return Walk(
        keyframes=[s.image_url for s in snaps],
        clips=clips,
        spent_usd=round(spent, 4),
        snaps=snaps,
        video_url=merged,
    )
