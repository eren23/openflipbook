import base64
import io
import json
from unittest.mock import AsyncMock

import fal_client
import httpx
import pytest
from fastapi import HTTPException
from PIL import Image

from providers import illustration_generation as illustration

HTTPClient = httpx.AsyncClient


def png():
    output = io.BytesIO()
    Image.new("RGB", (64, 32), (100, 120, 140)).save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()


def body(**changes):
    return illustration.IllustrationInput(**{"prompt": "Hand inked stonework", "model": illustration.MODEL,
        "reservation": 0.1, "parameters": illustration.PARAMETERS,
        "inputs": {"image_url": png(), "control_lora_image_url": png(), "image_size": {"width": 64, "height": 32},
                   "scene_identity": {"version": "visible-object-identities-v1", "mode": "orbit", "floor_id": None,
                                      "omitted_visible_objects": 0, "objects": [{"id": "kettle", "label": "Copper Kettle", "kind": "building",
                                      "place_id": "district", "scene_revision": 4, "visible_pixels": 100,
                                      "center_percent": [20, 40], "bounds_percent": [10, 20, 30, 60], "dimensions_m": [10, 7.8, 12]}]}}, **changes})


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.delenv("MOCK_PROVIDERS", raising=False)
    for key in ["ILLUSTRATION_GENERATION_ENABLED", "SHARED_TOKEN", "FAL_KEY"]:
        monkeypatch.setenv(key, "1")
    monkeypatch.setenv("ILLUSTRATION_RESERVATION_USD", "0.1")


async def test_mock_mode_never_enables_paid_illustrations(monkeypatch, enabled):
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    assert illustration.configuration()["enabled"] is False
    with pytest.raises(HTTPException) as error:
        await illustration.submit(body())
    assert error.value.status_code == 503


@pytest.mark.parametrize("value", ["", "0", "-1", "nan", "inf", "11", "garbage"])
def test_requires_valid_explicit_reservation(monkeypatch, enabled, value):
    monkeypatch.setenv("ILLUSTRATION_RESERVATION_USD", value)
    assert illustration.configuration()["enabled"] is False


@pytest.mark.parametrize("key", ["ILLUSTRATION_GENERATION_ENABLED", "SHARED_TOKEN", "FAL_KEY"])
async def test_disabled_without_each_capability(monkeypatch, enabled, key):
    monkeypatch.delenv(key)
    assert illustration.configuration()["enabled"] is False
    with pytest.raises(HTTPException) as error:
        await illustration.submit(body())
    assert error.value.status_code == 503


@pytest.mark.parametrize("changes", [{"model": "other"}, {"reservation": 2}, {"parameters": {}}])
async def test_rejects_changed_configuration(enabled, changes):
    with pytest.raises(HTTPException) as error:
        await illustration.submit(body(**changes))
    assert error.value.status_code == 409


@pytest.mark.parametrize("code", [200, 307, 429, 500, 503, None])
async def test_single_transport_attempt_uses_saved_inputs(monkeypatch, enabled, code):
    calls = []
    def handler(request):
        calls.append(request)
        assert str(request.url) == f"https://queue.fal.run/{illustration.MODEL}"
        assert request.headers["X-Fal-No-Retry"] == "1"
        payload = json.loads(request.content)
        assert payload["image_url"] == png()
        assert payload["control_lora_image_url"] == png()
        assert payload["image_size"] == {"width": 64, "height": 32}
        assert payload["enable_safety_checker"] is True
        assert payload["num_images"] == 1
        assert payload["output_format"] == "jpeg"
        assert "prompt_version" not in payload
        assert "Hand inked stonework" in payload["prompt"]
        assert "Copper Kettle" in payload["prompt"]
        assert "visible-object-identities-v1" in payload["prompt"]
        assert "scene_identity" not in payload
        if code is None:
            raise httpx.ReadTimeout("Lost response", request=request)
        return httpx.Response(code, json={"request_id": "saved-id"}, headers={"location": "https://foreign.test"})
    def client(**kwargs):
        assert kwargs["follow_redirects"] is False
        return HTTPClient(transport=httpx.MockTransport(handler), follow_redirects=False)
    monkeypatch.setattr(illustration.httpx, "AsyncClient", client)
    if code == 200:
        assert (await illustration.submit(body()))["request_id"] == "saved-id"
    else:
        with pytest.raises((httpx.HTTPStatusError, httpx.ReadTimeout)):
            await illustration.submit(body())
    assert len(calls) == 1


