"""Explicit saved-camera color/depth conditioning, or qwen keyframes painted
over the exact render; output never defines geometry."""
import asyncio
import base64
import hashlib
import io
import json
import math
import os
from typing import Annotated, Any, Literal, cast
from urllib.parse import urlsplit

import fal_client
import httpx
from fal_client.client import FalClientHTTPError
from fastapi import APIRouter, HTTPException
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, model_validator

from _env import env_flag
from providers import segmenter
from providers._common import to_fal_url

router = APIRouter(prefix="/illustration")
MODEL = "fal-ai/flux-control-lora-depth/image-to-image"
EDIT_MODEL = "fal-ai/flux-general/inpainting"
KEYFRAME_MODEL = "fal-ai/qwen-image-edit-2511"
NANO_KEYFRAME_MODEL = "fal-ai/nano-banana-pro/edit"
FLUX_KEYFRAME_MODEL = "fal-ai/flux-general/image-to-image"
# Two qwen images (about $0.035 each) plus one SAM-3 gate call per image.
KEYFRAME_MIN_RESERVATION_USD = 0.10
NANO_KEYFRAME_MIN_RESERVATION_USD = 0.30
# One rounded-up MP at $0.075 plus one $0.005 SAM gate; no real-CFG or IP adapter surcharge.
FLUX_KEYFRAME_MIN_RESERVATION_USD = 0.15
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
                       "sync_mode": False, "prompt_version": "saved-camera-qwen-keyframe-v5",
                       "negative_prompt": "aerial view, bird's-eye view, isometric view, overhead map composition, "
                       "collage, tile grid, labels, lettering, words, parchment banners",
                       "gate": {"crop_pad": segmenter.CROP_PAD, "centre_tolerance": 0.03, "area_ratio": [0.8, 1.2]}}
NANO_NORMALIZATION = {"version": "nano-1k-half-size-v1", "raw_width": 1376, "raw_height": 768,
                      "width": 688, "height": 384, "operation": "uniform-scale", "scale": 0.5,
                      "crop": False, "stretch": False}
NANO_KEYFRAME_PARAMETERS = {"num_images": 1, "output_format": "png", "aspect_ratio": "16:9",
                            "resolution": "1K", "limit_generations": True, "enable_web_search": False,
                            "prompt_version": "saved-camera-nano-landmarks-v1",
                            "normalization": NANO_NORMALIZATION, "gate": KEYFRAME_PARAMETERS["gate"]}
NANO_GUIDES_KEYFRAME_PARAMETERS = {**NANO_KEYFRAME_PARAMETERS,
                                  "prompt_version": "saved-camera-nano-landmarks-guides-v2",
                                  "structural_guidance": "saved-camera-guides-v1"}
FLUX_KEYFRAME_PARAMETERS = {
    "num_images": 1, "num_inference_steps": 28, "guidance_scale": 3.5, "seed": 42,
    "strength": 0.7, "output_format": "jpeg", "enable_safety_checker": True,
    "sync_mode": False, "use_real_cfg": False, "ip_adapters": [], "controlnets": [],
    "controlnet_unions": [{"path": "Shakker-Labs/FLUX.1-dev-ControlNet-Union-Pro",
                           "controls": [{"control_mode": mode, "conditioning_scale": 1,
                                         "start_percentage": 0, "end_percentage": 1}
                                        for mode in ("depth", "canny")]}],
    "reference_strength": 0.65, "reference_start": 0, "reference_end": 1,
    "prompt_version": "saved-camera-flux-reference-controlnet-v1",
    "structural_guidance": "saved-camera-controlnet-v1", "gate": KEYFRAME_PARAMETERS["gate"],
}
# Shakker's documented multi-control example uses depth 0.2 and canny 0.4.
# This is an explicit alternate profile; the first trial's contract remains unchanged.
FLUX_BALANCED_KEYFRAME_PARAMETERS = {
    **FLUX_KEYFRAME_PARAMETERS, "strength": 0.85,
    "prompt_version": "saved-camera-flux-reference-controlnet-v2",
    "controlnet_unions": [{"path": "Shakker-Labs/FLUX.1-dev-ControlNet-Union-Pro",
                           "controls": [{"control_mode": mode, "conditioning_scale": scale,
                                         "start_percentage": 0, "end_percentage": 1}
                                        for mode, scale in (("depth", 0.2), ("canny", 0.4))]}],
}


