"""Private queue adapter. The web tier owns jobs, consent, budgets and assets."""
import base64
import binascii
import io
import math
import os

import fal_client
import httpx
from fal_client.client import FalClientHTTPError
from fastapi import APIRouter, HTTPException
from PIL import Image
from pydantic import BaseModel, Field

router = APIRouter(prefix="/mesh")
MODEL = "fal-ai/hunyuan3d-v3/text-to-3d"
IMAGE_MODEL = "fal-ai/hunyuan3d-v3/image-to-3d"
PARAMETERS = {"enable_pbr": True, "face_count": 40000, "generate_type": "LowPoly", "polygon_type": "triangle"}


def configuration(image: bool = False) -> dict[str, object]:
    prefix = "MESH_IMAGE" if image else "MESH"
    try:
        reservation = float(os.environ.get(f"{prefix}_RESERVATION_USD", "0"))
    except ValueError:
        reservation = 0
    enabled = (os.environ.get(f"{prefix}_GENERATION_ENABLED") == "1"
               and bool(os.environ.get("SHARED_TOKEN"))
               and bool(os.environ.get("FAL_KEY"))
               and math.isfinite(reservation) and 0 < reservation <= 10)
    return {"enabled": enabled, "model": IMAGE_MODEL if image else MODEL, "reservation": reservation if enabled else 0,
            "parameters": PARAMETERS, "reason": None if enabled else "3D generation needs a provider key, shared token and an operator-set cost reservation."}


@router.get("/capabilities")
async def capabilities() -> dict[str, object]:
    return configuration()


@router.get("/image-capabilities")
async def image_capabilities() -> dict[str, object]:
    return configuration(image=True)


class MeshInput(BaseModel):
    prompt: str = Field(min_length=3, max_length=1024)
    model: str | None = None
    reservation: float | None = None
    parameters: dict[str, object] | None = None
    input_image_url: str | None = Field(default=None, max_length=16_777_300)


def checked_image(value: str | None) -> str:
    if not value or not value.startswith("data:image/png;base64,"):
        raise HTTPException(400, "A private PNG image input is required")
    try:
        raw = base64.b64decode(value.split(",", 1)[1], validate=True)
        if not raw or len(raw) > 12 * 1024 * 1024:
            raise ValueError("Invalid input size")
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != "PNG" or not (32 <= image.width <= 2048 and 32 <= image.height <= 2048) or getattr(image, "n_frames", 1) != 1:
                raise ValueError("Invalid image")
            image.verify()
    except (ValueError, OSError, binascii.Error, Image.DecompressionBombError) as error:
        raise HTTPException(400, "Invalid private image input") from error
    return value


@router.post("/submit")
async def submit(body: MeshInput) -> dict[str, object]:
    image = body.model == IMAGE_MODEL
    model = IMAGE_MODEL if image else MODEL
    config = configuration(image=True) if image else configuration()
    if not config["enabled"]:
        raise HTTPException(503, "3D generation is not configured")
    if ((body.model is not None and body.model != model)
            or (body.reservation is not None and body.reservation != config["reservation"])
            or (body.parameters is not None and body.parameters != PARAMETERS)):
        raise HTTPException(409, "3D generation configuration changed")
    if not body.prompt.strip():
        raise HTTPException(400, "A prompt is required")
    if not image and body.input_image_url is not None:
        raise HTTPException(400, "Image input requires the image model")
    # The image endpoint has no prompt field. The web label is provenance only.
    inputs = {"input_image_url": checked_image(body.input_image_url)} if image else {"prompt": body.prompt.strip()}
    # fal_client.submit_async itself retries POSTs on transport/HTTP failures.
    # Use one HTTP request and also opt out of the provider's queue retries.
    async with httpx.AsyncClient(timeout=60, follow_redirects=False,
                                 transport=httpx.AsyncHTTPTransport(retries=0)) as client:
        response = await client.post(
            f"https://queue.fal.run/{model}",
            headers={"Authorization": f"Key {os.environ['FAL_KEY']}", "X-Fal-No-Retry": "1"},
            json={**inputs, **PARAMETERS},
        )
        response.raise_for_status()
    return {"request_id": response.json()["request_id"], "model": model}


@router.get("/requests/{request_id}")
async def status(request_id: str, model: str = MODEL) -> dict[str, object]:
    if not os.environ.get("SHARED_TOKEN") or not os.environ.get("FAL_KEY"):
        raise HTTPException(503, "3D provider unavailable")
    if len(request_id) > 100 or not all(c.isalnum() or c in "_-" for c in request_id):
        raise HTTPException(400, "Invalid request id")
    if model not in (MODEL, IMAGE_MODEL):
        raise HTTPException(400, "Unsupported mesh model")
    state = await fal_client.status_async(model, request_id)
    if isinstance(state, fal_client.Queued):
        return {"status": "queued"}
    if isinstance(state, fal_client.InProgress):
        return {"status": "running"}
    if not isinstance(state, fal_client.Completed):
        raise HTTPException(502, "Unknown provider status")
    if state.error:
        return {"status": "failed", "error": "The provider failed this generation. No automatic retry was submitted."}
    try:
        result = await fal_client.result_async(model, request_id)
    except FalClientHTTPError as error:
        # A completed request with rejected input is terminal. Auth, rate limits
        # and transport/server failures remain retryable reads, never new jobs.
        if error.status_code == 422:
            return {"status": "failed", "error": "The provider rejected this generation. No automatic retry was submitted."}
        raise
    return {"status": "ready", "model_glb": result.get("model_glb"), "seed": result.get("seed")}
