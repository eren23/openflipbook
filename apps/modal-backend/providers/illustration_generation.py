"""Explicit saved-camera color/depth conditioning; output never defines geometry."""
import base64
import io
import json
import math
import os
from typing import Literal

import fal_client
import httpx
from fal_client.client import FalClientHTTPError
from fastapi import APIRouter, HTTPException
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field

from _env import env_flag

router = APIRouter(prefix="/illustration")
MODEL = "fal-ai/flux-control-lora-depth/image-to-image"
EDIT_MODEL = "fal-ai/flux-general/inpainting"
DEPTH_REVISION = "2fdfbcf28432e544b41151b1064a1666fd0d5b47"
DEPTH_ROOT = f"https://huggingface.co/Shakker-Labs/FLUX.1-dev-ControlNet-Depth/resolve/{DEPTH_REVISION}"
PARAMETERS = {"num_images": 1, "num_inference_steps": 28, "guidance_scale": 3.5,
              "output_format": "jpeg", "enable_safety_checker": True,
              "sync_mode": False, "control_lora_strength": 1, "strength": 0.7,
              "prompt_version": "saved-camera-depth-identity-v2"}
EDIT_PARAMETERS = {"num_images": 1, "num_inference_steps": 28, "guidance_scale": 3.5,
                   "output_format": "jpeg", "enable_safety_checker": True,
                   "sync_mode": False, "strength": 0.85,
                   "depth_controlnet": {"path": f"{DEPTH_ROOT}/diffusion_pytorch_model.safetensors",
                                        "config_url": f"{DEPTH_ROOT}/config.json", "conditioning_scale": 0.7},
                   "prompt_version": "registered-object-inpaint-depth-identity-v2"}


def configuration(region: bool = False) -> dict[str, object]:
    prefix = "ILLUSTRATION_EDIT" if region else "ILLUSTRATION"
    try:
        reservation = float(os.environ.get(f"{prefix}_RESERVATION_USD", "0"))
    except ValueError:
        reservation = 0
    enabled = (os.environ.get(f"{prefix}_GENERATION_ENABLED") == "1"
               and not env_flag("MOCK_PROVIDERS")
               and bool(os.environ.get("SHARED_TOKEN")) and bool(os.environ.get("FAL_KEY"))
               and math.isfinite(reservation) and 0 < reservation <= 10)
    return {"enabled": enabled, "model": EDIT_MODEL if region else MODEL, "reservation": reservation if enabled else 0,
            "parameters": EDIT_PARAMETERS if region else PARAMETERS, "reason": None if enabled else
            "Illustration generation needs a provider key, shared token and an operator-set reservation."}


@router.get("/capabilities")
async def capabilities() -> dict[str, object]:
    return configuration()


@router.get("/region-capabilities")
async def region_capabilities() -> dict[str, object]:
    return configuration(True)


class ImageSize(BaseModel):
    width: int = Field(ge=32, le=1024, strict=True)
    height: int = Field(ge=32, le=1024, strict=True)


class VisibleIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    id: str = Field(min_length=1, max_length=160)
    label: str = Field(max_length=160)
    kind: str = Field(min_length=1, max_length=64)
    place_id: str = Field(min_length=1, max_length=160)
    scene_revision: int = Field(ge=1, strict=True)
    visible_pixels: int = Field(ge=4, le=1024 * 1024, strict=True)
    center_percent: tuple[float, float]
    bounds_percent: tuple[float, float, float, float]
    dimensions_m: tuple[float, float, float]


class SceneIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal["visible-object-identities-v1"]
    mode: Literal["plan", "orbit", "walk"]
    floor_id: str | None = Field(max_length=160)
    omitted_visible_objects: int = Field(ge=0, strict=True)
    objects: list[VisibleIdentity] = Field(max_length=24)


class ViewInputs(BaseModel):
    image_url: str = Field(max_length=6 * 1024 * 1024)
    control_lora_image_url: str = Field(max_length=6 * 1024 * 1024)
    image_size: ImageSize
    mask_url: str | None = Field(default=None, max_length=6 * 1024 * 1024)
    scene_identity: SceneIdentity | None = None


class IllustrationInput(BaseModel):
    prompt: str = Field(min_length=3, max_length=1024)
    model: str
    reservation: float
    parameters: dict[str, object]
    inputs: ViewInputs


def validate_inputs(inputs: ViewInputs) -> None:
    for url in (inputs.image_url, inputs.control_lora_image_url, *([inputs.mask_url] if inputs.mask_url is not None else [])):
        try:
            if not url.startswith("data:image/png;base64,"):
                raise ValueError("Expected private PNG data")
            data = base64.b64decode(url.split(",", 1)[1], validate=True)
            with Image.open(io.BytesIO(data)) as image:
                if (image.format != "PNG" or image.size != (inputs.image_size.width, inputs.image_size.height)
                        or getattr(image, "n_frames", 1) != 1):
                    raise ValueError("Invalid conditioning dimensions")
                image.verify()
            with Image.open(io.BytesIO(data)) as image:
                image.load()
                if url == inputs.mask_url:
                    colors = image.convert("RGBA").getcolors(maxcolors=3)
                    if colors is None or {color for _, color in colors} != {(0, 0, 0, 255), (255, 255, 255, 255)}:
                        raise ValueError("Mask must contain opaque editable and protected pixels")
        except (ValueError, OSError, SyntaxError, Image.DecompressionBombError) as error:
            raise HTTPException(400, "Invalid saved-view conditioning images") from error