def configuration(region: bool = False, keyframe: bool = False) -> dict[str, object]:
    prefix = "ILLUSTRATION_EDIT" if region else "ILLUSTRATION_KEYFRAME" if keyframe else "ILLUSTRATION"
    try:
        reservation = float(os.environ.get(f"{prefix}_RESERVATION_USD", "0"))
    except ValueError:
        reservation = 0
    keyframe_model = os.environ.get("ILLUSTRATION_KEYFRAME_MODEL", KEYFRAME_MODEL)
    nano = keyframe_model == NANO_KEYFRAME_MODEL
    flux = keyframe_model == FLUX_KEYFRAME_MODEL
    flux_parameters = (FLUX_BALANCED_KEYFRAME_PARAMETERS
                       if os.environ.get("ILLUSTRATION_KEYFRAME_FLUX_BALANCED_ENABLED") == "1"
                       else FLUX_KEYFRAME_PARAMETERS)
    nano_parameters = (NANO_GUIDES_KEYFRAME_PARAMETERS
                       if os.environ.get("ILLUSTRATION_KEYFRAME_NANO_GUIDES_ENABLED") == "1"
                       else NANO_KEYFRAME_PARAMETERS)
    floor = (NANO_KEYFRAME_MIN_RESERVATION_USD if nano else FLUX_KEYFRAME_MIN_RESERVATION_USD
             if flux else KEYFRAME_MIN_RESERVATION_USD) if keyframe else 0
    enabled = (os.environ.get(f"{prefix}_GENERATION_ENABLED") == "1"
               and not env_flag("MOCK_PROVIDERS")
               and bool(os.environ.get("SHARED_TOKEN")) and bool(os.environ.get("FAL_KEY"))
               and math.isfinite(reservation) and 0 < reservation <= 10 and reservation >= floor
               and (not keyframe or keyframe_model in {KEYFRAME_MODEL, NANO_KEYFRAME_MODEL, FLUX_KEYFRAME_MODEL}))
    model, parameters = ((EDIT_MODEL, EDIT_PARAMETERS) if region else
                         (keyframe_model, nano_parameters if nano else flux_parameters if flux else KEYFRAME_PARAMETERS)
                         if keyframe else (MODEL, PARAMETERS))
    return {"enabled": enabled, "model": model, "reservation": reservation if enabled else 0,
            "parameters": parameters, "reason": None if enabled else
            "Illustration generation needs a provider key, shared token and an operator-set reservation"
            + (f" of at least ${floor:.2f} with an approved model." if keyframe else ".")}


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
    reference_kind: Literal["source-art-material-crops-v1", "source-art-map-landmarks-v1"] | None = None
    landmark_urls: list[Annotated[str, Field(max_length=6 * 1024 * 1024)]] | None = Field(default=None, min_length=4, max_length=4)
    landmark_labels: list[Annotated[str, Field(min_length=1, max_length=160)]] | None = Field(default=None, min_length=4, max_length=4)
    structural_guide_url: str | None = Field(default=None, max_length=6 * 1024 * 1024)
    depth_guide_url: str | None = Field(default=None, max_length=6 * 1024 * 1024)
    outline_guide_url: str | None = Field(default=None, max_length=6 * 1024 * 1024)
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


def validate_nano_references(inputs: ViewInputs, profile: str = "Nano") -> None:
    if inputs.reference_url is None or inputs.reference_kind != "source-art-map-landmarks-v1":
        raise HTTPException(400, f"{profile} keyframes need the saved full map reference")
    if (inputs.image_size.width, inputs.image_size.height) != (688, 384):
        raise HTTPException(400, f"{profile} keyframes need a registered 688 by 384 camera capture")
    if inputs.landmark_urls is None or inputs.landmark_labels is None:
        raise HTTPException(400, "Four landmark crop images and saved identity labels are required together")
    labels = inputs.landmark_labels
    names = {obj.label for obj in inputs.scene_identity.objects} if inputs.scene_identity else set()
    if (len(inputs.landmark_urls) != 4 or len(labels) != 4 or len(set(labels)) != 4
            or any(label not in names for label in labels)):
        raise HTTPException(400, "Four unique landmark labels must belong to the saved visible identities")
    for url in [inputs.reference_url, *inputs.landmark_urls]:
        try:
            if not url.startswith("data:image/png;base64,"):
                raise ValueError("Expected a private lossless PNG reference")
            data = base64.b64decode(url.split(",", 1)[1], validate=True)
            with Image.open(io.BytesIO(data)) as image:
                if (image.format != "PNG" or getattr(image, "n_frames", 1) != 1
                        or not all(16 <= d <= 4096 for d in image.size)
                        or image.width * image.height > 16 * 1024 * 1024):
                    raise ValueError("Invalid landmark reference dimensions or orientation")
                image.verify()
            with Image.open(io.BytesIO(data)) as image:
                if image.getexif().get(274, 1) != 1:
                    raise ValueError("Reference orientation differs from its saved pixels")
        except (ValueError, OSError, SyntaxError, Image.DecompressionBombError) as error:
            raise HTTPException(400, f"Invalid {profile} map or landmark PNG reference") from error


