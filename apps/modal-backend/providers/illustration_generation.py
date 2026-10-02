"""Explicit saved-camera color/depth conditioning, or qwen keyframes painted
over the exact render; output never defines geometry."""
import asyncio
import base64
import io
import json
import math
import os
from typing import Any, Literal, cast
from urllib.parse import urlsplit

import fal_client
import httpx
from fal_client.client import FalClientHTTPError
from fastapi import APIRouter, HTTPException
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field

from _env import env_flag
from providers import segmenter
from providers._common import to_fal_url

router = APIRouter(prefix="/illustration")
MODEL = "fal-ai/flux-control-lora-depth/image-to-image"
EDIT_MODEL = "fal-ai/flux-general/inpainting"
KEYFRAME_MODEL = "fal-ai/qwen-image-edit-2511"
# Two qwen images (about $0.035 each) plus one SAM-3 gate call per image.
KEYFRAME_MIN_RESERVATION_USD = 0.10
GATE_TIMEOUT_S = 180
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
# `gate` is the web gate's contract (SAM-3 on the largest building vs the
# object pass). It is frozen into the job for provenance and never sent to fal.
KEYFRAME_PARAMETERS = {"num_images": 2, "output_format": "jpeg", "enable_safety_checker": True,
                       "sync_mode": False, "prompt_version": "saved-camera-qwen-keyframe-v3",
                       "gate": {"crop_pad": segmenter.CROP_PAD, "centre_tolerance": 0.03, "area_ratio": [0.8, 1.2]}}


def configuration(region: bool = False, keyframe: bool = False) -> dict[str, object]:
    prefix = "ILLUSTRATION_EDIT" if region else "ILLUSTRATION_KEYFRAME" if keyframe else "ILLUSTRATION"
    try:
        reservation = float(os.environ.get(f"{prefix}_RESERVATION_USD", "0"))
    except ValueError:
        reservation = 0
    floor = KEYFRAME_MIN_RESERVATION_USD if keyframe else 0
    enabled = (os.environ.get(f"{prefix}_GENERATION_ENABLED") == "1"
               and not env_flag("MOCK_PROVIDERS")
               and bool(os.environ.get("SHARED_TOKEN")) and bool(os.environ.get("FAL_KEY"))
               and math.isfinite(reservation) and 0 < reservation <= 10 and reservation >= floor)
    model, parameters = ((EDIT_MODEL, EDIT_PARAMETERS) if region else (KEYFRAME_MODEL, KEYFRAME_PARAMETERS)
                         if keyframe else (MODEL, PARAMETERS))
    return {"enabled": enabled, "model": model, "reservation": reservation if enabled else 0,
            "parameters": parameters, "reason": None if enabled else
            "Illustration generation needs a provider key, shared token and an operator-set reservation"
            + (f" of at least ${KEYFRAME_MIN_RESERVATION_USD:.2f}." if keyframe else ".")}


@router.get("/capabilities")
async def capabilities() -> dict[str, object]:
    return configuration()


@router.get("/region-capabilities")
async def region_capabilities() -> dict[str, object]:
    return configuration(True)


@router.get("/keyframe-capabilities")
async def keyframe_capabilities() -> dict[str, object]:
    return configuration(keyframe=True)


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
    # Required by the flux depth routes; qwen keyframes take none.
    control_lora_image_url: str | None = Field(default=None, max_length=6 * 1024 * 1024)
    image_size: ImageSize
    mask_url: str | None = Field(default=None, max_length=6 * 1024 * 1024)
    scene_identity: SceneIdentity | None = None
    # qwen keyframes only: image_url is the render, reference_url the world's
    # art (absent = style in words). The web composites chains itself, so
    # "chain" (the v1 warp input) is refused.
    reference_url: str | None = Field(default=None, max_length=6 * 1024 * 1024)
    keyframe_stage: Literal["first", "chain"] | None = None


class IllustrationInput(BaseModel):
    prompt: str = Field(min_length=3, max_length=1024)
    model: str
    reservation: float
    parameters: dict[str, object]
    inputs: ViewInputs


def validate_inputs(inputs: ViewInputs) -> None:
    for url in (inputs.image_url, *(u for u in (inputs.control_lora_image_url, inputs.mask_url) if u is not None)):
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
    if inputs.reference_url is None:
        return
    # The art or the previous keyframe: any size, PNG or JPEG, still private data.
    try:
        if not inputs.reference_url.startswith(("data:image/png;base64,", "data:image/jpeg;base64,")):
            raise ValueError("Expected private image data")
        with Image.open(io.BytesIO(base64.b64decode(inputs.reference_url.split(",", 1)[1], validate=True))) as image:
            if image.format not in {"PNG", "JPEG"} or getattr(image, "n_frames", 1) != 1:
                raise ValueError("Invalid reference image")
            image.verify()
    except (ValueError, OSError, SyntaxError, Image.DecompressionBombError) as error:
        raise HTTPException(400, "Invalid keyframe reference image") from error


