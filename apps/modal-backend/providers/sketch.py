"""Sketch rendering with deterministic protection, independent of model masks."""

from __future__ import annotations

import base64
import io
import math
import time
from typing import Literal

from PIL import Image, ImageChops, ImageOps
from pydantic import BaseModel, Field

from providers import image as images
from providers._common import to_fal_url
from providers.render_budget import RenderBudget

MODELS = {
    "openai/gpt-image-2.5/flare/edit",
    "openai/gpt-image-2.5/sunburst/edit",
    "fal-ai/nano-banana-pro/edit",
}


class SketchInput(BaseModel):
    kind: Literal["create", "edit"]
    scope: Literal["region", "whole"] = "region"
    focus_region: bool = False
    width: int = Field(ge=16, le=4096)
    height: int = Field(ge=16, le=4096)
    guide: str = Field(max_length=12_000_000)
    mask: str | None = Field(default=None, max_length=12_000_000)
    style: str | None = Field(default=None, max_length=12_000_000)
    workflow: Literal["render", "material", "placement", "viewpoint"] = "render"
    output: Literal["auto", "object", "environment", "artwork"] = "auto"
    material: Literal["custom", "ceramic", "metal", "fabric", "wood", "glass"] = "custom"
    viewpoint: Literal["eye_level", "overhead", "front", "three_quarter"] = "eye_level"
    subject: str | None = Field(default=None, max_length=12_000_000)


def workflow_prompt(sketch: SketchInput, has_source: bool, instruction: str) -> str:
    if has_source:
        prompt = (
            "Image 1 is the CLEAN ORIGINAL. Image 2 shows the same image with correction "
            "instructions drawn over it. Apply those instructions to image 1. "
            "Arrows, colored circles, and annotation text are instructions, not artwork: "
            "omit them from the result. "
        )
        if sketch.workflow != "viewpoint":
            prompt += "Preserve the original camera, composition, lettering, and details except where explicitly changed. "
    else:
        prompt = (
            "Turn the first image's rough drawing into a finished image. Follow its spatial "
            "layout, object placement, shapes, and requested labels. Interpret arrows and "
            "explanatory notes as instructions, not visible artwork. Do not show the sketch "
            "beside the result or a hand drawing it. "
        )
    if sketch.workflow == "render" and sketch.output != "auto":
        prompt += {
            "object": "Render a finished object with dimensional form, coherent lighting, and the drawn silhouette. ",
            "environment": "Render a finished environment, retaining the drawn landmark positions and layout. ",
            "artwork": "Render finished artwork, retaining the drawing's composition and requested lettering. ",
        }[sketch.output]
    elif sketch.workflow == "material":
        material = {
            "custom": "the material and finish requested below",
            "ceramic": "glazed ceramic",
            "metal": "brushed metal",
            "fabric": "woven fabric",
            "wood": "natural wood",
            "glass": "translucent glass",
        }[sketch.material]
        prompt += (
            f"Create a material variation using {material}. Change surface appearance only; "
            "preserve silhouette, proportions, identity, pose, geometry, camera, and placement. "
            "Adapt reflections and lighting to the new material without redesigning the object. "
        )
    elif sketch.workflow == "placement":
        prompt += (
            "Image 3 is the OBJECT REFERENCE, not a style reference or a replacement scene. "
            "Place that same recognizable object inside the selected region of image 1. "
            "Follow the drawn placement, preserve its design and proportions, and match the "
            "scene perspective, scale, lighting, contact shadows, and occlusion. "
            "Do not copy the reference background. Confine changes, including shadows, to the editable region. "
        )
    elif sketch.workflow == "viewpoint":
        view = sketch.viewpoint.replace("_", "-")
        prompt += (
            f"Propose a {view} view of the SAME place or object, not a new design. "
            "The camera may change for this workflow. Retain identifiable landmarks, materials, "
            "proportions, and relative spatial relationships visible in the source. "
            "Infer hidden surfaces conservatively; do not add unrelated architecture or objects. "
        )
    if sketch.style:
        prompt += "The LAST image is a style reference only; do not copy its layout or objects. "
        if sketch.workflow == "material":
            prompt += "The requested material takes precedence over the style reference's surface material. "
    return prompt + "Return ONE image filling the exact input frame. " + instruction