def validate_nano_guides(inputs: ViewInputs) -> None:
    """Visual references only; these are not a provider depth-control channel."""
    if inputs.structural_guide_url is None or inputs.depth_guide_url is None:
        raise HTTPException(400, "Nano guide keyframes require both registered structural and depth PNG guides")
    for url in [inputs.structural_guide_url, inputs.depth_guide_url]:
        try:
            if not url.startswith("data:image/png;base64,"):
                raise ValueError("Expected a private lossless PNG guide")
            data = base64.b64decode(url.split(",", 1)[1], validate=True)
            with Image.open(io.BytesIO(data)) as image:
                if image.format != "PNG" or image.size != (688, 384) or getattr(image, "n_frames", 1) != 1:
                    raise ValueError("Guide dimensions differ from the registered camera")
                image.verify()
            with Image.open(io.BytesIO(data)) as image:
                if image.getexif().get(274, 1) != 1:
                    raise ValueError("Guide orientation differs from its saved pixels")
        except (ValueError, OSError, SyntaxError, Image.DecompressionBombError) as error:
            raise HTTPException(400, "Invalid registered Nano structural or depth PNG guide") from error


def validate_flux_guides(inputs: ViewInputs) -> None:
    if inputs.depth_guide_url is None or inputs.outline_guide_url is None:
        raise HTTPException(400, "Flux keyframes require both registered depth and pure outline PNG guides")
    for url in [inputs.image_url, inputs.depth_guide_url, inputs.outline_guide_url,
                *([inputs.structural_guide_url] if inputs.structural_guide_url is not None else [])]:
        try:
            if not url.startswith("data:image/png;base64,"):
                raise ValueError("Expected a private lossless PNG guide")
            data = base64.b64decode(url.split(",", 1)[1], validate=True)
            with Image.open(io.BytesIO(data)) as image:
                if image.format != "PNG" or image.size != (688, 384) or getattr(image, "n_frames", 1) != 1:
                    raise ValueError("Guide dimensions differ from the registered camera")
                image.verify()
            with Image.open(io.BytesIO(data)) as image:
                if image.getexif().get(274, 1) != 1:
                    raise ValueError("Guide orientation differs from its saved pixels")
                if url == inputs.outline_guide_url:
                    colors = image.convert("RGBA").getcolors(maxcolors=3)
                    if colors is None or {color for _, color in colors} != {(0, 0, 0, 255), (255, 255, 255, 255)}:
                        raise ValueError("Outline must contain only opaque black background and white edges")
        except (ValueError, OSError, SyntaxError, Image.DecompressionBombError) as error:
            raise HTTPException(400, "Invalid registered Flux depth or pure outline PNG guide") from error


async def queue_post(model: str, payload: dict[str, object]) -> str:
    """One paid POST: no transport retries, no provider retries, no redirects."""
    async with httpx.AsyncClient(timeout=60, follow_redirects=False,
                                 transport=httpx.AsyncHTTPTransport(retries=0)) as client:
        response = await client.post(f"https://queue.fal.run/{model}",
                                     headers={"Authorization": f"Key {os.environ['FAL_KEY']}", "X-Fal-No-Retry": "1"},
                                     json=payload)
        response.raise_for_status()
    return cast(str, response.json()["request_id"])


KEYFRAME_KEEP = ("Image 1 alone defines the camera, framing, perspective and composition. Keep its exact "
                 "visible silhouettes, roof lines and ridges, wall corners, windows, doorways, stairs and "
                 "furnishings in their screen positions, including the ground, shadows and sky. "
                 "Do not move, resize, add or remove any building mass or opening. "
                 "Surface detail must stay inside these shapes and leave passages open. No text or lettering.")
KEYFRAME_FINISH = ("Render a finished, richly authored environment in the requested medium, with coherent "
                   "lighting, readable material texture, varied local colour, convincing wear and handcrafted "
                   "surface detail. Use the reference's treatment of masonry, timber, roofing, metal and "
                   "vegetation when present; retain every visible landmark's distinct appearance. "
                   "Resolve foreground surfaces and distant buildings as artwork rather than flat shaded blocks. "
                   "Keep fine detail attached to its surface; avoid uniform cross-hatching over the entire frame.")
