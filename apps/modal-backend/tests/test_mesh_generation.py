from unittest.mock import AsyncMock

import fal_client
import httpx
import pytest
from fastapi import HTTPException

from providers import mesh_generation as mesh

HTTPClient = httpx.AsyncClient


def image_input(width=64):
    import base64
    import io

    from PIL import Image
    output = io.BytesIO()
    Image.new("RGB", (width, 64), "green").save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()


@pytest.mark.asyncio
async def test_image_model_separate_opt_in_and_exact_private_payload(monkeypatch):
    import json
    for key in ["SHARED_TOKEN", "FAL_KEY", "MESH_GENERATION_ENABLED"]:
        monkeypatch.setenv(key, "1")
    monkeypatch.setenv("MESH_RESERVATION_USD", "2")
    monkeypatch.delenv("MESH_IMAGE_GENERATION_ENABLED", raising=False)
    assert (await mesh.image_capabilities())["enabled"] is False
    monkeypatch.setenv("MESH_IMAGE_GENERATION_ENABLED", "1")
    monkeypatch.setenv("MESH_IMAGE_RESERVATION_USD", "1")
    data = image_input()
    calls = []
    def handler(request):
        calls.append(request)
        assert str(request.url) == f"https://queue.fal.run/{mesh.IMAGE_MODEL}"
        assert json.loads(request.content) == {"input_image_url": data, **mesh.PARAMETERS}
        assert request.headers["X-Fal-No-Retry"] == "1"
        return httpx.Response(200, json={"request_id": "image-1"})
    mock_submit_transport(monkeypatch, handler)
    result = await mesh.submit(mesh.MeshInput(prompt="Display label only", model=mesh.IMAGE_MODEL, reservation=1, parameters=mesh.PARAMETERS, input_image_url=data))
    assert result == {"request_id": "image-1", "model": mesh.IMAGE_MODEL}
    assert len(calls) == 1


@pytest.mark.parametrize("value", [None, "https://private.example/image.png", "data:image/png;base64,broken", "data:image/png;base64,AAAA", image_input(16), image_input(2049)])
def test_image_input_rejects_urls_corruption_and_dimensions(value):
    with pytest.raises(HTTPException) as error:
        mesh.checked_image(value)
    assert error.value.status_code == 400


@pytest.mark.asyncio
async def test_image_status_uses_saved_model_after_disabling_new_work(monkeypatch):
    monkeypatch.setenv("SHARED_TOKEN", "configured")
    monkeypatch.setenv("FAL_KEY", "configured")
    monkeypatch.setenv("MESH_IMAGE_GENERATION_ENABLED", "0")
    state = AsyncMock(return_value=fal_client.Completed(logs=None, metrics={}))
    result = AsyncMock(return_value={"model_glb": {"url": "saved"}})
    monkeypatch.setattr(fal_client, "status_async", state)
    monkeypatch.setattr(fal_client, "result_async", result)
    assert (await mesh.status("image-1", mesh.IMAGE_MODEL))["status"] == "ready"
    state.assert_awaited_once_with(mesh.IMAGE_MODEL, "image-1")
    result.assert_awaited_once_with(mesh.IMAGE_MODEL, "image-1")
    with pytest.raises(HTTPException):
        await mesh.status("image-1", "unknown/model")


def mock_submit_transport(monkeypatch, handler):
    def client(**kwargs):
        assert kwargs["follow_redirects"] is False
        return HTTPClient(transport=httpx.MockTransport(handler), timeout=kwargs["timeout"], follow_redirects=False)
    monkeypatch.setattr(mesh.httpx, "AsyncClient", client)


def test_disabled_without_explicit_configuration(monkeypatch):
    for key in ["MESH_GENERATION_ENABLED", "SHARED_TOKEN", "FAL_KEY", "MESH_RESERVATION_USD"]:
        monkeypatch.delenv(key, raising=False)
    assert mesh.configuration()["enabled"] is False


@pytest.mark.parametrize("amount", ["nan", "inf", "-1", "0", "garbage", "11"])
def test_invalid_reservation_fails_closed(monkeypatch, amount):
    for key in ["MESH_GENERATION_ENABLED", "SHARED_TOKEN", "FAL_KEY"]:
        monkeypatch.setenv(key, "1")
    monkeypatch.setenv("MESH_RESERVATION_USD", amount)
    assert mesh.configuration()["enabled"] is False


