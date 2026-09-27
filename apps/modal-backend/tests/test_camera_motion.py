import base64
import hashlib
import io
import json
from unittest.mock import AsyncMock

import fal_client
import httpx
import pytest
from fal_client.client import FalClientHTTPError
from fastapi import HTTPException
from PIL import Image
from pydantic import ValidationError

from providers import camera_motion as motion

HTTPClient = httpx.AsyncClient


def source(format="PNG"):
    output = io.BytesIO()
    Image.new("RGB", (64, 32), (70, 110, 150)).save(output, format=format)
    data = output.getvalue()
    return {
        "url": f"data:image/{'png' if format == 'PNG' else 'jpeg'};base64,"
        + base64.b64encode(data).decode(),
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
        "width": 64,
        "height": 32,
    }


def payload(**changes):
    return {
        "model": motion.MODEL,
        "adapter": motion.ADAPTER,
        "purpose": "calibration",
        "reservation": 0.48,
        "source": source(),
        "parameters": {
            "duration": 6,
            "resolution": "768P",
            "prompt_expansion_mode": "balanced",
            "enable_safety_checker": True,
            "sync_mode": False,
            "prompt": "Keep the place and its architecture unchanged. Only the camera moves. Preserve the landmark, doors, windows, materials and neighboring buildings.",
            "camera_trajectory": [
                {"time": 0, "azimuth": 0, "elevation": 0, "distance": 1},
                {"time": 1, "azimuth": -25, "elevation": 12, "distance": 0.8},
            ],
        },
        **changes,
    }


def body(**changes):
    return motion.MotionInput(**payload(**changes))


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.delenv("MOCK_PROVIDERS", raising=False)
    monkeypatch.setenv("MOTION_CALIBRATION_ENABLED", "1")
    monkeypatch.setenv("MOTION_RESERVATION_USD_PER_SECOND", "0.08")
    monkeypatch.setenv("SHARED_TOKEN", "test")
    monkeypatch.setenv("FAL_KEY", "test")


@pytest.mark.parametrize(
    "key",
    ["MOTION_CALIBRATION_ENABLED", "MOTION_RESERVATION_USD_PER_SECOND", "SHARED_TOKEN", "FAL_KEY"],
)
async def test_requires_explicit_configuration(enabled, monkeypatch, key):
    monkeypatch.delenv(key)
    assert (await motion.capabilities())["enabled"] is False
    with pytest.raises(HTTPException) as error:
        await motion.submit(body())
    assert error.value.status_code == 503


@pytest.mark.parametrize("value", ["", "0", "-1", "0.02", "nan", "inf", "0.51", "garbage"])
def test_reservation_cannot_use_expired_promotion_or_invalid_rates(enabled, monkeypatch, value):
    monkeypatch.setenv("MOTION_RESERVATION_USD_PER_SECOND", value)
    assert motion.configuration()["enabled"] is False


async def test_mock_mode_never_calls_paid_provider(enabled, monkeypatch):
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    monkeypatch.setattr(
        motion.httpx, "AsyncClient", lambda **kwargs: pytest.fail("Unexpected provider connection")
    )
    for call in (lambda: motion.submit(body()), lambda: motion.status("existing-id")):
        with pytest.raises(HTTPException) as error:
            await call()
        assert error.value.status_code == 503


@pytest.mark.parametrize(
    "changes",
    [
        {"model": "minimax/h3-max/image-to-video"},
        {"adapter": "wrong"},
        {"reservation": 0.12},
        {"reservation": 0.49},
    ],
)
async def test_rejects_changed_route_adapter_or_price(enabled, changes):
    with pytest.raises(HTTPException) as error:
        await motion.submit(body(**changes))
    assert error.value.status_code == 409


@pytest.mark.parametrize(
    "key,value",
    [
        ("duration", 6.5),
        ("duration", 4),
        ("duration", 16),
        ("duration", True),
        ("resolution", "1080P"),
        ("enable_safety_checker", False),
        ("sync_mode", True),
        ("prompt_expansion_mode", "quality"),
        ("prompt", "   "),
        ("end_image_url", "https://fal.media/end.png"),
        ("depth", "fake"),
        ("camera_trajectory", []),
    ],
)
def test_strict_supported_parameters(key, value):
    request = payload()
    request["parameters"][key] = value
    with pytest.raises(ValidationError):
        motion.MotionInput(**request)