def decode(data: str) -> Image.Image:
    if not data.startswith(
        ("data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,")
    ):
        raise ValueError("Sketch images must be embedded PNG, JPEG, or WebP")
    raw = base64.b64decode(data.split(",", 1)[1], validate=True)
    if len(raw) > 9_000_000:
        raise ValueError("Sketch image is too large")
    image = Image.open(io.BytesIO(raw))
    if image.width * image.height > 8_294_400:
        raise ValueError("Sketch image has too many pixels")
    return ImageOps.exif_transpose(image).convert("RGBA")


def png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def data_url(image: Image.Image) -> str:
    return "data:image/png;base64," + base64.b64encode(png(image)).decode()


def working_frame(size: tuple[int, int]) -> tuple[tuple[int, int], tuple[int, int]]:
    w, h = size
    scale = min(1.0, 2048 / max(w, h))
    # Expand small inputs, then pad to the provider's multiples-of-16 grid.
    scale = max(scale, math.sqrt(700_000 / (w * h)))
    rw, rh = round(w * scale), round(h * scale)
    pw, ph = max(rw, math.ceil(rh / 3)), max(rh, math.ceil(rw / 3))
    pw, ph = math.ceil(pw / 16) * 16, math.ceil(ph / 16) * 16
    if max(pw, ph) > 3840 or pw * ph > 8_294_400:
        raise ValueError("Canvas aspect ratio cannot be rendered safely")
    return (rw, rh), (pw, ph)


def prepare(
    image: Image.Image, resized: tuple[int, int], padded: tuple[int, int], *, mask: bool = False
) -> Image.Image:
    result = Image.new("RGBA", padded, (0, 0, 0, 255) if mask else (255, 255, 255, 255))
    result.paste(
        image.resize(resized, Image.Resampling.NEAREST if mask else Image.Resampling.LANCZOS),
        (0, 0),
    )
    return result


def composite(source: Image.Image, candidate: Image.Image, mask: Image.Image) -> Image.Image:
    if source.size != mask.size or candidate.size != source.size:
        raise ValueError("Source, mask, and candidate dimensions must match")
    region = mask.convert("L").point(lambda x: 255 if x >= 128 else 0)
    if not region.getbbox():
        raise ValueError("Select an editable area before generating")
    return Image.composite(candidate.convert("RGBA"), source.convert("RGBA"), region)


def focused_bounds(mask: Image.Image) -> tuple[int, int, int, int]:
    bounds = mask.convert("L").point(lambda x: 255 if x >= 128 else 0).getbbox()
    if not bounds:
        raise ValueError("Select an editable area before generating")
    left, top, right, bottom = bounds
    padding = max(32, round(max(right - left, bottom - top) * 0.75))
    return (max(0, left - padding), max(0, top - padding), min(mask.width, right + padding), min(mask.height, bottom + padding))