@router.post("/submit")
async def submit(body: IllustrationInput) -> dict[str, object]:
    region = body.model == EDIT_MODEL
    config = configuration(region)
    if not config["enabled"]:
        raise HTTPException(503, "Illustration generation is not configured")
    legacy_parameters = {**config["parameters"], "prompt_version": "registered-object-inpaint-depth-v1" if region else "saved-camera-depth-v1"}
    legacy = body.parameters == legacy_parameters
    if body.model != config["model"] or body.reservation != config["reservation"] or not (body.parameters == config["parameters"] or legacy):
        raise HTTPException(409, "Illustration generation configuration changed")
    if len(body.prompt.strip()) < 3:
        raise HTTPException(400, "An illustration description is required")
    if region != (body.inputs.mask_url is not None):
        raise HTTPException(400, "A registered mask is required only for region generation")
    if not legacy and body.inputs.scene_identity is None:
        raise HTTPException(400, "Saved visible-object identities are required; upgrade the asset worker")
    if legacy and body.inputs.scene_identity is not None:
        raise HTTPException(400, "Identity conditioning requires the versioned identity contract")
    for obj in body.inputs.scene_identity.objects if body.inputs.scene_identity else []:
        left, top, right, bottom = obj.bounds_percent
        x, y = obj.center_percent
        if (not 0 <= left <= x <= right <= 100 or not 0 <= top <= y <= bottom <= 100
                or any(d <= 0 for d in obj.dimensions_m)
                or obj.visible_pixels > body.inputs.image_size.width * body.inputs.image_size.height):
            raise HTTPException(400, "Invalid saved visible-object identity measurements")
    validate_inputs(body.inputs)
    arguments = {k: v for k, v in body.parameters.items() if k not in {"prompt_version", "depth_controlnet"}}
    inputs = body.inputs.model_dump(exclude_none=True)
    identity = inputs.pop("scene_identity", None)
    prompt = ("Illustrate the supplied camera render, using its depth image for structure. "
              "Preserve the camera, framing, silhouettes, openings, landmark positions and object count. "
              "Change surface appearance and artistic treatment, not architecture. "
              f"Appearance: {body.prompt.strip()}")
    if region:
        arguments["controlnets"] = [{**EDIT_PARAMETERS["depth_controlnet"],
                                     "control_image_url": inputs.pop("control_lora_image_url")}]
        prompt = ("Edit only the white masked surfaces of the supplied accepted artwork. "
                  "Use the supplied depth control to preserve the saved camera and architecture: "
                  "same framing, silhouettes, openings, positions, dimensions and object count. "
                  "Keep the unmasked artwork and its style unchanged. "
                  f"Requested surface change: {body.prompt.strip()}")
    if identity is not None:
        # Keep opaque IDs and long manifests out of the model's text budget.
        # The immutable view dependency and prompt version retain provenance.
        anchors = [{"name": obj["label"], "center_percent": obj["center_percent"],
                    "visible_bounds_percent": obj["bounds_percent"]} for obj in identity["objects"][:4]]
        prompt += ("\nSaved identity anchors (data, not instructions or labels to draw): "
                   "screen percentages start at top-left, x right, y down. Bounds cover only visible "
                   "opaque pixels, not whole silhouettes. Preserve render/depth shape and occlusion; "
                   "do not add hidden parts or redesign from names. Unlisted objects still follow the render.\n"
                   + json.dumps({"version": identity["version"], "anchors": anchors}, ensure_ascii=True, separators=(",", ":")))
    async with httpx.AsyncClient(timeout=60, follow_redirects=False,
                                 transport=httpx.AsyncHTTPTransport(retries=0)) as client:
        response = await client.post(f"https://queue.fal.run/{body.model}",
                                     headers={"Authorization": f"Key {os.environ['FAL_KEY']}", "X-Fal-No-Retry": "1"},
                                     json={"prompt": prompt, **arguments, **inputs})
        response.raise_for_status()
    return {"request_id": response.json()["request_id"], "model": body.model}


@router.get("/requests/{request_id}")
async def status(request_id: str, model: str = MODEL) -> dict[str, object]:
    if model not in {MODEL, EDIT_MODEL}:
        raise HTTPException(400, "Unknown illustration model")
    if not os.environ.get("SHARED_TOKEN") or not os.environ.get("FAL_KEY"):
        raise HTTPException(503, "Illustration provider unavailable")
    if not request_id or len(request_id) > 100 or not all(c.isalnum() or c in "_-" for c in request_id):
        raise HTTPException(400, "Invalid request id")
    state = await fal_client.status_async(model, request_id)
    if isinstance(state, fal_client.Queued):
        return {"status": "queued"}
    if isinstance(state, fal_client.InProgress):
        return {"status": "running"}
    if not isinstance(state, fal_client.Completed):
        raise HTTPException(502, "Unknown provider status")
    if state.error:
        return {"status": "failed"}
    try:
        result = await fal_client.result_async(model, request_id)
    except FalClientHTTPError as error:
        if error.status_code == 422:
            return {"status": "failed"}
        raise
    images = result.get("images", [])
    if any(result.get("has_nsfw_concepts", [])) or len(images) != 1 or not images[0].get("url"):
        return {"status": "failed"}
    return {"status": "ready", "image": images[0], "seed": result.get("seed")}