@pytest.mark.parametrize(
    "change",
    [
        lambda p: p[0].update(time=0.1),
        lambda p: p[0].update(azimuth=20),
        lambda p: p[0].update(distance=2),
        lambda p: p[1].update(time=0.9),
        lambda p: p.insert(1, dict(p[0])),
        lambda p: p[1].update(distance=0),
        lambda p: p[1].update(elevation=91),
        lambda p: p[1].update(azimuth=float("nan")),
        lambda p: p[1].update(distance=float("inf")),
        lambda p: p[1].update(azimuth=32 * 360 + 1),
        lambda p: p[1].update(azimuth="25"),
    ],
)
def test_invalid_camera_paths_reject_before_transport(change):
    request = payload()
    change(request["parameters"]["camera_trajectory"])
    with pytest.raises(ValidationError):
        motion.MotionInput(**request)


def test_signed_full_turns_are_not_wrapped_or_clamped():
    request = payload()
    request["parameters"]["camera_trajectory"][1]["azimuth"] = -720
    assert motion.MotionInput(**request).parameters.camera_trajectory[1].azimuth == -720
    request["parameters"]["camera_trajectory"] = [
        request["parameters"]["camera_trajectory"][0],
        {"time": 0.5, "azimuth": 6000, "elevation": 0, "distance": 1},
        {"time": 1, "azimuth": 0, "elevation": 0, "distance": 1},
    ]
    with pytest.raises(ValidationError):
        motion.MotionInput(**request)


@pytest.mark.parametrize("code", [200, 307, 429, 500, 503, None])
async def test_only_one_post_with_exact_supported_inputs(enabled, monkeypatch, code):
    calls = []
    request_body = body()

    def handler(request):
        calls.append(request)
        assert str(request.url) == f"https://queue.fal.run/{motion.MODEL}"
        assert request.headers["X-Fal-No-Retry"] == "1"
        assert json.loads(request.content) == {
            **request_body.parameters.model_dump(),
            "image_url": request_body.source.url,
        }
        if code is None:
            raise httpx.ReadTimeout("Lost response", request=request)
        return httpx.Response(
            code, json={"request_id": "saved-id"}, headers={"location": "https://foreign.test"}
        )

    def client(**kwargs):
        assert kwargs["follow_redirects"] is False
        return HTTPClient(transport=httpx.MockTransport(handler), follow_redirects=False)

    monkeypatch.setattr(motion.httpx, "AsyncClient", client)
    if code == 200:
        assert await motion.submit(request_body) == {
            "request_id": "saved-id",
            "model": motion.MODEL,
        }
    else:
        with pytest.raises((httpx.HTTPStatusError, httpx.ReadTimeout)):
            await motion.submit(request_body)
    assert len(calls) == 1


@pytest.mark.parametrize(
    "change",
    [
        lambda s: s.update(url="https://private.test/source.png"),
        lambda s: s.update(sha256="0" * 64),
        lambda s: s.update(bytes=s["bytes"] + 1),
        lambda s: s.update(width=128),
        lambda s: s.update(url="data:image/png;base64,garbage"),
        lambda s: s.update(url=s["url"].replace("image/png", "image/jpeg")),
    ],
)
async def test_source_metadata_and_bytes_cannot_silently_change(enabled, monkeypatch, change):
    request = payload()
    change(request["source"])
    monkeypatch.setattr(
        motion.httpx, "AsyncClient", lambda **kwargs: pytest.fail("Unexpected provider connection")
    )
    with pytest.raises(HTTPException) as error:
        await motion.submit(motion.MotionInput(**request))
    assert error.value.status_code == 400


def test_accepts_owned_jpeg_source_without_reencoding():
    motion.validate_source(motion.SourceImage(**source("JPEG")))


async def test_recovers_existing_request_after_new_generation_disabled(enabled, monkeypatch):
    monkeypatch.setenv("MOTION_CALIBRATION_ENABLED", "0")
    monkeypatch.setenv("MOTION_RESERVATION_USD_PER_SECOND", "0")
    monkeypatch.setattr(
        fal_client,
        "status_async",
        AsyncMock(return_value=fal_client.Completed(logs=None, metrics={})),
    )
    monkeypatch.setattr(
        fal_client,
        "result_async",
        AsyncMock(
            return_value={
                "video": {"url": "https://v3b.fal.media/clip.mp4"},
                "expanded_prompt": "Only the camera moves",
            }
        ),
    )
    result = await motion.status("saved-id")
    assert result == {
        "status": "ready",
        "video": {"url": "https://v3b.fal.media/clip.mp4", "content_type": "video/mp4"},
        "expanded_prompt": "Only the camera moves",
        "audio_status": "unverified",
    }
    fal_client.status_async.assert_awaited_once_with(motion.MODEL, "saved-id")
    fal_client.result_async.assert_awaited_once_with(motion.MODEL, "saved-id")