async def render_sketch(
    sketch: SketchInput, source_url: str | None, instruction: str, model: str, session_id: str
) -> tuple[images.GeneratedImage, int | None]:
    if model not in MODELS:
        raise ValueError("This model does not support Sketch")
    if sketch.workflow == "placement" and (
        sketch.kind != "edit" or not source_url or not sketch.subject or sketch.scope != "region"
    ):
        raise ValueError(
            "Object placement requires a source scene, object reference, and selected region"
        )
    if sketch.workflow == "viewpoint" and (
        sketch.kind != "edit" or not source_url or sketch.scope != "whole"
    ):
        raise ValueError("Alternate views require a source image and whole-image scope")
    guide = decode(sketch.guide)
    size = (sketch.width, sketch.height)
    if guide.size != size:
        raise ValueError("Drawing does not match the canvas dimensions")
    source = decode(source_url) if source_url else None
    if sketch.kind == "edit" and (source is None or source.size != size):
        raise ValueError("Source does not match the canvas dimensions")
    mask = (
        decode(sketch.mask)
        if sketch.kind == "edit" and sketch.scope == "region" and sketch.mask
        else None
    )
    if (
        sketch.kind == "edit"
        and sketch.scope == "region"
        and (
            mask is None
            or mask.size != size
            or not mask.convert("L").point(lambda x: 255 if x >= 128 else 0).getbbox()
        )
    ):
        raise ValueError("Select a valid editable region; whole-image fallback is disabled")
    original_source, original_mask = source, mask
    crop = None
    if sketch.focus_region:
        if source is None or mask is None or sketch.scope != "region":
            raise ValueError("Focused editing requires a protected source region")
        crop = focused_bounds(mask)
        source, guide, mask = source.crop(crop), guide.crop(crop), mask.crop(crop)
        size = source.size
    resized, padded = working_frame(size)
    refs = [prepare(source, resized, padded)] if source is not None else []
    refs.append(prepare(guide, resized, padded))
    if sketch.workflow == "placement" and sketch.subject:
        refs.append(decode(sketch.subject))
    if sketch.style:
        refs.append(decode(sketch.style))
    prompt = workflow_prompt(sketch, source is not None, instruction)
    if crop:
        prompt += (
            " The input images are a close-up crop of the full map. The drawn outlines "
            "are authoritative for placement in this crop; numerical percentages refer "
            "to the original full map, not this crop. Match the original ink and parchment."
        )
    from providers import mock

    request_id: str | None
    if mock.on():
        output = prepare(guide, resized, padded)
        request_id = "mock-sketch"
    else:
        images._ensure_fal_key()
        urls = [await to_fal_url(data_url(ref)) for ref in refs]
        args: dict = {"prompt": prompt, "image_urls": urls, "num_images": 1, "output_format": "png"}
        if model.startswith("openai/"):
            args.update(image_size={"width": padded[0], "height": padded[1]}, quality="high")
            if mask is not None:
                native_mask = prepare(mask, resized, padded, mask=True)
                alpha = ImageOps.invert(native_mask.convert("L"))
                native_mask.putalpha(alpha)
                args["mask_url"] = await to_fal_url(data_url(native_mask))
        else:
            args.update(aspect_ratio="auto", resolution="1K")
        budget = RenderBudget(session_id=session_id, limit=1, deadline=time.monotonic() + 720)
        result = await images._fal_subscribe(model, args, require_images=True, budget=budget)
        raw, _mime = await images._fetch_image_bytes(images._first_image(result))
        output = Image.open(io.BytesIO(raw)).convert("RGBA")
        request_id = str(result.get("requestId") or "") or None
    if abs(output.width / output.height / (padded[0] / padded[1]) - 1) > 0.025:
        raise ValueError("Model changed the aspect ratio; result cannot be aligned safely")
    output = (
        output.resize(padded, Image.Resampling.LANCZOS)
        .crop((0, 0, *resized))
        .resize(size, Image.Resampling.LANCZOS)
    )
    outside = None
    if source is not None and mask is not None:
        output = composite(source, output, mask)
        if crop and original_source is not None and original_mask is not None:
            full = original_source.copy()
            full.paste(output, crop[:2])
            output, source, mask = full, original_source, original_mask
        # The full-resolution check includes all RGBA channels, with no tolerance.
        difference = ImageChops.difference(source, output)
        inverse = ImageOps.invert(mask.convert("L").point(lambda x: 255 if x >= 128 else 0))
        channels = difference.split()
        nonzero = ImageChops.lighter(
            ImageChops.lighter(channels[0], channels[1]),
            ImageChops.lighter(channels[2], channels[3]),
        ).point(lambda x: 255 if x else 0)
        outside = ImageChops.multiply(nonzero, inverse).histogram()[255]
        if outside:
            raise ValueError("Protected pixels changed")
    return images.GeneratedImage(png(output), "image/png", model, request_id), outside
