"""Private H3 transport; callers must enforce world ownership and durable job claims."""

from __future__ import annotations

import base64
import hashlib
import io
import os
import re
from decimal import Decimal, InvalidOperation
from typing import Literal, Self
from urllib.parse import urlsplit

import fal_client
import httpx
from fal_client.client import FalClientHTTPError
from fastapi import APIRouter, HTTPException
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, model_validator

from _env import env_flag

from .video import H3_MAX_MODEL, h3_arguments, move_prompt

router = APIRouter(prefix="/motion")
MODEL = "minimax/h3-max/camera-controls"
# A first/last-frame leg between two keyframes.
LEG_MODEL = H3_MAX_MODEL
STATUS_MODELS = {"camera": MODEL, "leg": LEG_MODEL}
ADAPTER = "h3-source-relative-v2-measured"
# Studies frozen before the 2026-09-27 calibration keep validating.
ADAPTER_V1 = "h3-source-relative-v1-hypothesis"
# v2 limits, measured 2026-09-27: past them H3 under-delivers the move.
V2_MAX_AZIMUTH = 30
V2_MAX_ELEVATION = 15
V2_MIN_DISTANCE = 0.2
MIN_RATE = Decimal("0.08")  # Non-promotional 768P rate verified 2026-09-14.
MAX_SOURCE_BYTES = 4 * 1024 * 1024


def configuration() -> dict[str, object]:
    try:
        rate = Decimal(os.environ.get("MOTION_RESERVATION_USD_PER_SECOND", "0"))
        valid_rate = rate.is_finite() and MIN_RATE <= rate <= Decimal("0.5")
    except InvalidOperation:
        rate, valid_rate = Decimal(0), False
    enabled = (
        os.environ.get("MOTION_CALIBRATION_ENABLED") == "1"
        and not env_flag("MOCK_PROVIDERS")
        and bool(os.environ.get("SHARED_TOKEN"))
        and bool(os.environ.get("FAL_KEY"))
        and valid_rate
    )
    return {
        "enabled": enabled,
        "model": MODEL,
        "adapter": ADAPTER,
        "calibration": "unverified",
        "purpose": "calibration",
        "resolution": "768P",
        "min_duration": 5,
        "max_duration": 15,
        "reservation_usd_per_second": float(rate) if enabled else 0,
        "reason": None
        if enabled
        else "Camera calibration requires explicit enablement, provider/shared keys and an operator-set rate of $0.08-$0.50 per second.",
    }


@router.get("/capabilities")
async def capabilities() -> dict[str, object]:
    return configuration()


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class CameraKeyframe(StrictInput):
    time: float = Field(ge=0, le=1)
    azimuth: float
    elevation: float = Field(ge=-90, le=90)
    distance: float = Field(gt=0)


class MotionParameters(StrictInput):
    duration: int = Field(ge=5, le=15)
    resolution: Literal["768P"]
    prompt_expansion_mode: Literal["balanced"]
    enable_safety_checker: Literal[True]
    sync_mode: Literal[False]
    prompt: str = Field(min_length=3, max_length=2048)
    camera_trajectory: list[CameraKeyframe] = Field(min_length=2, max_length=12)

    @model_validator(mode="after")
    def validate_path(self) -> Self:
        first, last = self.camera_trajectory[0], self.camera_trajectory[-1]
        if (first.time, first.azimuth, first.elevation, first.distance) != (
            0,
            0,
            0,
            1,
        ) or last.time != 1:
            raise ValueError("Expected source-relative start pose and full path duration")
        pairs = list(zip(self.camera_trajectory, self.camera_trajectory[1:], strict=False))
        if any(b.time <= a.time for a, b in pairs):
            raise ValueError("Camera keyframes must be strictly ordered")
        if sum(abs(b.azimuth - a.azimuth) for a, b in pairs) > 32 * 360:
            raise ValueError("Camera path exceeds 32 signed turns")
        if len(self.prompt.strip()) < 3:
            raise ValueError("Motion prompt is empty")
        return self


class SourceImage(StrictInput):
    url: str = Field(max_length=6 * 1024 * 1024)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    bytes: int = Field(gt=0, le=MAX_SOURCE_BYTES)
    width: int = Field(ge=32, le=1024)
    height: int = Field(ge=32, le=1024)


class MotionInput(StrictInput):
    model: str
    adapter: str
    purpose: Literal["calibration"]
    reservation: float = Field(gt=0, le=10)
    parameters: MotionParameters
    source: SourceImage

    @model_validator(mode="after")
    def validate_v2_limits(self) -> Self:
        if self.adapter == ADAPTER and any(
            abs(p.azimuth) > V2_MAX_AZIMUTH
            or abs(p.elevation) > V2_MAX_ELEVATION
            or p.distance < V2_MIN_DISTANCE
            for p in self.parameters.camera_trajectory
        ):
            raise ValueError("Camera path exceeds the measured v2 limits")
        return self


class LegMove(StrictInput):
    orbit_deg: float = Field(0, ge=-180, le=180)
    turn_deg: float = Field(0, ge=-180, le=180)
    rise_m: float = Field(0, ge=-500, le=500)
    # Absent means no forward move; null asks for a walk of unknown length.
    forward_m: float | None = Field(0, ge=-500, le=500)
    subject: str | None = Field(None, max_length=120)


class LegInput(StrictInput):
    reservation: float = Field(gt=0, le=10)
    duration: int = Field(ge=5, le=15)
    move: LegMove
    start: SourceImage
    end: SourceImage