@pytest.mark.parametrize("request_id", ["", "../bad", "a/b", "\u00e9", "x" * 101])
async def test_invalid_saved_ids_do_not_poll(enabled, monkeypatch, request_id):
    monkeypatch.setattr(fal_client, "status_async", AsyncMock())
    with pytest.raises(HTTPException) as error:
        await motion.status(request_id)
    assert error.value.status_code == 400
    fal_client.status_async.assert_not_awaited()


@pytest.mark.parametrize("result", [None, {}, {"video": {}}, {"video": {"url": None}}])
async def test_missing_video_is_failure_not_ready(enabled, monkeypatch, result):
    monkeypatch.setattr(
        fal_client,
        "status_async",
        AsyncMock(return_value=fal_client.Completed(logs=None, metrics={})),
    )
    monkeypatch.setattr(fal_client, "result_async", AsyncMock(return_value=result))
    assert await motion.status("saved-id") == {"status": "failed"}


@pytest.mark.parametrize(
    "url",
    [
        "http://fal.media/a.mp4",
        "https://fal.media.evil.test/a.mp4",
        "https://user@fal.media/a.mp4",
        "https://fal.media:8080/a.mp4",
    ],
)
async def test_rejects_unexpected_result_locations(enabled, monkeypatch, url):
    monkeypatch.setattr(
        fal_client,
        "status_async",
        AsyncMock(return_value=fal_client.Completed(logs=None, metrics={})),
    )
    monkeypatch.setattr(fal_client, "result_async", AsyncMock(return_value={"video": {"url": url}}))
    with pytest.raises(HTTPException) as error:
        await motion.status("saved-id")
    assert error.value.status_code == 502


@pytest.mark.parametrize(
    "state,expected",
    [
        (fal_client.Queued(position=0), "queued"),
        (fal_client.InProgress(logs=None), "running"),
        (fal_client.Completed(logs=None, metrics={}, error="Generation failed"), "failed"),
    ],
)
async def test_queue_and_failure_states_do_not_fetch_or_resubmit(
    enabled, monkeypatch, state, expected
):
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(return_value=state))
    monkeypatch.setattr(fal_client, "result_async", AsyncMock())
    assert await motion.status("saved-id") == {"status": expected}
    fal_client.result_async.assert_not_awaited()


@pytest.mark.parametrize("code", [422, 429, 503])
async def test_distinguishes_terminal_rejection_from_recoverable_result_outage(
    enabled, monkeypatch, code
):
    monkeypatch.setattr(
        fal_client,
        "status_async",
        AsyncMock(return_value=fal_client.Completed(logs=None, metrics={})),
    )
    monkeypatch.setattr(
        fal_client,
        "result_async",
        AsyncMock(side_effect=FalClientHTTPError("failure", code, {}, httpx.Response(code))),
    )
    if code == 422:
        assert await motion.status("saved-id") == {"status": "failed"}
    else:
        with pytest.raises(FalClientHTTPError):
            await motion.status("saved-id")


@pytest.mark.parametrize(
    "result",
    [
        {},
        {"request_id": "../bad"},
        {"request_id": "\u00e9"},
        {"request_id": "saved-id", "extra": "x" * 100_000},
    ],
)
async def test_bad_submission_receipt_is_ambiguous_and_never_reposted(enabled, monkeypatch, result):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=result)

    monkeypatch.setattr(
        motion.httpx,
        "AsyncClient",
        lambda **kwargs: HTTPClient(transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(HTTPException) as error:
        await motion.submit(body())
    assert error.value.status_code == 502
    assert len(calls) == 1


def test_rejects_source_that_would_be_auto_rotated():
    output = io.BytesIO()
    image = Image.new("RGB", (64, 32), (70, 110, 150))
    exif = Image.Exif()
    exif[274] = 6
    image.save(output, format="JPEG", exif=exif)
    data = output.getvalue()
    request = source("JPEG")
    request.update(
        url="data:image/jpeg;base64," + base64.b64encode(data).decode(),
        sha256=hashlib.sha256(data).hexdigest(),
        bytes=len(data),
    )
    with pytest.raises(HTTPException) as error:
        motion.validate_source(motion.SourceImage(**request))
    assert error.value.status_code == 400