@pytest.mark.parametrize("url", ["https://private.test/image.png", "data:image/png;base64,garbage", "data:image/jpeg;base64,YQ=="])
async def test_rejects_invalid_or_remote_conditioning_before_submission(enabled, url):
    request = body()
    request.inputs.image_url = url
    with pytest.raises(HTTPException) as error:
        await illustration.submit(request)
    assert error.value.status_code == 400


async def test_rejects_mismatched_conditioning_size(enabled):
    request = body()
    request.inputs.image_size.width = 128
    with pytest.raises(HTTPException) as error:
        await illustration.submit(request)
    assert error.value.status_code == 400


async def test_identity_contract_rejects_old_worker_before_provider(enabled):
    request = body()
    request.inputs.scene_identity = None
    with pytest.raises(HTTPException) as error:
        await illustration.submit(request)
    assert error.value.status_code == 400
    assert "upgrade" in error.value.detail


@pytest.mark.parametrize("region", [False, True])
async def test_previously_queued_legacy_jobs_keep_their_exact_prompt_contract(monkeypatch, edits_enabled, region):
    request = edit_body() if region else body()
    request.parameters = {**request.parameters, "prompt_version": "registered-object-inpaint-depth-v1" if region else "saved-camera-depth-v1"}
    request.inputs.scene_identity = None
    calls = []
    def handler(http_request):
        payload = json.loads(http_request.content)
        calls.append(payload)
        assert "scene_identity" not in payload and "Saved visible-object" not in payload["prompt"]
        assert payload["prompt"].endswith("Hand inked stonework")
        return httpx.Response(200, json={"request_id": "legacy-id"})
    monkeypatch.setattr(illustration.httpx, "AsyncClient", lambda **kwargs: HTTPClient(transport=httpx.MockTransport(handler)))
    assert (await illustration.submit(request))["request_id"] == "legacy-id"
    assert len(calls) == 1


@pytest.mark.parametrize("field,value", [
    ("center_percent", [99, 40]), ("bounds_percent", [-1, 20, 30, 60]),
    ("dimensions_m", [10, 0, 12]), ("visible_pixels", 9999),
])
async def test_invalid_identity_measurements_never_reach_provider(enabled, field, value):
    request = body()
    setattr(request.inputs.scene_identity.objects[0], field, value)
    with pytest.raises(HTTPException) as error:
        await illustration.submit(request)
    assert error.value.status_code == 400


async def test_recovers_saved_request_after_generation_disabled(monkeypatch, enabled):
    monkeypatch.setenv("ILLUSTRATION_GENERATION_ENABLED", "0")
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(return_value=fal_client.Completed(logs=None, metrics={})))
    monkeypatch.setattr(fal_client, "result_async", AsyncMock(return_value={"images": [{"url": "https://fal.media/view.jpg"}], "seed": 12}))
    assert (await illustration.status("saved-id"))["status"] == "ready"
    fal_client.status_async.assert_awaited_once_with(illustration.MODEL, "saved-id")


@pytest.mark.parametrize("result", [{"images": []}, {"images": [{"url": "x"}, {"url": "y"}]}, {"images": [{"url": "x"}], "has_nsfw_concepts": [True]}])
async def test_filtered_or_missing_results_are_terminal(monkeypatch, enabled, result):
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(return_value=fal_client.Completed(logs=None, metrics={})))
    monkeypatch.setattr(fal_client, "result_async", AsyncMock(return_value=result))
    assert (await illustration.status("saved-id"))["status"] == "failed"


def mask_url(color=None):
    image = Image.new("RGB", (64, 32), color or (0, 0, 0))
    if color is None:
        image.paste((255, 255, 255), (0, 0, 32, 32))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()


def edit_body():
    request = body(model=illustration.EDIT_MODEL, parameters=illustration.EDIT_PARAMETERS)
    request.inputs.mask_url = mask_url()
    return request