# Research 37: qwen left a well that filled the frame in the render's flat grey.
NOT_NAMED_AS_NEAR = {"building", "tavern", "house", "mesh", "path", "pond"}


def keyframe_prompt(appearance: str, names: list[str], reference: bool, near: str | None = None,
                    identity: SceneIdentity | None = None) -> str:
    """Render-camera authority with source-art appearance and visible identity anchors.

    The source can be an aerial map, not this camera's finished picture. Screen
    bounds come from the exact opaque object pass, never from that source art.
    """
    named = f" ({', '.join(names)})" if names else ""
    style = appearance.strip().rstrip(".") + "."
    paint = ("Paint every surface, including large objects close to the camera"
             f"{f' and the {near}' if near else ''}, so nothing keeps the render's flat grey or green colours.")
    if reference:
        role = ("Image 2 contains isolated material crops from the saved world artwork, rearranged into a "
                "sample sheet. The crops have no shared viewpoint, layout or spatial relationship. "
                "Use their artistic medium, palette, masonry, timber, roofing, metal and vegetation "
                "treatment to paint the corresponding surfaces of image 1. "
                "Never reproduce the sample sheet, its grid or any crop's composition. ")
        finish = KEYFRAME_FINISH
    else:
        role = ""
        finish = KEYFRAME_FINISH.replace("Use the reference's treatment of", "Use the requested treatment of")
    anchors = ""
    if identity and identity.objects:
        records = [{"name": obj.label, "kind": obj.kind,
                    "center_percent": obj.center_percent, "bounds_percent": obj.bounds_percent}
                   for obj in identity.objects]
        anchors = (" Visible saved objects in image 1 (screen percentages: top-left origin, x right, y down; "
                   "bounds describe only visible pixels): "
                   + json.dumps(records, ensure_ascii=False, separators=(",", ":"))
                   + ". Match names to visible surfaces; do not invent hidden parts. "
                   "Unlisted objects and surfaces still follow image 1 exactly.")
    return (f"Image 1 is the exact saved-camera render of this environment{named}. "
            f"{role}Redraw image 1 as finished artwork in this art style: {style} {paint} "
            f"{finish} {KEYFRAME_KEEP}{anchors}")


def nano_keyframe_prompt(appearance: str, inputs: ViewInputs) -> str:
    anchors = [{"name": obj.label, "kind": obj.kind, "center_percent": obj.center_percent,
                "bounds_percent": obj.bounds_percent} for obj in inputs.scene_identity.objects] if inputs.scene_identity else []
    crops = " ".join(f"Image {index + 3} is the source-map crop of {label}."
                     for index, label in enumerate(inputs.landmark_labels or []))
    guide_labels = "; ".join(f"{index + 1}: {label} (source crop image {index + 3})"
                             for index, label in enumerate(inputs.landmark_labels or []))
    guides = ("Image 7 is the registered image-1 object-contour guide with numbered markers 1 through 4. "
              f"The numbers bind to the saved landmark crop order: {guide_labels}. "
              "Follow its exact outlines and pixel positions, preserving small far landmarks behind near ones; "
              "guide numbers, colours and outlines must not appear in the artwork. "
              "Image 8 is the same camera's saved depth guide: near geometry is brighter, far geometry darker, "
              "and black is sky/background. Use it to preserve distance and occlusion, never as the output palette. "
              "Both guides describe image 1 exactly; they do not authorize a new composition. "
              if inputs.structural_guide_url is not None and inputs.depth_guide_url is not None else "")
    camera = "eye-level saved walk-camera" if inputs.scene_identity and inputs.scene_identity.mode == "walk" else "saved-camera"
    return (f"Paint image 1, the exact {camera} render, as finished fantasy artwork. "
            "It alone defines the viewpoint, side of the street, near/far ordering, building scale, "
            "silhouettes, occlusion and open ground. Image 2 is the original saved world map: use it "
            "to identify each named landmark's actual architecture, roof shape and colour, facade, "
            "windows, signs, materials and artistic medium. Its aerial viewpoint is not the output camera. "
            f"{crops} Crop boundaries and neighbouring fragments are references, not output layout. {guides}"
            "Paint every corresponding landmark inside its image-1 silhouette; do not swap an inn with "
            "a forge, move a building across the street, replace glass with opaque masonry, or invent "
            "new stairs, chimneys, openings or roof masses. Preserve each landmark's distinctive identity. "
            "Keep the map's rich illustrated surface detail and lighting, never the flat block colours. "
            "Do not draw labels, banners, map lettering, a crop grid, aerial composition, or a collage. "
            f"Appearance: {appearance.strip()} {KEYFRAME_KEEP} "
            "Saved image-1 identity bounds (top-left screen percentages; data, not lettering): "
            + json.dumps(anchors, ensure_ascii=False, separators=(",", ":")))