def validate_source(source: SourceImage) -> None:
    try:
        prefix, encoded = source.url.split(",", 1)
        formats = {"data:image/png;base64": "PNG", "data:image/jpeg;base64": "JPEG"}
        if prefix not in formats:
            raise ValueError("Only private PNG/JPEG bytes are accepted")
        data = base64.b64decode(encoded, validate=True)
        if (
            len(data) != source.bytes
            or len(data) > MAX_SOURCE_BYTES
            or hashlib.sha256(data).hexdigest() != source.sha256
        ):
            raise ValueError("Source bytes changed")
        with Image.open(io.BytesIO(data)) as image:
            if (
                image.format != formats[prefix]
                or image.size != (source.width, source.height)
                or getattr(image, "n_frames", 1) != 1
            ):
                raise ValueError("Invalid source dimensions/format")
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            if image.getexif().get(274, 1) != 1:
                raise ValueError("Source would be auto-rotated")
    except (ValueError, OSError, SyntaxError, Image.DecompressionBombError) as error:
        raise HTTPException(400, "Invalid or changed motion source bytes") from error


def valid_request_id(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value) is not None


def check_reservation(reservation: float, duration: int) -> None:
    """Refuse unless enabled and the caller reserved exactly rate x duration."""
    config = configuration()
    if not config["enabled"]:
        raise HTTPException(503, "Camera motion calibration is not configured")
    expected = Decimal(str(config["reservation_usd_per_second"])) * duration
    if Decimal(str(reservation)) != expected:
        raise HTTPException(409, "Camera motion configuration or reservation changed")


async def post_once(model: str, arguments: dict) -> str:
    """One queue POST, never retried; returns the request id.

    The caller must durably claim its job before this. Ambiguous network
    failures propagate; neither transport nor provider may retry it.
    """
    async with httpx.AsyncClient(
        timeout=60, follow_redirects=False, transport=httpx.AsyncHTTPTransport(retries=0)
    ) as client:
        response = await client.post(
            f"https://queue.fal.run/{model}",
            headers={"Authorization": f"Key {os.environ['FAL_KEY']}", "X-Fal-No-Retry": "1"},
            json=arguments,
        )
        response.raise_for_status()
    if len(response.content) > 100_000:
        raise HTTPException(502, "Motion submission response too large; request may be billable")
    result = response.json()
    if not isinstance(result, dict) or not valid_request_id(result.get("request_id")):
        raise HTTPException(502, "Motion request identity unavailable; request may be billable")
    return str(result["request_id"])


@router.post("/submit")
async def submit(body: MotionInput) -> dict[str, object]:
    check_reservation(body.reservation, body.parameters.duration)
    if body.model != MODEL or body.adapter not in (ADAPTER, ADAPTER_V1):
        raise HTTPException(409, "Camera motion configuration or reservation changed")
    validate_source(body.source)
    arguments = {**body.parameters.model_dump(), "image_url": body.source.url}
    return {"request_id": await post_once(MODEL, arguments), "model": MODEL}


@router.post("/leg")
async def leg(body: LegInput) -> dict[str, object]:
    """One first/last-frame clip between two keyframes, worded as the move."""
    check_reservation(body.reservation, body.duration)
    validate_source(body.start)
    validate_source(body.end)
    prompt = move_prompt(**body.move.model_dump())
    arguments = h3_arguments(
        LEG_MODEL, body.start.url, prompt, body.duration, end_image_url=body.end.url
    )
    return {"request_id": await post_once(LEG_MODEL, arguments), "model": LEG_MODEL, "prompt": prompt}


@router.get("/requests/{request_id}")
async def status(request_id: str, model: str = "camera") -> dict[str, object]:
    if not valid_request_id(request_id):
        raise HTTPException(400, "Invalid motion request id")
    # Only our own slugs: the id is polled on whatever model is named here.
    slug = STATUS_MODELS.get(model)
    if slug is None:
        raise HTTPException(400, "Unknown motion model")
    # Turning off new generation must not strand an already-paid request.
    if (
        not os.environ.get("SHARED_TOKEN")
        or not os.environ.get("FAL_KEY")
        or env_flag("MOCK_PROVIDERS")
    ):
        raise HTTPException(503, "Camera motion provider unavailable")
    state = await fal_client.status_async(slug, request_id)
    if isinstance(state, fal_client.Queued):
        return {"status": "queued"}
    if isinstance(state, fal_client.InProgress):
        return {"status": "running"}
    if not isinstance(state, fal_client.Completed):
        raise HTTPException(502, "Unknown motion provider status")
    if state.error:
        return {"status": "failed"}
    try:
        result = await fal_client.result_async(slug, request_id)
    except FalClientHTTPError as error:
        if error.status_code == 422:
            return {"status": "failed"}
        raise
    video = result.get("video") if isinstance(result, dict) else None
    if not isinstance(video, dict) or not isinstance(video.get("url"), str):
        return {"status": "failed"}
    try:
        url = urlsplit(video["url"])
        if (
            len(video["url"]) > 4096
            or url.scheme != "https"
            or not url.hostname
            or not (url.hostname == "fal.media" or url.hostname.endswith(".fal.media"))
            or url.username is not None
            or url.password is not None
            or url.port not in (None, 443)
            or video.get("content_type") not in (None, "video/mp4")
        ):
            raise ValueError("Unexpected video location/format")
    except ValueError:
        raise HTTPException(502, "Invalid motion result metadata") from None
    expanded = result.get("expanded_prompt")
    if expanded is not None and (not isinstance(expanded, str) or len(expanded) > 100_000):
        raise HTTPException(502, "Invalid expanded motion prompt")
    # H3 exposes no verified audio switch. The storage worker must inspect and
    # remove audio for the silent derivative while preserving original bytes.
    return {
        "status": "ready",
        "video": {"url": video["url"], "content_type": "video/mp4"},
        "expanded_prompt": expanded,
        "audio_status": "unverified",
    }
