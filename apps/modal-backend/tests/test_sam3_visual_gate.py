"""Offline visual-prompt contract: canonical inputs, one POST, honest full output."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
from unittest.mock import AsyncMock

import fal_client
import httpx
import pytest
from fastapi import HTTPException
from PIL import Image
from pydantic import ValidationError

from providers import illustration_generation as illustration
from providers import segmenter

SUBJECT = (1, 153, 25)
OTHERS = [(3, 50, 50), (4, 203, 75), (6, 100, 100)]
ROAD = (7, 253, 125)
BOX = (0, 0, 160, 280)
SIZE = (688, 384)


def objects(*, thin_road: bool = False) -> bytes:
    image = Image.new("RGB", SIZE, (0, 0, 0))
    for rgb, rectangle in zip([SUBJECT, *OTHERS], [BOX, (250, 80, 290, 220),
                                                 (360, 90, 400, 210), (540, 60, 610, 180)], strict=True):
        image.paste(rgb, rectangle)
    image.paste(ROAD, (0, 370 if thin_road else 300, 688, 378 if thin_road else 384))
    output = io.BytesIO()
    image.save(output, "PNG")
    return output.getvalue()


def encoded(image: Image.Image, format: str = "PNG") -> bytes:
    output = io.BytesIO()
    image.save(output, format)
    return output.getvalue()


def jpeg(color: tuple[int, int, int] = (85, 90, 95)) -> bytes:
    return encoded(Image.new("RGB", SIZE, color), "JPEG")


def data_url(data: bytes, kind: str) -> str:
    return f"data:image/{kind};base64," + base64.b64encode(data).decode()


def body(**changes: object) -> illustration.GateInput:
    return illustration.GateInput(**{
        "image_urls": [data_url(jpeg(), "jpeg")], "box": BOX, "width": 688, "height": 384,
        "label": "building", "segmentation_profile": segmenter.SAM3_VISUAL_PROFILE,
        "visual_geometry": {"objects_data_url": data_url(objects(), "png"), "subject_rgb": SUBJECT,
                            "other_building_rgbs": OTHERS, "road_rgb": ROAD}, **changes,
    })


@pytest.fixture
def available(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MOCK_PROVIDERS", "0")
    monkeypatch.setenv("SHARED_TOKEN", "test-token")
    monkeypatch.setenv("FAL_KEY", "test-key")
    monkeypatch.delenv("FAL_SAM_MODEL", raising=False)


def test_points_use_actual_safe_canonical_pixels_and_known_road() -> None:
    raw = objects()
    prompts = segmenter.sam3_visual_prompts(raw, BOX, SUBJECT, OTHERS, ROAD)
    assert prompts == segmenter.sam3_visual_prompts(raw, BOX, SUBJECT, OTHERS, ROAD)
    assert prompts["box_prompts"] == [{"x_min": 0, "y_min": 0, "x_max": 160, "y_max": 280, "object_id": 1}]
    assert prompts["proof"]["objects_sha256"] == hashlib.sha256(raw).hexdigest()
    source = Image.open(io.BytesIO(raw))
    positive = [p for p in prompts["point_prompts"] if p["label"] == 1]
    negative = [p for p in prompts["point_prompts"] if p["label"] == 0]
    assert len(positive) == 2 and positive[0]["y"] < 140 <= positive[1]["y"]
    assert len(negative) == 4
    assert {source.getpixel((p["x"], p["y"])) for p in negative} == {*OTHERS, ROAD}
    for point in prompts["point_prompts"]:
        x, y = point["x"], point["y"]
        assert point["object_id"] == 1 and 8 <= x < 680 and 8 <= y < 376
        color = source.getpixel((x, y))
        assert (color == SUBJECT) == (point["label"] == 1)
        # Independent neighborhood check rejects unsafe boundaries and frame edges.
        neighborhood = source.crop((x - 8, y - 8, x + 9, y + 9)).tobytes()
        assert {tuple(neighborhood[n:n + 3]) for n in range(0, len(neighborhood), 3)} == {color}
    road_point = next(p for p in negative if source.getpixel((p["x"], p["y"])) == ROAD)
    assert road_point["y"] >= 308


def test_no_safe_road_or_occluded_building_skips_negative_instead_of_using_sky() -> None:
    image = Image.open(io.BytesIO(objects(thin_road=True)))
    image.paste((0, 0, 0), (250, 80, 290, 220))
    prompts = segmenter.sam3_visual_prompts(encoded(image), BOX, SUBJECT, OTHERS, ROAD)
    negative_colors = [image.getpixel((p["x"], p["y"])) for p in prompts["point_prompts"] if p["label"] == 0]
    assert negative_colors == OTHERS[1:]


@pytest.mark.parametrize("change", ["wrong_size", "transparent", "wrong_format", "bbox", "duplicate_rgb",
                                   "zero_rgb", "thin_subject", "float_box", "missing_building", "oversized"])
def test_invalid_geometry_fails_before_any_provider(change: str) -> None:
    raw, box, subject, others, road = objects(), BOX, SUBJECT, OTHERS, ROAD
    if change == "wrong_size":
        raw = encoded(Image.new("RGB", (688, 383), SUBJECT))
    elif change == "transparent":
        image = Image.open(io.BytesIO(raw)).convert("RGBA")
        image.putpixel((0, 0), (*SUBJECT, 0))
        raw = encoded(image)
    elif change == "wrong_format":
        raw = jpeg()
    elif change == "bbox":
        box = (1, 0, 160, 280)
    elif change == "duplicate_rgb":
        road = SUBJECT
    elif change == "zero_rgb":
        subject = (0, 0, 0)
    elif change == "thin_subject":
        image = Image.new("RGB", SIZE, ROAD)
        image.paste(SUBJECT, (0, 0, 8, 280))
        raw, box = encoded(image), (0, 0, 8, 280)
    elif change == "float_box":
        box = (0.5, 0, 160, 280)
    elif change == "missing_building":
        others = OTHERS[:2]
    else:
        raw = b"x" * (segmenter.SAM3_VISUAL_OBJECTS_MAX_BYTES + 1)
    with pytest.raises((ValueError, OSError)):
        segmenter.sam3_visual_prompts(raw, box, subject, others, road)


@pytest.mark.parametrize("found", [True, False])
async def test_visual_full_frame_posts_exact_jpeg_once_and_keeps_overflow(
    monkeypatch: pytest.MonkeyPatch, available: None, found: bool,
) -> None:
    original, canonical = jpeg(), objects()
    posts: list[httpx.Request] = []
    configs: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        posts.append(request)
        assert str(request.url) == "https://queue.fal.run/fal-ai/sam-3/image"
        assert request.headers["X-Fal-No-Retry"] == "1"
        payload = json.loads(request.content)
        assert base64.b64decode(payload["image_url"].split(",", 1)[1]) == original
        assert payload["prompt"] == "" and payload["return_multiple_masks"] is False
        assert payload["apply_mask"] is False and payload["include_boxes"] is True
        assert payload["max_masks"] == 1 and payload["include_scores"] is True
        expected = segmenter.sam3_visual_prompts(canonical, BOX, SUBJECT, OTHERS, ROAD)
        assert payload["point_prompts"] == expected["point_prompts"]
        assert payload["box_prompts"] == expected["box_prompts"]
        return httpx.Response(200, json={"request_id": "sam-visual-id"})

    output_mask = Image.new("L", SIZE, 0)
    output_mask.putpixel((650, 10), 255)  # outside the truth and prompt box: must survive
    output_mask.putpixel((651, 10), 127)
    output_mask.putpixel((652, 10), 128)
    monkeypatch.setattr("providers.image._fetch_url_bytes", AsyncMock(return_value=(encoded(output_mask), "image/png")))
    real = httpx.AsyncClient

    def client(**kwargs: object) -> httpx.AsyncClient:
        configs.append(kwargs)
        return real(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(segmenter.httpx, "AsyncClient", client)
    result = {"masks": [{"url": "https://v3.fal.media/files/visual.png"}], "scores": [0.84]} if found else {"masks": []}
    poll = AsyncMock(return_value=result)
    monkeypatch.setattr(fal_client, "result_async", poll)
    measured = await segmenter.sam3_visual_full_frame_mask(original, canonical, BOX, SUBJECT, OTHERS, ROAD)
    assert len(posts) == 1 and len(configs) == 1 and configs[0]["follow_redirects"] is False
    transport = configs[0]["transport"]
    assert transport._pool._retries == 0
    poll.assert_awaited_once_with("fal-ai/sam-3/image", "sam-visual-id")
    assert measured["request_id"] == "sam-visual-id"
    assert measured["visual_prompt_proof"]["image_sha256"] == hashlib.sha256(original).hexdigest()
    if found:
        assert measured["mask"].size == SIZE and measured["mask"].mode == "1"
        assert measured["mask"].getbbox() == (650, 10, 653, 11)
        assert measured["mask"].getpixel((651, 10)) == 0
    else:
        assert measured["mask"] is None and measured["score"] is None


@pytest.mark.parametrize("where", ["submit", "result", "download", "cancel"])
async def test_visual_failures_never_post_again_and_preserve_known_request(
    monkeypatch: pytest.MonkeyPatch, available: None, where: str,
) -> None:
    posts: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        posts.append(request)
        if where == "submit":
            raise httpx.ReadTimeout("ack lost")
        return httpx.Response(200, json={"request_id": "known-visual-id"})

    monkeypatch.setattr("providers.image._fetch_url_bytes", AsyncMock(side_effect=httpx.ReadTimeout("download")))
    real = httpx.AsyncClient
    monkeypatch.setattr(segmenter.httpx, "AsyncClient", lambda **kwargs: real(transport=httpx.MockTransport(handler)))
    poll = AsyncMock(side_effect=(asyncio.CancelledError() if where == "cancel" else httpx.ReadTimeout("poll")))
    if where == "download":
        poll = AsyncMock(return_value={"masks": [{"url": "https://v3.fal.media/files/mask.png"}]})
    monkeypatch.setattr(fal_client, "result_async", poll)
    with pytest.raises(httpx.ReadTimeout if where == "submit" else segmenter.Sam3VisualPromptError) as failed:
        await segmenter.sam3_visual_full_frame_mask(jpeg(), objects(), BOX, SUBJECT, OTHERS, ROAD)
    assert len(posts) == 1
    if where == "submit":
        poll.assert_not_awaited()
    else:
        assert failed.value.request_id == "known-visual-id"
        assert failed.value.proof["objects_sha256"] == hashlib.sha256(objects()).hexdigest()


async def test_gate_optin_measures_exact_bytes_and_emits_profile_receipt(
    monkeypatch: pytest.MonkeyPatch, available: None,
) -> None:
    legacy = AsyncMock(side_effect=AssertionError("legacy crop invoked"))
    visual = AsyncMock(return_value={"mask": None, "request_id": "visual-none", "score": None,
                                    "visual_prompt_proof": {"version": segmenter.SAM3_VISUAL_PROFILE}})
    monkeypatch.setattr(segmenter, "sam3_box_mask", legacy)
    monkeypatch.setattr(segmenter, "sam3_visual_full_frame_mask", visual)
    result = await illustration.gate(body())
    assert result == {"masks": [{"mask_png": None, "request_id": "visual-none", "score": None,
                                 "visual_prompt_proof": {"version": segmenter.SAM3_VISUAL_PROFILE}}],
                      "segmentation_profile": segmenter.SAM3_VISUAL_PROFILE}
    visual.assert_awaited_once_with(jpeg(), objects(), BOX, SUBJECT, OTHERS, ROAD)
    legacy.assert_not_awaited()


@pytest.mark.parametrize("change", ["no_profile", "no_geometry", "remote_image", "two_images", "bad_pass",
                                   "wrong_box", "foreign_model", "oversized_jpeg"])
async def test_gate_rejects_invalid_visual_profile_before_any_sam(
    monkeypatch: pytest.MonkeyPatch, available: None, change: str,
) -> None:
    request = body()
    if change == "no_profile":
        request.segmentation_profile = None
    elif change == "no_geometry":
        request.visual_geometry = None
    elif change == "remote_image":
        request.image_urls = ["https://v3.fal.media/files/unknown.jpg"]
    elif change == "two_images":
        request.image_urls *= 2
    elif change == "bad_pass":
        request.visual_geometry.objects_data_url = "data:image/png;base64,broken"
    elif change == "wrong_box":
        request.box = (1, 0, 160, 280)
    elif change == "foreign_model":
        monkeypatch.setenv("FAL_SAM_MODEL", "fal-ai/sam-3/other")
    else:
        # Valid JPEG with trailing bytes still exceeds the profile byte cap.
        raw = jpeg() + b"x" * segmenter.SAM3_VISUAL_IMAGE_MAX_BYTES
        request.image_urls = [data_url(raw, "jpeg")]
    visual, legacy = AsyncMock(), AsyncMock()
    monkeypatch.setattr(segmenter, "sam3_visual_full_frame_mask", visual)
    monkeypatch.setattr(segmenter, "sam3_box_mask", legacy)
    with pytest.raises(HTTPException) as failed:
        await illustration.gate(request)
    assert failed.value.status_code == 400
    visual.assert_not_awaited()
    legacy.assert_not_awaited()


@pytest.mark.parametrize("changes", [{"segmentation_profile": "invented-profile"},
                                    {"box": [0.0, 0, 160, 280]}, {"box": [False, 0, 160, 280]},
                                    {"visual_geometry": {"client_points": []}},
                                    {"visual_geometry": {"objects_data_url": "x", "subject_rgb": [True, 1, 2],
                                                         "other_building_rgbs": OTHERS, "road_rgb": ROAD}}])
def test_visual_profile_schema_is_bounded_and_has_no_custom_point_override(changes: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        body(**changes)


async def test_gate_preserves_acknowledged_failure_id_in_502(
    monkeypatch: pytest.MonkeyPatch, available: None,
) -> None:
    error = segmenter.Sam3VisualPromptError("known-id", {"objects_sha256": "bound-pass"})
    monkeypatch.setattr(segmenter, "sam3_visual_full_frame_mask", AsyncMock(side_effect=error))
    with pytest.raises(HTTPException) as failed:
        await illustration.gate(body())
    assert failed.value.status_code == 502
    assert failed.value.detail == {"message": "Acknowledged visual segmenter failed", "request_id": "known-id",
                                  "segmentation_profile": segmenter.SAM3_VISUAL_PROFILE,
                                  "visual_prompt_proof": {"objects_sha256": "bound-pass"}}
