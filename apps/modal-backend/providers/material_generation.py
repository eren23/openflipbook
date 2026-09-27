"""One saved base-color tile per explicit, budgeted material request."""
import math
import os

import fal_client
import httpx
from fal_client.client import FalClientHTTPError
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/material")
MODEL = "bytedance/seedream/v5/pro/text-to-image"
PARAMETERS = {"image_size": {"width": 1024, "height": 1024}, "num_images": 1,
              "output_format": "jpeg", "enable_safety_checker": True,
              "sync_mode": False, "prompt_version": "base-color-tile-v1"}


def configuration() -> dict[str, object]:
    try:
        reservation = float(os.environ.get("MATERIAL_RESERVATION_USD", "0"))
    except ValueError:
        reservation = 0
    enabled = (os.environ.get("MATERIAL_GENERATION_ENABLED") == "1"
               and bool(os.environ.get("SHARED_TOKEN")) and bool(os.environ.get("FAL_KEY"))
               and math.isfinite(reservation) and 0 < reservation <= 10)
    return {"enabled": enabled, "model": MODEL, "reservation": reservation if enabled else 0,
            "parameters": PARAMETERS, "reason": None if enabled else "Material generation needs a provider key, shared token and an operator-set reservation."}


@router.get("/capabilities")
async def capabilities() -> dict[str, object]:
    return configuration()


class MaterialInput(BaseModel):
    prompt: str = Field(min_length=3, max_length=1024)
    model: str
    reservation: float
    parameters: dict[str, object]


def tile_prompt(description: str) -> str:
    return (
        "Create ONE square base-color material texture for a 3D environment. "
        "Full-bleed orthographic close-up of the surface, uniform frontal diffuse illumination. "
        "Make opposite edges tile seamlessly with consistent feature size. "
        "No perspective, no border, no labels, no swatch grid, no objects placed on the surface, "
        "no cast shadows, no highlights, no ambient occlusion painted into the texture. "
        "This is a color image, NOT a normal, height, roughness or metallic map. "
        f"Material description: {description.strip()}"
    )


@router.post("/submit")
async def submit(body: MaterialInput) -> dict[str, object]:
    config = configuration()
    if not config["enabled"]:
        raise HTTPException(503, "Material generation is not configured")
    if body.model != MODEL or body.reservation != config["reservation"] or body.parameters != PARAMETERS:
        raise HTTPException(409, "Material generation configuration changed")
    if len(body.prompt.strip()) < 3:
        raise HTTPException(400, "A material description is required")
    arguments = {k: v for k, v in PARAMETERS.items() if k != "prompt_version"}
    async with httpx.AsyncClient(timeout=60, follow_redirects=False,
                                 transport=httpx.AsyncHTTPTransport(retries=0)) as client:
        response = await client.post(f"https://queue.fal.run/{MODEL}",
                                     headers={"Authorization": f"Key {os.environ['FAL_KEY']}", "X-Fal-No-Retry": "1"},
                                     json={"prompt": tile_prompt(body.prompt), **arguments})
        response.raise_for_status()
    return {"request_id": response.json()["request_id"], "model": MODEL}


@router.get("/requests/{request_id}")
async def status(request_id: str) -> dict[str, object]:
    if not os.environ.get("SHARED_TOKEN") or not os.environ.get("FAL_KEY"):
        raise HTTPException(503, "Material provider unavailable")
    if not request_id or len(request_id) > 100 or not all(c.isalnum() or c in "_-" for c in request_id):
        raise HTTPException(400, "Invalid request id")
    state = await fal_client.status_async(MODEL, request_id)
    if isinstance(state, fal_client.Queued):
        return {"status": "queued"}
    if isinstance(state, fal_client.InProgress):
        return {"status": "running"}
    if not isinstance(state, fal_client.Completed):
        raise HTTPException(502, "Unknown provider status")
    if state.error:
        return {"status": "failed"}
    try:
        result = await fal_client.result_async(MODEL, request_id)
    except FalClientHTTPError as error:
        if error.status_code == 422:
            return {"status": "failed"}
        raise
    images = result.get("images", [])
    if any(result.get("has_nsfw_concepts", [])) or len(images) != 1 or not images[0].get("url"):
        return {"status": "failed"}
    return {"status": "ready", "image": images[0], "seed": result.get("seed")}