def flux_keyframe_prompt(appearance: str, inputs: ViewInputs) -> str:
    camera = "eye-level saved walk-camera" if inputs.scene_identity and inputs.scene_identity.mode == "walk" else "exact saved-camera"
    anchors = [{"name": obj.label, "center_percent": obj.center_percent,
                "visible_bounds_percent": obj.bounds_percent}
               for obj in inputs.scene_identity.objects if obj.label in (inputs.landmark_labels or [])] if inputs.scene_identity else []
    return (f"Paint the supplied {camera} render as rich fantasy illustration. "
            "The render, registered depth control and pure edge control define the camera, framing, "
            "building silhouettes, side of the street, scale, near/far ordering, occlusion and open ground. "
            "Keep these structures in their saved screen positions. The reference-only image is the "
            "original saved world map: use its illustrated medium, lighting, materials and the distinct "
            "appearance of each named landmark; do not copy its aerial composition. "
            "Identify the four corresponding map landmarks by name: "
            + ", ".join(inputs.landmark_labels or []) + ". "
            "Do not swap a forge with an inn, move buildings across the street, replace glass with "
            "opaque masonry, enlarge distant buildings into the foreground, invent stairs or openings, "
            "or draw lettering, labels, control edges or a collage. "
            f"Appearance: {appearance.strip()} {KEYFRAME_FINISH} "
            "Saved identity bounds (top-left screen percentages; data, not lettering): "
            + json.dumps(anchors, ensure_ascii=False, separators=(",", ":")))


async def submit_keyframe(body: IllustrationInput) -> dict[str, object]:
    config = configuration(keyframe=True)
    if not config["enabled"]:
        raise HTTPException(503, "Keyframe generation is not configured")
    if body.model != config["model"] or body.reservation != config["reservation"] or body.parameters != config["parameters"]:
        raise HTTPException(409, "Illustration generation configuration changed")
    inputs = body.inputs
    if len(body.prompt.strip()) < 3:
        raise HTTPException(400, "An illustration description is required")
    if (inputs.keyframe_stage is None or inputs.scene_identity is None
            or inputs.mask_url is not None or inputs.control_lora_image_url is not None):
        raise HTTPException(400, "A keyframe needs a stage and saved identities, and takes no mask or depth image")
    if inputs.keyframe_stage == "chain":
        raise HTTPException(400, "Chained keyframes are composited by the web now; send the render as a first keyframe")
    nano = body.model == NANO_KEYFRAME_MODEL
    flux = body.model == FLUX_KEYFRAME_MODEL
    guides = nano and body.parameters.get("structural_guidance") == "saved-camera-guides-v1"
    if flux:
        validate_nano_references(inputs, "Flux")
        validate_flux_guides(inputs)
    elif nano:
        validate_nano_references(inputs)
        if inputs.outline_guide_url is not None:
            raise HTTPException(400, "Nano keyframes take no Flux outline control")
        if guides:
            validate_nano_guides(inputs)
        elif inputs.structural_guide_url is not None or inputs.depth_guide_url is not None:
            raise HTTPException(400, "Nano structural guides require the pinned guide profile")
    elif (inputs.landmark_urls is not None or inputs.landmark_labels is not None
          or inputs.structural_guide_url is not None or inputs.depth_guide_url is not None
          or inputs.outline_guide_url is not None
          or inputs.reference_kind not in {None, "source-art-material-crops-v1"}):
        raise HTTPException(400, "Qwen keyframes take only the versioned material-crop reference")
    if (inputs.reference_url is None) != (inputs.reference_kind is None):
        raise HTTPException(400, "Source-art keyframes need a versioned reference")
    if inputs.reference_url is not None and not inputs.reference_url.startswith("data:image/png;base64,"):
        raise HTTPException(400, "Material-crop references must be lossless private PNGs")
    validate_identity(body)
    validate_inputs(inputs)
    names = list(dict.fromkeys(obj.label.strip() for obj in inputs.scene_identity.objects[:4] if obj.label.strip()))
    # The identities come sorted by visible pixels, largest first.
    near = next((obj.label.strip() for obj in inputs.scene_identity.objects
                 if obj.kind not in NOT_NAMED_AS_NEAR and obj.label.strip()), None)
    arguments = {k: v for k, v in body.parameters.items()
                 if k not in {"prompt_version", "gate", "normalization", "structural_guidance"}}
    if flux:
        # Crop bytes are validated source provenance, not extra provider references.
        # This model exposes a single reference-only appearance image, separate from controls.
        render = await to_fal_url(inputs.image_url)
        reference = await to_fal_url(cast(str, inputs.reference_url))
        depth = await to_fal_url(cast(str, inputs.depth_guide_url))
        outline = await to_fal_url(cast(str, inputs.outline_guide_url))
        union = cast(list[dict[str, Any]], arguments["controlnet_unions"])[0]
        arguments["controlnet_unions"] = [{**union, "controls": [
            {**control, "control_image_url": url}
            for control, url in zip(union["controls"], [depth, outline], strict=True)]}]
        payload = {**arguments, "prompt": flux_keyframe_prompt(body.prompt, inputs),
                   "image_url": render, "reference_image_url": reference,
                   "image_size": inputs.image_size.model_dump()}
        return {"request_id": await queue_post(body.model, payload), "model": body.model}
    # fal stalls on large data URLs; upload first, then make the one paid POST.
    image_urls = [await to_fal_url(inputs.image_url)]
    if inputs.reference_url is not None:
        image_urls.append(await to_fal_url(inputs.reference_url))
    for url in inputs.landmark_urls or []:
        image_urls.append(await to_fal_url(url))
    if guides:
        image_urls.extend([await to_fal_url(cast(str, inputs.structural_guide_url)),
                           await to_fal_url(cast(str, inputs.depth_guide_url))])
    prompt = (nano_keyframe_prompt(body.prompt, inputs) if nano else
              keyframe_prompt(body.prompt, names, inputs.reference_url is not None, near, inputs.scene_identity))
    payload = {"prompt": prompt, "image_urls": image_urls, **arguments}
    if not nano:
        payload["image_size"] = inputs.image_size.model_dump()
    request_id = await queue_post(body.model, payload)
    return {"request_id": request_id, "model": body.model}