@pytest.fixture
def edits_enabled(monkeypatch, enabled):
    monkeypatch.setenv("ILLUSTRATION_EDIT_GENERATION_ENABLED", "1")
    monkeypatch.setenv("ILLUSTRATION_EDIT_RESERVATION_USD", "0.1")


async def test_region_generation_is_separately_opted_in(monkeypatch, enabled):
    assert (await illustration.region_capabilities())["enabled"] is False
    with pytest.raises(HTTPException) as error:
        await illustration.submit(edit_body())
    assert error.value.status_code == 503


async def test_mock_mode_also_disables_masked_work(monkeypatch, edits_enabled):
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    assert illustration.configuration(True)["enabled"] is False
    with pytest.raises(HTTPException):
        await illustration.submit(edit_body())


@pytest.mark.parametrize("code", [200, 307, 429, 500, None])
async def test_masked_submit_uses_pinned_depth_and_one_transport_attempt(monkeypatch, edits_enabled, code):
    calls = []
    def handler(request):
        calls.append(request)
        payload = json.loads(request.content)
        assert str(request.url) == f"https://queue.fal.run/{illustration.EDIT_MODEL}"
        assert payload["image_url"] == png()
        assert payload["mask_url"] == mask_url()
        assert payload["controlnets"] == [{**illustration.EDIT_PARAMETERS["depth_controlnet"], "control_image_url": png()}]
        assert "control_lora_image_url" not in payload and "depth_controlnet" not in payload
        assert "prompt_version" not in payload
        assert "white masked" in payload["prompt"] and "Hand inked stonework" in payload["prompt"]
        assert "Copper Kettle" in payload["prompt"] and "scene_identity" not in payload
        assert payload["enable_safety_checker"] and payload["output_format"] == "jpeg"
        assert request.headers["X-Fal-No-Retry"] == "1"
        if code is None:
            raise httpx.ReadTimeout("Lost response", request=request)
        return httpx.Response(code, json={"request_id": "edit-id"}, headers={"location": "https://foreign.test"})
    monkeypatch.setattr(illustration.httpx, "AsyncClient", lambda **kwargs: HTTPClient(transport=httpx.MockTransport(handler), follow_redirects=False))
    if code == 200:
        assert await illustration.submit(edit_body()) == {"request_id": "edit-id", "model": illustration.EDIT_MODEL}
    else:
        with pytest.raises((httpx.ReadTimeout, httpx.HTTPStatusError)):
            await illustration.submit(edit_body())
    assert len(calls) == 1


@pytest.mark.parametrize("mask", [None, "", "https://foreign.test/mask.png", mask_url((0, 0, 0)), mask_url((255, 255, 255)), mask_url((100, 100, 100))])
async def test_rejects_invalid_region_masks_before_generation(edits_enabled, mask):
    request = edit_body()
    request.inputs.mask_url = mask
    with pytest.raises(HTTPException) as error:
        await illustration.submit(request)
    assert error.value.status_code == 400


async def test_whole_view_route_cannot_silently_ignore_a_mask(enabled):
    request = body()
    request.inputs.mask_url = mask_url()
    with pytest.raises(HTTPException) as error:
        await illustration.submit(request)
    assert error.value.status_code == 400


async def test_recovers_masked_job_with_its_original_model_after_opt_out(monkeypatch, edits_enabled):
    monkeypatch.setenv("ILLUSTRATION_EDIT_GENERATION_ENABLED", "0")
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(return_value=fal_client.Completed(logs=None, metrics={})))
    monkeypatch.setattr(fal_client, "result_async", AsyncMock(return_value={"images": [{"url": "https://fal.media/edit.jpg"}]}))
    assert (await illustration.status("saved-edit", illustration.EDIT_MODEL))["status"] == "ready"
    fal_client.status_async.assert_awaited_once_with(illustration.EDIT_MODEL, "saved-edit")
    fal_client.result_async.assert_awaited_once_with(illustration.EDIT_MODEL, "saved-edit")
    with pytest.raises(HTTPException):
        await illustration.status("saved-edit", "unapproved-model")