def validate_identity(body: IllustrationInput) -> None:
    for obj in body.inputs.scene_identity.objects if body.inputs.scene_identity else []:
        left, top, right, bottom = obj.bounds_percent
        x, y = obj.center_percent
        if (not 0 <= left <= x <= right <= 100 or not 0 <= top <= y <= bottom <= 100
                or any(d <= 0 for d in obj.dimensions_m)
                or obj.visible_pixels > body.inputs.image_size.width * body.inputs.image_size.height):
            raise HTTPException(400, "Invalid saved visible-object identity measurements")


async def queue_post(model: str, payload: dict[str, object]) -> str:
    """One paid POST: no transport retries, no provider retries, no redirects."""
    async with httpx.AsyncClient(timeout=60, follow_redirects=False,
                                 transport=httpx.AsyncHTTPTransport(retries=0)) as client:
        response = await client.post(f"https://queue.fal.run/{model}",
                                     headers={"Authorization": f"Key {os.environ['FAL_KEY']}", "X-Fal-No-Retry": "1"},
                                     json=payload)
        response.raise_for_status()
    return cast(str, response.json()["request_id"])


KEYFRAME_KEEP = ("Keep image 1's camera, framing and composition exactly: the same building outline, roof line "
                 "and ridge, wall corners, the windows and door where image 1 has them, the ground, the shadow "
                 "and the sky. Do not move, resize, add or remove any building mass. No text or lettering.")
# Research 37: qwen left a well that filled the frame in the render's flat grey.
NOT_NAMED_AS_NEAR = {"building", "tavern", "house", "mesh", "path", "pond"}


def keyframe_prompt(appearance: str, names: list[str], reference: bool, near: str | None = None) -> str:
    """Research-34 prompt (p1-keyframes job A_qwen2511) with the inn's name and
    style replaced by the saved identities and the user's words. `near` names
    the largest visible object that is not a building or ground."""
    named = f" ({', '.join(names)})" if names else ""
    style = appearance.strip().rstrip(".") + "."
    paint = ("Paint every surface, including large objects close to the camera"
             f"{f' and the {near}' if near else ''}, so nothing keeps the render's flat grey or green colours.")
    if reference:
        return ("Image 1 is a 3D render of a building from an exact camera. Image 2 shows the same "
                f"place{named} as finished artwork. Redraw image 1 in the exact art style of image 2: {style} {paint} {KEYFRAME_KEEP}")
    # Words only: no image 2, the style is described instead.
    return (f"Image 1 is a 3D render of a building{named} from an exact camera. "
            f"Redraw image 1 as finished artwork in this art style: {style} {paint} {KEYFRAME_KEEP}")


async def submit_keyframe(body: IllustrationInput) -> dict[str, object]:
    config = configuration(keyframe=True)
    if not config["enabled"]:
        raise HTTPException(503, "Keyframe generation is not configured")
    if body.reservation != config["reservation"] or body.parameters != config["parameters"]:
        raise HTTPException(409, "Illustration generation configuration changed")
    inputs = body.inputs
    if len(body.prompt.strip()) < 3:
        raise HTTPException(400, "An illustration description is required")
    if (inputs.keyframe_stage is None or inputs.scene_identity is None
            or inputs.mask_url is not None or inputs.control_lora_image_url is not None):
        raise HTTPException(400, "A keyframe needs a stage and saved identities, and takes no mask or depth image")
    if inputs.keyframe_stage == "chain":
        raise HTTPException(400, "Chained keyframes are composited by the web now; send the render as a first keyframe")
    validate_identity(body)
    validate_inputs(inputs)
    names = list(dict.fromkeys(obj.label.strip() for obj in inputs.scene_identity.objects[:4] if obj.label.strip()))
    # The identities come sorted by visible pixels, largest first.
    near = next((obj.label.strip() for obj in inputs.scene_identity.objects
                 if obj.kind not in NOT_NAMED_AS_NEAR and obj.label.strip()), None)
    # fal stalls on large data URLs; upload first, then make the one paid POST.
    image_urls = [await to_fal_url(inputs.image_url)]
    if inputs.reference_url is not None:
        image_urls.append(await to_fal_url(inputs.reference_url))
    arguments = {k: v for k, v in body.parameters.items() if k not in {"prompt_version", "gate"}}
    prompt = keyframe_prompt(body.prompt, names, inputs.reference_url is not None, near)
    request_id = await queue_post(body.model, {"prompt": prompt, "image_urls": image_urls,
                                               "image_size": inputs.image_size.model_dump(), **arguments})
    return {"request_id": request_id, "model": body.model}