@router.post("/submit")
async def submit(body: IllustrationInput) -> dict[str, object]:
    if body.model in {KEYFRAME_MODEL, NANO_KEYFRAME_MODEL, FLUX_KEYFRAME_MODEL}:
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
    if (body.inputs.control_lora_image_url is None or body.inputs.reference_url is not None or body.inputs.reference_kind is not None
            or body.inputs.keyframe_stage is not None or body.inputs.landmark_urls is not None or body.inputs.landmark_labels is not None
            or body.inputs.structural_guide_url is not None or body.inputs.depth_guide_url is not None
            or body.inputs.outline_guide_url is not None):
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


async def nano_output_metadata(image: dict[str, Any]) -> dict[str, object]:
    """Measure the raw provider bytes; never resize, crop or repaint them here."""
    normalization: dict[str, object] = {**NANO_NORMALIZATION, "compatible": False}
    raw: dict[str, object] = {"valid": False}
    try:
        url = image.get("url")
        if not isinstance(url, str) or not fal_storage_url(url):
            raise ValueError("Nano output is not on fal storage")
        from providers.image import _fetch_url_bytes

        data, _ = await _fetch_url_bytes(url)
        raw.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        if len(data) > 12 * 1024 * 1024:
            raise ValueError("Nano output exceeds the raw byte limit")
        with Image.open(io.BytesIO(data)) as output:
            raw.update(width=output.width, height=output.height, format=output.format)
            if (output.format != "PNG" or getattr(output, "n_frames", 1) != 1
                    or output.width * output.height > 4 * 1024 * 1024):
                raise ValueError("Nano output must be one upright PNG")
            output.verify()
        with Image.open(io.BytesIO(data)) as output:
            if output.getexif().get(274, 1) != 1:
                raise ValueError("Nano output orientation differs from its saved pixels")
        raw["valid"] = True
        normalization["compatible"] = (raw["width"], raw["height"]) == (1376, 768)
        if not normalization["compatible"]:
            normalization["reason"] = "Unexpected raw dimensions; preserve the output and do not crop or stretch it"
    except Exception as error:
        normalization["reason"] = f"Raw Nano output could not be verified: {type(error).__name__}"
    return {"raw_image": raw, "normalization": normalization}


