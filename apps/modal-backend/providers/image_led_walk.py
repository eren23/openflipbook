"""Source-art-led walking drafts; callers own authorization and durable claims.

This provider has no saved-camera, depth, render or physical-opening contract.
Optional repair masks scope pixel edits in a supplied image; they are not derived
3D masks. A route point is an approximate marker in the original image, including
when that image is an oblique illustration. It is not a metric pose.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import os
import unicodedata
from collections.abc import Sequence
from decimal import Decimal
from typing import Any, Literal, Self
from urllib.parse import urlsplit

import fal_client
import httpx
from fal_client.client import FalClientHTTPError
from fastapi import APIRouter, HTTPException
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, model_validator

from _env import env_flag
from providers import camera_motion
from providers._common import to_fal_url
from providers.camera_motion import post_once, valid_request_id
from providers.video import h3_arguments

router = APIRouter(prefix="/image-led-walk")
MODEL = "fal-ai/nano-banana-pro/edit"
PROFILE = "image-led-v1"
MIN_RESERVATION_USD = 0.15  # Operator reservation floor, not a provider price guarantee.
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_INPUT_BYTES = 40 * 1024 * 1024
PARAMETERS: dict[str, object] = {
    "num_images": 1,
    "output_format": "png",
    "aspect_ratio": "16:9",
    "resolution": "1K",
    "seed": 42,
    "safety_tolerance": "4",
    "limit_generations": True,
    "enable_web_search": False,
    "sync_mode": False,
    "prompt_version": "image-led-walk-v4",
}
SUNBURST_MODEL = "openai/gpt-image-2.5/sunburst/edit"
FLUX_MODEL = "blackforestlabs/flux-3/edit-image"
SEEDREAM_MODEL = "bytedance/seedream/v5/pro/edit"
# Closed operator profiles. Provider fields are intentionally model-specific:
# FLUX has no num_images/seed; Seedream has no aspect_ratio/resolution/seed.
STILL_PROFILES: dict[str, dict[str, Any]] = {
    MODEL: {"parameters": PARAMETERS, "max_references": 14, "mask": False,
            "reservation_env": "IMAGE_LED_WALK_RESERVATION_USD"},
    SUNBURST_MODEL: {
        "parameters": {"image_size": {"width": 1536, "height": 864}, "quality": "high",
                       "background": "opaque", "num_images": 1, "output_format": "png",
                       "sync_mode": False, "prompt_version": "image-led-walk-v4"},
        "max_references": 16, "mask": True,
        "reservation_env": "IMAGE_LED_WALK_SUNBURST_RESERVATION_USD",
    },
    FLUX_MODEL: {
        "parameters": {"aspect_ratio": "16:9", "resolution": "1k",
                       "enable_prompt_expansion": False, "safety_tolerance": 4,
                       "output_format": "png", "sync_mode": False,
                       "prompt_version": "image-led-walk-v4"},
        "max_references": 10, "mask": False,
        "reservation_env": "IMAGE_LED_WALK_FLUX3_RESERVATION_USD",
    },
    SEEDREAM_MODEL: {
        "parameters": {"image_size": {"width": 1536, "height": 864}, "num_images": 1,
                       "output_format": "png", "enable_safety_checker": True,
                       "enhance_prompt_mode": "standard", "sync_mode": False,
                       "prompt_version": "image-led-walk-v4"},
        "max_references": 10, "mask": False,
        "reservation_env": "IMAGE_LED_WALK_SEEDREAM5_RESERVATION_USD",
    },
}
VIDEO_MODEL = camera_motion.LEG_MODEL
VIDEO_SECONDS = 3
VIDEO_PARAMETERS: dict[str, object] = {
    "duration": VIDEO_SECONDS, "resolution": "768P", "prompt_expansion_mode": "disabled",
    "enable_safety_checker": True, "sync_mode": False,
    "prompt_version": "image-led-walk-video-v4",
}
# Copy-first stills (research 41-43): one depth request; the web worker warps the reviewed prior's own pixels.
DEPTH_MODEL = "fal-ai/image-preprocessors/depth-anything/v2"
COPY_FIRST_WARP_VERSION = "copy-first-warp-v1"


def configuration() -> dict[str, object]:
    model = os.environ.get("IMAGE_LED_WALK_MODEL", MODEL)
    selected = STILL_PROFILES.get(model)
    try:
        reservation = float(os.environ.get(selected["reservation_env"], "0")) if selected else 0
    except ValueError:
        reservation = 0
    enabled = (
        os.environ.get("IMAGE_LED_WALK_ENABLED") == "1"
        and not env_flag("MOCK_PROVIDERS")
        and bool(os.environ.get("FAL_KEY"))
        and bool(os.environ.get("SHARED_TOKEN"))
        and selected is not None
        and math.isfinite(reservation)
        and MIN_RESERVATION_USD <= reservation <= 10
    )
    return {
        "enabled": enabled,
        "profile": PROFILE,
        "model": model if selected else None,
        "reservation": reservation if enabled else 0,
        "parameters": selected["parameters"] if selected else {},
        "spatial_validation": "unmeasured",
        "identity_validation": "owner_review_required",
        "reason": None if enabled else (
            "Image-led walking needs explicit enablement, provider/shared keys and "
            "an allowlisted IMAGE_LED_WALK_MODEL and its explicit model-specific operator reservation of at least $0.15 per image."
        ),
    }


@router.get("/capabilities")
async def capabilities() -> dict[str, object]:
    return configuration()


def video_configuration() -> dict[str, object]:
    motion = camera_motion.configuration()
    enabled = os.environ.get("IMAGE_LED_WALK_ENABLED") == "1" and motion["enabled"] is True
    reservation = float(Decimal(str(motion["reservation_usd_per_second"])) * VIDEO_SECONDS) if enabled else 0
    return {
        "enabled": enabled, "profile": PROFILE, "model": VIDEO_MODEL,
        "reservation": reservation, "parameters": VIDEO_PARAMETERS,
        "spatial_validation": "unmeasured", "temporal_validation": "owner_review_required",
        "reason": None if enabled else (
            "Image-led video needs explicit image-led enablement and the existing "
            "motion provider/shared keys and operator-set 768P rate."
        ),
    }


@router.get("/video/capabilities")
async def video_capabilities() -> dict[str, object]:
    return video_configuration()


def copy_first_configuration() -> dict[str, object]:
    def number(name: str, default: str) -> float:
        try:
            return float(os.environ.get(name, default))
        except ValueError:
            return math.nan
    reservation = number("IMAGE_LED_WALK_COPY_FIRST_RESERVATION_USD", "0")
    tz = number("IMAGE_LED_WALK_COPY_FIRST_TZ", "0.10")
    max_turn = number("IMAGE_LED_WALK_COPY_FIRST_MAX_TURN_DEGREES", "3")
    enabled = (  # NaN fails every comparison below
        os.environ.get("IMAGE_LED_WALK_ENABLED") == "1"
        and os.environ.get("IMAGE_LED_WALK_COPY_FIRST_ENABLED") == "1"
        and not env_flag("MOCK_PROVIDERS")
        and bool(os.environ.get("FAL_KEY"))
        and bool(os.environ.get("SHARED_TOKEN"))
        and 0.01 <= reservation <= MIN_RESERVATION_USD
        and 0 < tz <= 0.3
        and 0 <= max_turn <= 10
    )
    return {
        "enabled": enabled, "profile": PROFILE, "model": DEPTH_MODEL,
        "reservation": reservation if enabled else 0,
        "parameters": {"tz": tz, "max_turn_degrees": max_turn, "pitch_degrees": 0, "offset": 0.4,
                       "fov_degrees": 60, "bg_fill": True, "warp_version": COPY_FIRST_WARP_VERSION} if enabled else {},
        "spatial_validation": "unmeasured", "identity_validation": "owner_review_required",
        "reason": None if enabled else (
            "Copy-first stills need image-led enablement, IMAGE_LED_WALK_COPY_FIRST_ENABLED=1, provider/shared keys "
            "and an explicit depth reservation of $0.01 to $0.15 per step."
        ),
    }


@router.get("/copy-first/capabilities")
async def copy_first_capabilities() -> dict[str, object]:
    return copy_first_configuration()


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class SourceImage(StrictInput):
    url: str = Field(max_length=17 * 1024 * 1024)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    bytes: int = Field(gt=0, le=MAX_IMAGE_BYTES)
    width: int = Field(ge=32, le=4096)
    height: int = Field(ge=32, le=4096)


class SourceRectangle(StrictInput):
    left: int = Field(ge=0)
    top: int = Field(ge=0)
    width: int = Field(ge=32)
    height: int = Field(ge=32)


class LandmarkIdentity(StrictInput):
    id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_-]+$")
    label: str = Field(min_length=1, max_length=160)
    visual: str = Field(min_length=1, max_length=1024)


class Landmark(LandmarkIdentity):
    source_rectangle: SourceRectangle
    image: SourceImage


class RoutePoint(StrictInput):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


class Route(StrictInput):
    frame: Literal["original-image-normalized"]
    points: list[RoutePoint] = Field(min_length=2, max_length=12)
    checkpoint_index: int = Field(ge=0, le=11)
    map_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class RouteMapDimensions(StrictInput):
    width: int = Field(ge=32, le=4096)
    height: int = Field(ge=32, le=4096)


class RouteLandmarkRelation(StrictInput):
    id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_-]+$")
    label: str = Field(min_length=1, max_length=160)
    anchor: RoutePoint
    relative_bearing_degrees: float = Field(ge=-180, le=180)
    sector: Literal["ahead", "ahead_left", "left", "behind_left", "behind", "behind_right", "right", "ahead_right", "at_checkpoint"]


class RouteCheckpointIntent(StrictInput):
    index: int = Field(ge=0, le=11)
    point: RoutePoint
    heading_degrees: float = Field(ge=0, lt=360)
    turn_from_previous_degrees: float = Field(ge=-180, lt=180)
    turn: Literal["start", "continue", "left", "right", "end"]
    landmark_relations: list[RouteLandmarkRelation] = Field(min_length=1, max_length=8)


class RouteIntent(StrictInput):
    version: int = Field(ge=1, le=1)
    basis: Literal["source-image-pixels"]
    registration: Literal["estimated"]
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    map_dimensions: RouteMapDimensions
    checkpoint_index: int = Field(ge=0, le=11)
    checkpoints: list[RouteCheckpointIntent] = Field(min_length=2, max_length=12)


def _round_angle(value: float) -> float:
    # Match Math.round(v * 1e6) / 1e6, including negative half-way values.
    return math.floor(value * 1_000_000 + 0.5) / 1_000_000


def _angle_delta(value: float) -> float:
    return (value + 180) % 360 - 180


def build_route_intent(route: Route, source_sha256: str, width: int, height: int,
                       landmarks: Sequence[LandmarkIdentity], anchors: Sequence[RoutePoint]) -> dict[str, Any]:
    """Image-plane bearings only; crop centroids do not establish physical visibility."""
    if len(landmarks) != len(anchors) or len(route.points) < 2:
        raise ValueError("Route intent needs one source anchor for each landmark")
    headings = []
    for index, point in enumerate(route.points):
        a, b = (point, route.points[index + 1]) if index + 1 < len(route.points) else (route.points[index - 1], point)
        dx, dy = (b.x - a.x) * width, (b.y - a.y) * height
        if dx == 0 and dy == 0:
            raise ValueError("Route intent has no local direction")
        headings.append(math.degrees(math.atan2(dx, -dy)) % 360)
    sectors = ["ahead", "ahead_right", "right", "behind_right", "behind", "behind_left", "left", "ahead_left"]
    checkpoints = []
    for index, point in enumerate(route.points):
        heading = headings[index]
        delta = _angle_delta(heading - headings[index - 1]) if index else 0.0
        turn = ("start" if index == 0 else "end" if index == len(route.points) - 1
                else "continue" if abs(delta) < 5 else "left" if delta < 0 else "right")
        relations = []
        for landmark, anchor in zip(landmarks, anchors, strict=True):
            dx, dy = (anchor.x - point.x) * width, (anchor.y - point.y) * height
            at_checkpoint = math.hypot(dx, dy) < 1e-6
            relative = 0.0 if at_checkpoint else _angle_delta(math.degrees(math.atan2(dx, -dy)) - heading)
            sector = "at_checkpoint" if at_checkpoint else sectors[math.floor((relative + 22.5) / 45) % 8]
            relations.append({"id": landmark.id, "label": landmark.label, "anchor": anchor.model_dump(),
                              "relative_bearing_degrees": _angle_delta(_round_angle(relative)), "sector": sector})
        checkpoints.append({"index": index, "point": point.model_dump(), "heading_degrees": _round_angle(heading) % 360,
                            "turn_from_previous_degrees": _angle_delta(_round_angle(delta)), "turn": turn,
                            "landmark_relations": relations})
    return {"version": 1, "basis": "source-image-pixels", "registration": "estimated", "source_sha256": source_sha256,
            "map_dimensions": {"width": width, "height": height}, "checkpoint_index": route.checkpoint_index,
            "checkpoints": checkpoints}


def validate_route_intent(intent: RouteIntent, route: Route, source_sha256: str,
                          landmarks: Sequence[LandmarkIdentity], *, source: SourceImage | None = None,
                          rectangles: Sequence[SourceRectangle] | None = None) -> None:
    if intent.source_sha256 != source_sha256 or intent.checkpoint_index != route.checkpoint_index:
        raise ValueError("Route intent belongs to a different source or checkpoint")
    width, height = intent.map_dimensions.width, intent.map_dimensions.height
    if source and (width, height) != (source.width, source.height):
        raise ValueError("Route intent dimensions differ from the original map")
    if len(intent.checkpoints) != len(route.points):
        raise ValueError("Route intent checkpoint inventory differs")
    first = intent.checkpoints[0].landmark_relations
    if len(first) != len(landmarks):
        raise ValueError("Route intent landmark inventory differs")
    anchors = [relation.anchor for relation in first]
    if rectangles:
        for anchor, rectangle in zip(anchors, rectangles, strict=True):
            expected_anchor = ((rectangle.left + rectangle.width / 2) / width, (rectangle.top + rectangle.height / 2) / height)
            if abs(anchor.x - expected_anchor[0]) > 1e-12 or abs(anchor.y - expected_anchor[1]) > 1e-12:
                raise ValueError("Route intent landmark anchor differs from its whole-building source crop")
    expected = build_route_intent(route, source_sha256, width, height, landmarks, anchors)
    for actual, wanted in zip(intent.checkpoints, expected["checkpoints"], strict=True):
        if actual.index != wanted["index"] or actual.point.model_dump() != wanted["point"] or actual.turn != wanted["turn"]:
            raise ValueError("Route intent local direction or turn differs from the source route")
        if (abs(actual.heading_degrees - wanted["heading_degrees"]) > 1e-5
                or abs(actual.turn_from_previous_degrees - wanted["turn_from_previous_degrees"]) > 1e-5):
            raise ValueError("Route intent heading differs from the source pixel aspect")
        if len(actual.landmark_relations) != len(landmarks):
            raise ValueError("Route intent landmark inventory differs")
        for relation, reference in zip(actual.landmark_relations, wanted["landmark_relations"], strict=True):
            if (relation.id != reference["id"] or relation.label != reference["label"]
                    or relation.anchor.model_dump() != reference["anchor"] or relation.sector != reference["sector"]
                    or abs(relation.relative_bearing_degrees - reference["relative_bearing_degrees"]) > 1e-5):
                raise ValueError("Route intent landmark bearing or source association changed")


class ReviewedPrior(StrictInput):
    checkpoint_index: int = Field(ge=0, le=11)
    reviewed_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    image: SourceImage


class StillRepair(StrictInput):
    """An unapproved edit target; it never replaces the reviewed route predecessor."""
    checkpoint_index: int = Field(ge=0, le=11)
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    target_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    image: SourceImage
    mask: SourceImage | None = None


class ImageLedInput(StrictInput):
    profile: Literal["image-led-v1"]
    model: Literal["fal-ai/nano-banana-pro/edit", "openai/gpt-image-2.5/sunburst/edit",
                   "blackforestlabs/flux-3/edit-image", "bytedance/seedream/v5/pro/edit"]
    reservation: float = Field(gt=0, le=10)
    parameters: dict[str, Any]
    prompt: str = Field(min_length=3, max_length=1024)
    source_projection: Literal["illustrated_oblique_or_unknown"]
    source: SourceImage
    landmarks: list[Landmark] = Field(min_length=1, max_length=8)
    route: Route
    route_intent: RouteIntent
    prior: ReviewedPrior | None = None
    repair: StillRepair | None = None

    @model_validator(mode="after")
    def validate_bindings(self) -> Self:
        if len(self.prompt.strip()) < 3:
            raise ValueError("An appearance description is required")
        if self.route.map_sha256 != self.source.sha256:
            raise ValueError("The route must refer to the original source image")
        if self.route.checkpoint_index >= len(self.route.points):
            raise ValueError("The target checkpoint is outside this route")
        if any(a == b for a, b in zip(self.route.points, self.route.points[1:], strict=False)):
            raise ValueError("Adjacent route checkpoints must differ")
        ids = [landmark.id for landmark in self.landmarks]
        labels = [unicodedata.normalize("NFKC", landmark.label.strip()).lower() for landmark in self.landmarks]
        if len(set(ids)) != len(ids) or len(set(labels)) != len(labels) or not all(labels):
            raise ValueError("Landmark identities and labels must be distinct")
        for landmark in self.landmarks:
            r = landmark.source_rectangle
            if not landmark.visual.strip() or r.left + r.width > self.source.width or r.top + r.height > self.source.height:
                raise ValueError("A named architectural reference is outside the original image")
        index = self.route.checkpoint_index
        if index > 0 and self.prior is None:
            raise ValueError("Later views need the immediately preceding reviewed artwork")
        if self.prior and (
            self.prior.reviewed_sha256 != self.prior.image.sha256
            or self.prior.checkpoint_index != (index - 1 if index else 0)
        ):
            raise ValueError("The prior artwork must be reviewed for this route step")
        images = [self.source, *(landmark.image for landmark in self.landmarks)]
        if self.prior:
            images.append(self.prior.image)
        if self.repair:
            if (self.repair.checkpoint_index != index or self.repair.source_sha256 != self.source.sha256
                    or self.repair.target_sha256 != self.repair.image.sha256):
                raise ValueError("Repair provenance differs from its exact source, target or checkpoint")
            images.append(self.repair.image)
            if self.repair.mask:
                if (self.repair.mask.width, self.repair.mask.height) != (self.repair.image.width, self.repair.image.height):
                    raise ValueError("The repair mask must have the exact target dimensions")
                images.append(self.repair.mask)
        if sum(image.bytes for image in images) > MAX_INPUT_BYTES:
            raise ValueError("The image-led input exceeds its total byte limit")
        validate_route_intent(self.route_intent, self.route, self.source.sha256, self.landmarks,
                              source=self.source, rectangles=[landmark.source_rectangle for landmark in self.landmarks])
        return self


class ImageLedVideoInput(StrictInput):
    profile: Literal["image-led-v1"]
    model: Literal["minimax/h3-max/image-to-video"]
    reservation: float = Field(gt=0, le=10)
    parameters: dict[str, Any]
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    route: Route
    route_intent: RouteIntent
    landmarks: list[LandmarkIdentity] = Field(min_length=1, max_length=8)
    start: SourceImage
    end: SourceImage
    prompt: str = Field(min_length=3, max_length=1024)

    @model_validator(mode="after")
    def validate_endpoints(self) -> Self:
        if len(self.prompt.strip()) < 3 or self.route.map_sha256 != self.source_sha256:
            raise ValueError("Video needs source-bound route and appearance")
        if self.route.checkpoint_index + 1 >= len(self.route.points):
            raise ValueError("Video needs two adjacent route checkpoints")
        if any(a == b for a, b in zip(self.route.points, self.route.points[1:], strict=False)):
            raise ValueError("Adjacent route checkpoints must differ")
        if (self.start.width, self.start.height) != (self.end.width, self.end.height):
            raise ValueError("Video endpoint dimensions must agree without implicit stretching")
        if self.start.sha256 == self.end.sha256:
            raise ValueError("Walking endpoints must be distinct reviewed views")
        if max(self.start.bytes, self.end.bytes) > camera_motion.MAX_SOURCE_BYTES:
            raise ValueError("Walking video endpoints exceed 4 MiB")
        ids = [landmark.id for landmark in self.landmarks]
        labels = [unicodedata.normalize("NFKC", landmark.label.strip()).lower() for landmark in self.landmarks]
        if (len(set(ids)) != len(ids) or len(set(labels)) != len(labels)
                or not all(labels) or any(not landmark.visual.strip() for landmark in self.landmarks)):
            raise ValueError("Video landmark architectural identities must be distinct")
        validate_route_intent(self.route_intent, self.route, self.source_sha256, self.landmarks)
        return self


class CopyFirstInput(StrictInput):
    profile: Literal["image-led-v1"]
    model: Literal["fal-ai/image-preprocessors/depth-anything/v2"]
    reservation: float = Field(gt=0, le=MIN_RESERVATION_USD)
    parameters: dict[str, Any]
    prior: SourceImage


def validate_image(source: SourceImage, *, mask: bool = False) -> None:
    """Inline immutable inputs only; validate every input before any upload."""
    try:
        header, encoded = source.url.split(",", 1)
        formats = {"data:image/png;base64": "PNG", "data:image/jpeg;base64": "JPEG"}
        if header not in formats or (mask and header != "data:image/png;base64"):
            raise ValueError("Only private PNG/JPEG data is accepted")
        data = base64.b64decode(encoded, validate=True)
        if len(data) != source.bytes or hashlib.sha256(data).hexdigest() != source.sha256:
            raise ValueError("Image bytes changed")
        with Image.open(io.BytesIO(data)) as image:
            if (
                image.format != formats[header]
                or image.size != (source.width, source.height)
                or image.width * image.height > 16_777_216
                or getattr(image, "n_frames", 1) != 1
            ):
                raise ValueError("Image dimensions or format changed")
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            if image.getexif().get(274, 1) != 1:
                raise ValueError("Rotated references are unsupported")
            image.load()
            if not mask and image.convert("RGBA").getchannel("A").getextrema() != (255, 255):
                raise ValueError("References must be opaque")
    except (ValueError, OSError, SyntaxError, Image.DecompressionBombError) as error:
        raise HTTPException(400, "Invalid or changed image-led reference bytes") from error


def input_fingerprint(body: ImageLedInput) -> str:
    value = body.model_dump()
    value["source"].pop("url")
    for landmark in value["landmarks"]:
        landmark["image"].pop("url")
    if value["prior"]:
        value["prior"]["image"].pop("url")
    if value["repair"]:
        value["repair"]["image"].pop("url")
        if value["repair"]["mask"]:
            value["repair"]["mask"].pop("url")
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def route_intent_prompt(intent: RouteIntent) -> str:
    index = intent.checkpoint_index
    current = intent.checkpoints[index]
    local = {"current": current.model_dump()}
    return (
        "Local route intent, recomputed from the ORIGINAL SOURCE-IMAGE pixels: "
        + json.dumps(local, ensure_ascii=False, separators=(",", ":"))
        + ". Headings run clockwise from image-up with the actual source-image aspect; left/right and "
        "landmark sectors are qualitative image-plane planning cues, not cardinal directions, calibrated "
        "camera angles, distances or inferred visibility. Follow this checkpoint's local turn and the "
        "changing neighboring relationships rather than making every view a straight corridor toward "
        "one centered destination. A landmark behind the observer need not remain in view; show only "
        "features naturally visible from the source-informed viewpoint. Do not keep the fountain, skyline "
        "or vanishing point artificially centered across a curved route. The final 'end' marker means "
        "only that the supplied route ends there; it does not assert arrival at a fountain or other landmark. "
        "Preserve original surroundings when present: the well's location and roof, terrace corners, "
        "steps, parapets, street edges and the fountain's actual sculpture and basin arrangement. "
        "Do not replace a compact faceted conservatory with an elongated glass hall. "
    )


def image_led_prompt(body: ImageLedInput) -> str:
    """The original architecture and reviewed picture lead; coordinates are image markers."""
    prior = body.prior is not None
    map_index = 1 + int(prior) + int(body.repair is not None)
    first_crop = map_index + 1
    references = [
        {
            "image": first_crop + index,
            "id": landmark.id,
            "name": landmark.label,
            "appearance_hint": landmark.visual,
            "source_rectangle_pixels": landmark.source_rectangle.model_dump(),
        }
        for index, landmark in enumerate(body.landmarks)
    ]
    index = body.route.checkpoint_index
    target = body.route.points[index]
    next_point = body.route.points[min(index + 1, len(body.route.points) - 1)]
    previous_point = body.route.points[max(0, index - 1)]
    route = {
        "frame": body.route.frame,
        "original_image_size": [body.source.width, body.source.height],
        "checkpoint_index": index,
        "points": [point.model_dump() for point in body.route.points],
        "previous_marker": previous_point.model_dump(),
        "target_marker": target.model_dump(),
        "next_marker": next_point.model_dump(),
    }
    prior_index = 2 if body.repair else 1
    lead = (
        f"Image {prior_index} is the immediately preceding owner-reviewed street artwork. Change only the viewpoint "
        "to continue along the depicted route toward the target marker. Preserve the established "
        "architecture and feature arrangement; nearby buildings should change through perspective and "
        "natural occlusion, not turn into different buildings. "
        if prior and index else
        f"Image {prior_index} is the owner-reviewed starting street artwork. Use its existing architecture, viewpoint "
        "and feature arrangement as the starting anchor; refine the same place rather than replace it. "
        if prior else
        f"Image {map_index} is the original world artwork and architectural authority. Reinterpret this specific "
        "place as a rich eye-level street view from the target marker, facing along the depicted route. "
    )
    if body.repair:
        lead = ("Image 1 is the exact unapproved repair target for this checkpoint. Repair visible source "
                "fidelity in this same viewpoint; it is not an approved route predecessor. "
                + ("The separately supplied mask scopes the edit to this target. " if body.repair.mask else "")
                + lead)
    return (
        lead
        + f"Image {map_index} is the original world artwork. It may be an oblique illustration; do not "
        "assume it is a top-down plan or a metric survey. Coordinates are normalized markers on that "
        "original image, not metres or cardinal directions. Use them to locate the route and preserve "
        "the original neighboring relationships, with a plausible forward viewpoint change. "
        "The separately named whole-building crops are architectural identity references, not texture "
        "samples: preserve each building's characteristic roof, projecting bays, window/door arrangement, "
        "sign motifs, hearth or glass structure and materials when present. Show only features naturally "
        "visible from this position; do not force every crop into view. Keep streets passable and conserve "
        "the source's local landmarks, ground detail, lighting and illustrated medium. Do not invent a "
        "replacement city, duplicate facades or move a landmark to the opposite side of its street. "
        "The original artwork and its building crops override generic appearance hints, names and "
        "requested styling whenever they conflict about geometry. Appearance hints are descriptive "
        "context, not an architectural specification. Match the visible source structure: roof wings "
        "and annexes, solid gable triangles, round versus rectangular openings, open work bays versus "
        "closed doors, and glass-roof brace junctions connected to the same wall bays. Preserve the "
        "fountain's actual crown, supports, dish count and ground pool rather than substitute a generic "
        "fountain. Preserve terrace heights, boundaries, garden edges and the well's street adjacency. "
        "A shared palette or landmark order does not establish building identity. Change the viewpoint "
        "through perspective and natural occlusion without stretching, merging or redesigning those "
        "structures. Features hidden in the original remain unknown; do not invent unseen geometry "
        "to force every landmark into one view. "
        "Do not output map labels, reference borders, a grid, collage or route markers. "
        + route_intent_prompt(body.route_intent)
        + "Architectural references: "
        + json.dumps(references, ensure_ascii=False, separators=(",", ":"))
        + ". Approximate route in the source artwork: "
        + json.dumps(route, ensure_ascii=False, separators=(",", ":"))
        + f". Requested appearance: {body.prompt.strip()}"
    )


@router.post("/generate")
async def submit(body: ImageLedInput) -> dict[str, object]:
    """Call only after the web durably marks its owned quoted job as submitting."""
    config = configuration()
    if not config["enabled"]:
        raise HTTPException(503, "Image-led walking is not configured")
    if (body.model != config["model"] or body.reservation != config["reservation"]
            or json.dumps(body.parameters, sort_keys=True) != json.dumps(config["parameters"], sort_keys=True)):
        raise HTTPException(409, "Image-led walk configuration changed")
    selected = STILL_PROFILES[body.model]
    images = [body.source, *(landmark.image for landmark in body.landmarks)]
    if body.prior:
        images.insert(0, body.prior.image)
    if body.repair:
        images.insert(0, body.repair.image)
    # Validate the actual transmitted inventory, not landmark count alone. In
    # particular Seedream silently drops early references on overflow.
    if len(images) > selected["max_references"]:
        raise HTTPException(400, "Still model reference limit exceeded; no references may be dropped")
    if body.repair and body.repair.mask and not selected["mask"]:
        raise HTTPException(400, "This still model does not support repair masks")
    if body.model == FLUX_MODEL and any(
        min(image.width, image.height) < 256 or image.width * image.height > 4_000_000
        for image in images
    ):
        raise HTTPException(400, "FLUX references must each be at least 256 pixels per side and at most 4 MP")
    for image in images:
        validate_image(image)
    if body.repair and body.repair.mask:
        validate_image(body.repair.mask, mask=True)
    fingerprint = input_fingerprint(body)
    prompt = image_led_prompt(body)
    image_urls = [await to_fal_url(image.url) for image in images]
    payload = {key: value for key, value in body.parameters.items() if key != "prompt_version"}
    payload.update(image_urls=image_urls, prompt=prompt)
    if body.repair and body.repair.mask:
        payload["mask_url"] = await to_fal_url(body.repair.mask.url)
    request_id = await post_once(body.model, payload)
    return {
        "request_id": request_id,
        "model": body.model,
        "profile": PROFILE,
        "input_sha256": fingerprint,
        "prompt_version": body.parameters["prompt_version"],
        "spatial_validation": "unmeasured",
        "identity_validation": "owner_review_required",
    }


# v4: no landmark list or route JSON. Named landmarks made H3 swing the camera toward
# them (docs/research/40-walk-video-prompt-and-leg-length.md); the reviewed endpoints carry identity.
IMAGE_LED_VIDEO_PROMPT = (
    "Begin exactly at the first image and end exactly at the last image. One continuous eye-level walk "
    "forward along this same illustrated street, with steady forward movement, natural ground parallax "
    "and gradual turning only as the ending view requires. Show only what lies between these two views; "
    "do not swing the camera toward other streets or buildings. Every building keeps its architecture: "
    "roofs, doors, windows, signs and openings stay in the same places. Features may be hidden or revealed "
    "by parallax, but they never morph, swap, duplicate or relocate. Preserve the illustrated medium, "
    "lighting and detail. No aerial dive, rising camera, zoom, lens change, teleport, cut, dissolve or "
    "replacement street."
)


@router.post("/video/generate")
async def submit_video(body: ImageLedVideoInput) -> dict[str, object]:
    """Owned reviewed endpoint/source checks and a durable claim must precede this call."""
    config = video_configuration()
    if not config["enabled"]:
        raise HTTPException(503, "Image-led video is not configured")
    if (body.model != config["model"] or body.reservation != config["reservation"]
            or json.dumps(body.parameters, sort_keys=True) != json.dumps(config["parameters"], sort_keys=True)):
        raise HTTPException(409, "Image-led video configuration changed")
    validate_image(body.start)
    validate_image(body.end)
    fingerprint = body.model_dump()
    fingerprint["start"].pop("url")
    fingerprint["end"].pop("url")
    input_sha256 = hashlib.sha256(json.dumps(fingerprint, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    prompt = IMAGE_LED_VIDEO_PROMPT
    start, end = await to_fal_url(body.start.url), await to_fal_url(body.end.url)
    arguments = h3_arguments(VIDEO_MODEL, start, prompt, VIDEO_SECONDS, end_image_url=end)
    # h3_arguments floors first/last-frame clips at 5 s; the quoted profile is shorter.
    arguments["duration"] = VIDEO_SECONDS
    # This closed quoted profile overrides the shared helper's balanced default.
    arguments["prompt_expansion_mode"] = body.parameters["prompt_expansion_mode"]
    arguments["sync_mode"] = body.parameters["sync_mode"]
    request_id = await post_once(VIDEO_MODEL, arguments)
    return {
        "request_id": request_id, "model": VIDEO_MODEL, "profile": PROFILE,
        "input_sha256": input_sha256,
        "prompt_version": VIDEO_PARAMETERS["prompt_version"],
        "spatial_validation": "unmeasured", "temporal_validation": "owner_review_required",
    }


@router.post("/copy-first/generate")
async def submit_copy_first(body: CopyFirstInput) -> dict[str, object]:
    """One depth request for the reviewed prior's original PNG. The worker warps it; nothing is painted."""
    config = copy_first_configuration()
    if not config["enabled"]:
        raise HTTPException(503, "Copy-first stills are not configured")
    if (body.reservation != config["reservation"]
            or json.dumps(body.parameters, sort_keys=True) != json.dumps(config["parameters"], sort_keys=True)):
        raise HTTPException(409, "Copy-first configuration changed")
    if not body.prior.url.startswith("data:image/png;base64,"):
        raise HTTPException(400, "Copy-first needs the prior's original PNG")
    validate_image(body.prior)
    fingerprint = body.model_dump()
    fingerprint["prior"].pop("url")
    input_sha256 = hashlib.sha256(json.dumps(fingerprint, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    request_id = await post_once(DEPTH_MODEL, {"image_url": await to_fal_url(body.prior.url)})
    return {
        "request_id": request_id, "model": DEPTH_MODEL, "profile": PROFILE, "input_sha256": input_sha256,
        "warp_version": COPY_FIRST_WARP_VERSION,
        "spatial_validation": "unmeasured", "identity_validation": "owner_review_required",
    }


@router.get("/video/requests/{request_id}")
async def video_status(request_id: str) -> dict[str, object]:
    # Status recovery is GET-only on the fixed H3 image-to-video model.
    result = await camera_motion.status(request_id, model="leg")
    return {
        **result, "request_id": request_id, "model": VIDEO_MODEL, "profile": PROFILE,
        "spatial_validation": "unmeasured", "temporal_validation": "owner_review_required",
        "accepted": False,
    }


def output_url(value: object) -> bool:
    if not isinstance(value, str) or len(value) > 2048:
        return False
    parts = urlsplit(value)
    host = parts.netloc.lower()
    return (
        parts.scheme == "https"
        and all(char.isascii() and (char.isalnum() or char in ".-") for char in host)
        and (host == "fal.media" or host.endswith(".fal.media"))
    )


async def raw_output_metadata(url: str) -> dict[str, object]:
    """Decode original output bytes without resizing, cropping, normalizing or accepting."""
    raw: dict[str, object] = {"valid": False}
    try:
        if not output_url(url):
            raise ValueError("Original output is not on Fal storage")
        async with (
            httpx.AsyncClient(timeout=60, follow_redirects=False,
                              transport=httpx.AsyncHTTPTransport(retries=0)) as client,
            client.stream("GET", url) as response,
        ):
            response.raise_for_status()
            chunks = bytearray()
            async for chunk in response.aiter_bytes():
                chunks.extend(chunk)
                if len(chunks) > MAX_IMAGE_BYTES:
                    raise ValueError("Raw output exceeds 12 MiB")
        data = bytes(chunks)
        raw.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        with Image.open(io.BytesIO(data)) as image:
            raw.update(width=image.width, height=image.height, format=image.format)
            if (
                image.format != "PNG"
                or not 32 <= image.width <= 4096
                or not 32 <= image.height <= 4096
                or image.width * image.height > 16_777_216
                or getattr(image, "n_frames", 1) != 1
            ):
                raise ValueError("Expected a single bounded PNG")
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            if image.getexif().get(274, 1) != 1:
                raise ValueError("Output has rotation metadata")
            image.load()
            if image.convert("RGBA").getchannel("A").getextrema() != (255, 255):
                raise ValueError("Output is not opaque")
        raw["valid"] = True
    except Exception as error:
        raw["reason"] = f"Original image-led output could not be verified: {type(error).__name__}"
    return raw


@router.get("/requests/{request_id}")
async def status(request_id: str, model: str = MODEL) -> dict[str, object]:
    if not valid_request_id(request_id):
        raise HTTPException(400, "Invalid image-led request id")
    if model not in STILL_PROFILES and model != DEPTH_MODEL:
        raise HTTPException(400, "Unknown saved image-led model")
    # Paid request recovery remains possible after disabling new generation.
    if not os.environ.get("SHARED_TOKEN") or not os.environ.get("FAL_KEY") or env_flag("MOCK_PROVIDERS"):
        raise HTTPException(503, "Image-led provider unavailable")
    state = await fal_client.status_async(model, request_id)
    base = {"request_id": request_id, "model": model, "profile": PROFILE}
    if isinstance(state, fal_client.Queued):
        return {**base, "status": "queued"}
    if isinstance(state, fal_client.InProgress):
        return {**base, "status": "running"}
    if not isinstance(state, fal_client.Completed):
        raise HTTPException(502, "Unknown image-led provider status")
    if state.error:
        return {**base, "status": "failed"}
    try:
        result = await fal_client.result_async(model, request_id)
    except FalClientHTTPError as error:
        if error.status_code == 422:
            return {**base, "status": "failed"}
        raise
    # The depth preprocessor returns one "image"; still models return "images".
    images = (None if not isinstance(result, dict)
              else [result.get("image")] if model == DEPTH_MODEL else result.get("images"))
    flags = result.get("has_nsfw_concepts") if isinstance(result, dict) else None
    if (not isinstance(images, list) or len(images) != 1
            or (flags is not None and (not isinstance(flags, list) or any(flags)))):
        return {**base, "status": "failed"}
    image = images[0]
    if not isinstance(image, dict) or not output_url(image.get("url")):
        return {**base, "status": "failed"}
    raw = await raw_output_metadata(str(image["url"]))
    original = {"url": image["url"], "content_type": "image/png"}
    if "width" in raw and "height" in raw:
        original.update(width=raw["width"], height=raw["height"])
    return {
        **base, "status": "ready", "image": original, "images": [original], "raw_image": raw,
        "spatial_validation": "unmeasured", "identity_validation": "owner_review_required",
        "accepted": False,
    }