@router.post("/submit")
async def submit(body: IllustrationInput) -> dict[str, object]:
    if body.model == KEYFRAME_MODEL:
        return await submit_keyframe(body)
    region = body.model == EDIT_MODEL
    config = configuration(region)
    if not config["enabled"]:
        raise HTTPException(503, "Illustration generation is not configured")
    legacy_parameters = {**cast(dict[str, Any], config["parameters"]), "prompt_version": "registered-object-inpaint-depth-v1" if region else "saved-camera-depth-v1"}
    legacy = body.parameters == legacy_parameters
    if body.model != config["model"] or body.reservation != config["reservation"] or not (body.parameters == config["parameters"] or legacy):
        raise HTTPException(409, "Illustration generation configuration changed")
    if len(body.prompt.strip()) < 3:
        raise HTTPException(400, "An illustration description is required")
    if region != (body.inputs.mask_url is not None):
        raise HTTPException(400, "A registered mask is required only for region generation")
    if (body.inputs.control_lora_image_url is None or body.inputs.reference_url is not None
            or body.inputs.keyframe_stage is not None):
        raise HTTPException(400, "Depth generation needs a depth image and takes no keyframe inputs")
    if not legacy and body.inputs.scene_identity is None:
        raise HTTPException(400, "Saved visible-object identities are required; upgrade the asset worker")
    if legacy and body.inputs.scene_identity is not None:
        raise HTTPException(400, "Identity conditioning requires the versioned identity contract")
    validate_identity(body)
    validate_inputs(body.inputs)
    arguments = {k: v for k, v in body.parameters.items() if k not in {"prompt_version", "depth_controlnet"}}
    inputs = body.inputs.model_dump(exclude_none=True)
    identity = inputs.pop("scene_identity", None)
    prompt = ("Illustrate the supplied camera render, using its depth image for structure. "
              "Preserve the camera, framing, silhouettes, openings, landmark positions and object count. "
              "Change surface appearance and artistic treatment, not architecture. "
              f"Appearance: {body.prompt.strip()}")
    if region:
        arguments["controlnets"] = [{**cast(dict[str, Any], EDIT_PARAMETERS["depth_controlnet"]),
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
    return {"request_id": await queue_post(body.model, {"prompt": prompt, **arguments, **inputs}), "model": body.model}


@router.get("/requests/{request_id}")
async def status(request_id: str, model: str = MODEL) -> dict[str, object]:
    if model not in {MODEL, EDIT_MODEL, KEYFRAME_MODEL}:
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
    images = result.get("images") or []
    flags = result.get("has_nsfw_concepts") or []
    # Keyframes keep every unflagged candidate; single-image models fail on any flag.
    safe = [image for n, image in enumerate(images) if image.get("url") and not (n < len(flags) and flags[n])]
    if not safe or (model != KEYFRAME_MODEL and (len(images) != 1 or any(flags))):
        return {"status": "failed"}
    return {"status": "ready", "image": safe[0], "images": safe, "seed": result.get("seed")}


class GateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    image_urls: list[str] = Field(min_length=1, max_length=4)
    box: tuple[int, int, int, int]  # pixels [x0, y0, x1, y1] of the largest building's object pass
    width: int = Field(ge=32, le=1024, strict=True)
    height: int = Field(ge=32, le=1024, strict=True)
    label: str = Field(min_length=1, max_length=80)


def fal_storage_url(url: str) -> bool:
    """https on fal storage only: the gate downloads these, so no other host, port or user info."""
    parts = urlsplit(url)
    host = parts.netloc.lower()
    return (parts.scheme == "https" and len(url) <= 2048
            and all(c.isascii() and (c.isalnum() or c in ".-") for c in host)
            and (host == "fal.media" or host.endswith(".fal.media")))


@router.post("/gate")
async def gate(body: GateInput) -> dict[str, object]:
    """SAM-3 mask of the building inside `box` for each candidate keyframe.
    A null mask_png means SAM-3 found nothing; an outage is a 502, never null."""
    if env_flag("MOCK_PROVIDERS") or not os.environ.get("SHARED_TOKEN") or not os.environ.get("FAL_KEY"):
        raise HTTPException(503, "Keyframe gate unavailable")
    x0, y0, x1, y1 = body.box
    if (not all(fal_storage_url(url) for url in body.image_urls)
            or not (0 <= x0 < x1 <= body.width and 0 <= y0 < y1 <= body.height)):
        raise HTTPException(400, "The gate takes fal storage images and a box inside the frame")
    from providers.image import _fetch_url_bytes

    async def one(url: str) -> dict[str, object]:
        data, _ = await _fetch_url_bytes(url)
        found = await segmenter.sam3_box_mask(data, body.box, body.label, (body.width, body.height))
        mask_png = None
        if found["mask"] is not None:
            buf = io.BytesIO()
            found["mask"].save(buf, "PNG")
            mask_png = base64.b64encode(buf.getvalue()).decode()
        return {"mask_png": mask_png, "request_id": found["request_id"], "score": found["score"]}

    try:
        masks = await asyncio.wait_for(asyncio.gather(*(one(url) for url in body.image_urls)), GATE_TIMEOUT_S)
    except Exception as error:  # the web stores the candidate as unmeasured
        from obs import log

        log("warn", "illustration.gate.failed", error=f"{type(error).__name__}: {error}")
        raise HTTPException(502, "Keyframe gate segmenter failed") from error
    return {"masks": masks}