async def flux_output_metadata(image: dict[str, Any]) -> dict[str, object]:
    """Retain the actual output; only an exact registered JPEG can proceed to a gate."""
    raw: dict[str, object] = {"valid": False}
    try:
        url = image.get("url")
        if not isinstance(url, str) or not fal_storage_url(url):
            raise ValueError("Flux output is not on fal storage")
        from providers.image import _fetch_url_bytes

        data, _ = await _fetch_url_bytes(url)
        raw.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        if len(data) > 12 * 1024 * 1024:
            raise ValueError("Flux output exceeds the raw byte limit")
        with Image.open(io.BytesIO(data)) as output:
            raw.update(width=output.width, height=output.height, format=output.format)
            if (output.format != "JPEG" or output.size != (688, 384)
                    or getattr(output, "n_frames", 1) != 1):
                raise ValueError("Flux output must be one registered 688 by 384 JPEG")
            output.verify()
        with Image.open(io.BytesIO(data)) as output:
            if output.getexif().get(274, 1) != 1:
                raise ValueError("Flux output orientation differs from its saved pixels")
            output.load()
        raw["valid"] = True
    except Exception as error:
        raw["reason"] = f"Raw Flux output could not be verified: {type(error).__name__}"
    return {"raw_image": raw}


@router.get("/requests/{request_id}")
async def status(request_id: str, model: str = MODEL) -> dict[str, object]:
    if model not in {MODEL, EDIT_MODEL, KEYFRAME_MODEL, NANO_KEYFRAME_MODEL, FLUX_KEYFRAME_MODEL}:
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
    response: dict[str, object] = {"status": "ready", "image": safe[0], "images": safe, "seed": result.get("seed")}
    if model in {NANO_KEYFRAME_MODEL, FLUX_KEYFRAME_MODEL}:
        metadata = (await nano_output_metadata(safe[0]) if model == NANO_KEYFRAME_MODEL else
                    await flux_output_metadata(safe[0]))
        response.update(metadata)
        raw = cast(dict[str, object], metadata["raw_image"])
        if "width" in raw and "height" in raw:
            response["image"] = {**safe[0], "width": raw["width"], "height": raw["height"]}
            response["images"] = [response["image"]]
    return response


VisualRGB = tuple[Annotated[int, Field(ge=0, le=255, strict=True)],
                  Annotated[int, Field(ge=0, le=255, strict=True)],
                  Annotated[int, Field(ge=0, le=255, strict=True)]]


class GateVisualGeometry(BaseModel):
    """Private root experiment; trusted production callers must derive these from saved views."""
    model_config = ConfigDict(extra="forbid")
    objects_data_url: str = Field(max_length=3 * 1024 * 1024)
    subject_rgb: VisualRGB
    other_building_rgbs: list[VisualRGB] = Field(min_length=3, max_length=3)
    road_rgb: VisualRGB


class GateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    image_urls: list[Annotated[str, Field(max_length=6 * 1024 * 1024)]] = Field(min_length=1, max_length=4)
    box: tuple[int, int, int, int]  # pixels [x0, y0, x1, y1] of the gate subject in the object pass
    width: int = Field(ge=32, le=1024, strict=True)
    height: int = Field(ge=32, le=1024, strict=True)
    label: str = Field(min_length=1, max_length=80)  # "building", or the subject's kind ("well", "object")
    segmentation_profile: Literal["sam3-visual-full-frame-v1"] | None = None
    visual_geometry: GateVisualGeometry | None = None

    @model_validator(mode="before")
    @classmethod
    def visual_pixel_corners(cls, value: Any) -> Any:
        # Preserve old coercion semantics; the new profile requires exact integers.
        if isinstance(value, dict) and value.get("segmentation_profile") == segmenter.SAM3_VISUAL_PROFILE:
            box = value.get("box")
            if (not isinstance(box, (tuple, list)) or len(box) != 4
                    or any(type(coordinate) is not int for coordinate in box)):
                raise ValueError("Visual box must contain exact integer pixel corners")
        return value


def fal_storage_url(url: str) -> bool:
    """https on fal storage only: the gate downloads these, so no other host, port or user info."""
    parts = urlsplit(url)
    host = parts.netloc.lower()
    return (parts.scheme == "https" and len(url) <= 2048
            and all(c.isascii() and (c.isalnum() or c in ".-") for c in host)
            and (host == "fal.media" or host.endswith(".fal.media")))