@pytest.mark.asyncio
async def test_submit_is_one_real_provider_call(monkeypatch):
    for key in ["MESH_GENERATION_ENABLED", "SHARED_TOKEN", "FAL_KEY"]:
        monkeypatch.setenv(key, "1")
    monkeypatch.setenv("MESH_RESERVATION_USD", "2")
    calls = []
    def handler(request):
        import json
        calls.append(request)
        assert str(request.url) == f"https://queue.fal.run/{mesh.MODEL}"
        assert request.method == "POST"
        assert request.headers["Authorization"] == "Key 1"
        assert request.headers["X-Fal-No-Retry"] == "1"
        assert json.loads(request.content) == {"prompt": "A stone bakery", **mesh.PARAMETERS}
        return httpx.Response(200, json={"request_id": "request-1"})
    mock_submit_transport(monkeypatch, handler)
    result = await mesh.submit(mesh.MeshInput(prompt="A stone bakery"))
    assert result["request_id"] == "request-1"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_no_retry_on_ambiguous_submission(monkeypatch):
    monkeypatch.setattr(mesh, "configuration", lambda: {"enabled": True})
    monkeypatch.setenv("FAL_KEY", "fixture")
    calls = []
    def handler(request):
        calls.append(request)
        raise httpx.ReadTimeout("Lost acknowledgement", request=request)
    mock_submit_transport(monkeypatch, handler)
    with pytest.raises(httpx.ReadTimeout):
        await mesh.submit(mesh.MeshInput(prompt="A stone bakery"))
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("code", [307, 429, 500, 503])
async def test_submission_http_failures_do_not_retry_or_follow_redirects(monkeypatch, code):
    monkeypatch.setattr(mesh, "configuration", lambda: {"enabled": True})
    monkeypatch.setenv("FAL_KEY", "fixture")
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(code, headers={"location": "https://foreign.test/"})
    mock_submit_transport(monkeypatch, handler)
    with pytest.raises(httpx.HTTPStatusError):
        await mesh.submit(mesh.MeshInput(prompt="A stone bakery"))
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("change", [{"model": "different"}, {"reservation": 3}, {"parameters": {"face_count": 90000}}])
async def test_pinned_configuration_is_checked_before_submission(monkeypatch, change):
    monkeypatch.setattr(mesh, "configuration", lambda: {"enabled": True, "reservation": 2})
    with pytest.raises(HTTPException) as error:
        await mesh.submit(mesh.MeshInput(prompt="A stone bakery", **change))
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_status_never_submits_generation(monkeypatch):
    monkeypatch.setenv("SHARED_TOKEN", "configured")
    monkeypatch.setenv("FAL_KEY", "configured")
    submit = AsyncMock()
    monkeypatch.setattr(fal_client, "submit_async", submit)
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(return_value=fal_client.Queued(position=0)))
    assert await mesh.status("request-1") == {"status": "queued"}
    submit.assert_not_awaited()


@pytest.mark.asyncio
async def test_completed_failure_is_terminal(monkeypatch):
    monkeypatch.setenv("SHARED_TOKEN", "configured")
    monkeypatch.setenv("FAL_KEY", "configured")
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(return_value=fal_client.Completed(logs=None, metrics={}, error="generation failed")))
    result = AsyncMock()
    monkeypatch.setattr(fal_client, "result_async", result)
    assert (await mesh.status("request-1"))["status"] == "failed"
    result.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("code,terminal", [(422, True), (429, False), (503, False)])
async def test_result_rejection_vs_transient_error(monkeypatch, code, terminal):
    import httpx
    from fal_client.client import FalClientHTTPError
    monkeypatch.setenv("SHARED_TOKEN", "configured")
    monkeypatch.setenv("FAL_KEY", "configured")
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(return_value=fal_client.Completed(logs=None, metrics={})))
    error = FalClientHTTPError("failure", code, {}, httpx.Response(code))
    monkeypatch.setattr(fal_client, "result_async", AsyncMock(side_effect=error))
    if terminal:
        assert (await mesh.status("request-1"))["status"] == "failed"
    else:
        with pytest.raises(FalClientHTTPError):
            await mesh.status("request-1")
