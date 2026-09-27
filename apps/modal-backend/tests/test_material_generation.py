import json
from unittest.mock import AsyncMock

import fal_client
import httpx
import pytest
from fastapi import HTTPException

from providers import material_generation as material

HTTPClient = httpx.AsyncClient


def body(**changes):
    return material.MaterialInput(**{"prompt": "Cool limestone blocks", "model": material.MODEL,
                                     "reservation": 0.1, "parameters": material.PARAMETERS, **changes})


@pytest.fixture
def enabled(monkeypatch):
    for key in ["MATERIAL_GENERATION_ENABLED", "SHARED_TOKEN", "FAL_KEY"]:
        monkeypatch.setenv(key, "1")
    monkeypatch.setenv("MATERIAL_RESERVATION_USD", "0.1")


@pytest.mark.parametrize("value", ["", "0", "-1", "nan", "inf", "11", "garbage"])
def test_configuration_requires_explicit_valid_reservation(monkeypatch, enabled, value):
    monkeypatch.setenv("MATERIAL_RESERVATION_USD", value)
    assert material.configuration()["enabled"] is False


@pytest.mark.parametrize("key", ["MATERIAL_GENERATION_ENABLED", "SHARED_TOKEN", "FAL_KEY"])
def test_configuration_requires_each_capability(monkeypatch, enabled, key):
    monkeypatch.delenv(key)
    assert material.configuration()["enabled"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("changes", [{"model": "other"}, {"reservation": 2}, {"parameters": {}}])
async def test_rejects_changed_pinned_configuration(enabled, changes):
    with pytest.raises(HTTPException) as error:
        await material.submit(body(**changes))
    assert error.value.status_code == 409


@pytest.mark.asyncio
@pytest.mark.parametrize("response_code", [200, 307, 429, 500, 503, None])
async def test_exactly_one_transport_attempt_with_safety_and_fixed_tile_settings(monkeypatch, enabled, response_code):
    calls = []
    def handler(request):
        calls.append(request)
        assert str(request.url) == f"https://queue.fal.run/{material.MODEL}"
        assert request.headers["X-Fal-No-Retry"] == "1"
        payload = json.loads(request.content)
        assert payload["prompt"] == material.tile_prompt("Cool limestone blocks")
        assert "prompt_version" not in payload
        assert payload["num_images"] == 1
        assert payload["output_format"] == "jpeg"
        assert payload["enable_safety_checker"] is True
        assert payload["sync_mode"] is False
        assert payload["image_size"] == {"width": 1024, "height": 1024}
        if response_code is None:
            raise httpx.ReadTimeout("Lost acknowledgement", request=request)
        return httpx.Response(response_code, json={"request_id": "saved-id"}, headers={"location": "https://foreign.test"})
    def client(**kwargs):
        assert kwargs["follow_redirects"] is False
        return HTTPClient(transport=httpx.MockTransport(handler), follow_redirects=False)
    monkeypatch.setattr(material.httpx, "AsyncClient", client)
    if response_code == 200:
        assert (await material.submit(body()))["request_id"] == "saved-id"
    else:
        with pytest.raises((httpx.HTTPStatusError, httpx.ReadTimeout)):
            await material.submit(body())
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_saved_request_can_be_read_after_new_generation_is_disabled(monkeypatch, enabled):
    monkeypatch.setenv("MATERIAL_GENERATION_ENABLED", "0")
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(return_value=fal_client.Completed(logs=None, metrics={})))
    monkeypatch.setattr(fal_client, "result_async", AsyncMock(return_value={"images": [{"url": "https://fal.media/tile.jpg"}], "seed": 42}))
    result = await material.status("saved-id")
    assert result == {"status": "ready", "image": {"url": "https://fal.media/tile.jpg"}, "seed": 42}
    fal_client.status_async.assert_awaited_once_with(material.MODEL, "saved-id")


@pytest.mark.asyncio
@pytest.mark.parametrize("result", [{"images": []}, {"images": [{"url": "x"}, {"url": "y"}]},
                                   {"images": [{"url": "x"}], "has_nsfw_concepts": [True]}])
async def test_incomplete_or_filtered_results_are_terminal(monkeypatch, enabled, result):
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(return_value=fal_client.Completed(logs=None, metrics={})))
    monkeypatch.setattr(fal_client, "result_async", AsyncMock(return_value=result))
    assert (await material.status("saved-id"))["status"] == "failed"