def normalized_nano_gate_bytes(url: str, width: int, height: int) -> bytes:
    """The web's exact normalized JPEG is measured, not the raw provider PNG."""
    try:
        if (width, height) != (688, 384) or not url.startswith("data:image/jpeg;base64,"):
            raise ValueError("Expected the registered Nano JPEG")
        data = base64.b64decode(url.split(",", 1)[1], validate=True)
        with Image.open(io.BytesIO(data)) as image:
            if image.format != "JPEG" or image.size != (width, height) or getattr(image, "n_frames", 1) != 1:
                raise ValueError("Gate image differs from the registered camera")
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            if image.getexif().get(274, 1) != 1:
                raise ValueError("Gate image orientation differs from the registered camera")
        return data
    except (ValueError, OSError, SyntaxError, Image.DecompressionBombError) as error:
        raise HTTPException(400, "Invalid normalized Nano gate image") from error


@router.post("/gate")
async def gate(body: GateInput) -> dict[str, object]:
    """SAM-3 mask of `label` (the gate subject) inside `box` for each candidate keyframe.
    A null mask_png means SAM-3 found nothing; an outage is a 502, never null."""
    if env_flag("MOCK_PROVIDERS") or not os.environ.get("SHARED_TOKEN") or not os.environ.get("FAL_KEY"):
        raise HTTPException(503, "Keyframe gate unavailable")
    x0, y0, x1, y1 = body.box
    if not (0 <= x0 < x1 <= body.width and 0 <= y0 < y1 <= body.height):
        raise HTTPException(400, "The gate takes fal storage images and a box inside the frame")
    inline = {}
    for url in body.image_urls:
        if url.startswith("data:"):
            inline[url] = normalized_nano_gate_bytes(url, body.width, body.height)
        elif not fal_storage_url(url):
            raise HTTPException(400, "The gate takes fal storage or registered private Nano images")
    visual = body.visual_geometry
    objects_bytes = b""
    if (body.segmentation_profile is None) != (visual is None):
        raise HTTPException(400, "Visual geometry and segmentation profile must be paired")
    if visual is not None:
        try:
            if (len(body.image_urls) != 1 or body.image_urls[0] not in inline
                    or (body.width, body.height) != segmenter.SAM3_VISUAL_SIZE
                    or len(inline[body.image_urls[0]]) > segmenter.SAM3_VISUAL_IMAGE_MAX_BYTES
                    or segmenter._sam_model() != "fal-ai/sam-3/image"
                    or not visual.objects_data_url.startswith("data:image/png;base64,")):
                raise ValueError("Visual profile requires one exact private JPEG and the pinned SAM model")
            objects_bytes = base64.b64decode(visual.objects_data_url.split(",", 1)[1], validate=True)
            # Validate all canonical geometry before the sole paid request.
            segmenter.sam3_visual_prompts(objects_bytes, body.box, visual.subject_rgb,
                                          visual.other_building_rgbs, visual.road_rgb)
        except (ValueError, OSError, SyntaxError, Image.DecompressionBombError) as error:
            raise HTTPException(400, "Invalid full-frame visual geometry") from error
    from providers.image import _fetch_url_bytes

    async def one(url: str) -> dict[str, object]:
        if url in inline:
            data = inline[url]
        else:
            data, _ = await _fetch_url_bytes(url)
        if visual is not None:
            found = await segmenter.sam3_visual_full_frame_mask(data, objects_bytes, body.box, visual.subject_rgb,
                                                               visual.other_building_rgbs, visual.road_rgb)
        else:
            found = await segmenter.sam3_box_mask(data, body.box, body.label, (body.width, body.height))
        mask_png = None
        if found["mask"] is not None:
            buf = io.BytesIO()
            found["mask"].save(buf, "PNG")
            mask_png = base64.b64encode(buf.getvalue()).decode()
        response: dict[str, object] = {"mask_png": mask_png, "request_id": found["request_id"], "score": found["score"]}
        if visual is not None:
            response["visual_prompt_proof"] = found["visual_prompt_proof"]
        return response

    try:
        masks = await asyncio.wait_for(asyncio.gather(*(one(url) for url in body.image_urls)), GATE_TIMEOUT_S)
    except segmenter.Sam3VisualPromptError as error:
        raise HTTPException(502, {"message": "Acknowledged visual segmenter failed", "request_id": error.request_id,
                                  "segmentation_profile": body.segmentation_profile,
                                  "visual_prompt_proof": error.proof}) from error
    except Exception as error:  # the web stores the candidate as unmeasured
        from obs import log

        log("warn", "illustration.gate.failed", error=f"{type(error).__name__}: {error}")
        raise HTTPException(502, "Keyframe gate segmenter failed") from error
    return {"masks": masks, "segmentation_profile": body.segmentation_profile} if visual is not None else {"masks": masks}
