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
    monkeypatch.delenv("ILLUSTRATION_KEYFRAME_MODEL", raising=False)
    monkeypatch.delenv("ILLUSTRATION_KEYFRAME_NANO_GUIDES_ENABLED", raising=False)
    monkeypatch.delenv("ILLUSTRATION_KEYFRAME_FLUX_BALANCED_ENABLED", raising=False)
    for key in ["ILLUSTRATION_GENERATION_ENABLED", "SHARED_TOKEN", "FAL_KEY"]:
        monkeypatch.setenv(key, "1")
    monkeypatch.setenv("ILLUSTRATION_RESERVATION_USD", "0.1")


def sized_png(size=(688, 384), color=(100, 120, 140)):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, format="PNG")
    return output.getvalue()


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


# --- qwen keyframe option + SAM-3 gate --------------------------------------


def nano_body(landmarks=True, **changes):
    request = keyframe_body(**{"model": illustration.NANO_KEYFRAME_MODEL, "reservation": 0.30,
                               "parameters": illustration.NANO_KEYFRAME_PARAMETERS, **changes})
    request.inputs.image_url = "data:image/png;base64," + base64.b64encode(sized_png()).decode()
    request.inputs.image_size = illustration.ImageSize(width=688, height=384)
    request.inputs.scene_identity.mode = "walk"
    request.inputs.reference_kind = "source-art-map-landmarks-v1"
    labels = ["Mossbound Bookshop", "Glassroot Inn", "Lantern Forge", "Tideglass Conservatory"]
    obj = request.inputs.scene_identity.objects[0]
    request.inputs.scene_identity.objects = [obj.model_copy(update={"id": str(i), "label": label}) for i, label in enumerate(labels)]
    if landmarks:
        request.inputs.landmark_labels = labels
        request.inputs.landmark_urls = ["data:image/png;base64," + base64.b64encode(sized_png((64, 32), (20 * i, 90, 130))).decode() for i in range(4)]
    return request


@pytest.fixture
def nano_enabled(monkeypatch, keyframes_enabled):
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_MODEL", illustration.NANO_KEYFRAME_MODEL)
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_RESERVATION_USD", "0.30")


async def test_nano_is_explicit_opt_in_and_keeps_qwen_default(monkeypatch, keyframes_enabled):
    assert (await illustration.keyframe_capabilities())["model"] == illustration.KEYFRAME_MODEL
    with pytest.raises(HTTPException) as error:
        await illustration.submit(nano_body())
    assert error.value.status_code == 409
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_MODEL", "unapproved-model")
    assert (await illustration.keyframe_capabilities())["enabled"] is False


@pytest.mark.parametrize("reservation", ["0.10", "0.29", "nan", "inf"])
async def test_nano_reservation_floor_fails_before_upload(monkeypatch, nano_enabled, uploads, reservation):
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_RESERVATION_USD", reservation)
    assert (await illustration.keyframe_capabilities())["enabled"] is False
    with pytest.raises(HTTPException) as error:
        await illustration.submit(nano_body())
    assert error.value.status_code == 503
    assert uploads == []


async def test_nano_capability_pins_single_image_and_exact_normalization(nano_enabled):
    config = await illustration.keyframe_capabilities()
    assert config == {"enabled": True, "model": illustration.NANO_KEYFRAME_MODEL, "reservation": .30,
                      "parameters": illustration.NANO_KEYFRAME_PARAMETERS, "reason": None}
    assert config["parameters"]["num_images"] == 1
    assert config["parameters"]["normalization"] == {"version": "nano-1k-half-size-v1", "raw_width": 1376,
        "raw_height": 768, "width": 688, "height": 384, "operation": "uniform-scale", "scale": .5,
        "crop": False, "stretch": False}
    assert config["parameters"]["gate"] == illustration.KEYFRAME_PARAMETERS["gate"]


@pytest.mark.parametrize("code", [200, 302, 503, "timeout"])
async def test_nano_uses_ordered_bound_references_and_one_paid_post(monkeypatch, nano_enabled, uploads, code):
    calls = []
    def handler(request):
        calls.append(request)
        assert str(request.url) == f"https://queue.fal.run/{illustration.NANO_KEYFRAME_MODEL}"
        assert request.headers["X-Fal-No-Retry"] == "1"
        payload = json.loads(request.content)
        assert payload["image_urls"] == [f"https://v3.fal.media/files/{i}.png" for i in range(1, 7)]
        assert payload["num_images"] == 1 and payload["resolution"] == "1K" and payload["aspect_ratio"] == "16:9"
        assert payload["output_format"] == "png" and payload["limit_generations"] is True
        assert payload["enable_web_search"] is False
        assert not {"image_size", "negative_prompt", "sync_mode", "prompt_version", "gate", "normalization",
                    "landmark_urls", "landmark_labels", "reference_kind", "scene_identity"} & set(payload)
        assert "Image 2 is the original saved world map" in payload["prompt"]
        assert "exact eye-level saved walk-camera render" in payload["prompt"]
        assert "Image 3 is the source-map crop of Mossbound Bookshop" in payload["prompt"]
        assert "Image 4 is the source-map crop of Glassroot Inn" in payload["prompt"]
        assert "Image 5 is the source-map crop of Lantern Forge" in payload["prompt"]
        assert "Image 6 is the source-map crop of Tideglass Conservatory" in payload["prompt"]
        assert "do not swap an inn with a forge" in payload["prompt"]
        if code == "timeout":
            raise httpx.ReadTimeout("Lost response", request=request)
        return httpx.Response(code, json={"request_id": "nano-id"}, headers={"location": "https://foreign.test"})
    provider(monkeypatch, handler)
    request = nano_body()
    if code == 200:
        assert await illustration.submit(request) == {"request_id": "nano-id", "model": illustration.NANO_KEYFRAME_MODEL}
    else:
        with pytest.raises((httpx.HTTPStatusError, httpx.ReadTimeout)):
            await illustration.submit(request)
    assert uploads == [request.inputs.image_url, request.inputs.reference_url, *request.inputs.landmark_urls]
    assert len(calls) == 1


async def test_nano_requires_all_named_crops_before_upload_or_submit(monkeypatch, nano_enabled, uploads):
    provider(monkeypatch, lambda request: pytest.fail("Missing landmark crops reached the paid queue"))
    with pytest.raises(HTTPException, match="Four landmark crop images") as error:
        await illustration.submit(nano_body(landmarks=False))
    assert error.value.status_code == 400
    assert uploads == []


def nano_guides_body():
    request = nano_body(parameters=illustration.NANO_GUIDES_KEYFRAME_PARAMETERS)
    request.inputs.structural_guide_url = "data:image/png;base64," + base64.b64encode(sized_png(color=(90, 120, 70))).decode()
    request.inputs.depth_guide_url = "data:image/png;base64," + base64.b64encode(sized_png(color=(160, 160, 160))).decode()
    return request


@pytest.fixture
def nano_guides_enabled(monkeypatch, nano_enabled):
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_NANO_GUIDES_ENABLED", "1")


async def test_nano_guides_are_a_pinned_opt_in_without_changing_qwen(monkeypatch, nano_guides_enabled):
    config = await illustration.keyframe_capabilities()
    assert config["parameters"] == illustration.NANO_GUIDES_KEYFRAME_PARAMETERS
    assert config["model"] == illustration.NANO_KEYFRAME_MODEL and config["reservation"] == .30
    assert config["parameters"]["prompt_version"] == "saved-camera-nano-landmarks-guides-v2"
    assert config["parameters"]["structural_guidance"] == "saved-camera-guides-v1"
    assert config["parameters"]["normalization"] == illustration.NANO_NORMALIZATION
    assert config["parameters"]["gate"] == illustration.KEYFRAME_PARAMETERS["gate"]
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_MODEL", illustration.KEYFRAME_MODEL)
    assert (await illustration.keyframe_capabilities())["parameters"] == illustration.KEYFRAME_PARAMETERS


@pytest.mark.parametrize("code", [200, 503, "timeout"])
async def test_nano_guides_append_exact_registered_images_with_one_post(monkeypatch, nano_guides_enabled, uploads, code):
    calls = []
    def handler(request):
        calls.append(request)
        payload = json.loads(request.content)
        assert payload["image_urls"] == [f"https://v3.fal.media/files/{i}.png" for i in range(1, 9)]
        assert "Image 7 is the registered image-1 object-contour guide" in payload["prompt"]
        assert "1: Mossbound Bookshop (source crop image 3)" in payload["prompt"]
        assert "2: Glassroot Inn (source crop image 4)" in payload["prompt"]
        assert "3: Lantern Forge (source crop image 5)" in payload["prompt"]
        assert "4: Tideglass Conservatory (source crop image 6)" in payload["prompt"]
        assert "Image 8 is the same camera's saved depth guide" in payload["prompt"]
        assert "not authorize a new composition" in payload["prompt"]
        assert not {"structural_guidance", "structural_guide_url", "depth_guide_url", "controlnets", "control_lora_image_url",
                    "image_size", "negative_prompt", "sync_mode", "prompt_version", "normalization", "gate"} & set(payload)
        assert payload["num_images"] == 1 and payload["aspect_ratio"] == "16:9" and payload["resolution"] == "1K"
        assert request.headers["X-Fal-No-Retry"] == "1"
        if code == "timeout":
            raise httpx.ReadTimeout("Lost response", request=request)
        return httpx.Response(code, json={"request_id": "nano-guide-id"})
    provider(monkeypatch, handler)
    request = nano_guides_body()
    if code == 200:
        assert await illustration.submit(request) == {"request_id": "nano-guide-id", "model": illustration.NANO_KEYFRAME_MODEL}
    else:
        with pytest.raises((httpx.HTTPStatusError, httpx.ReadTimeout)):
            await illustration.submit(request)
    assert uploads == [request.inputs.image_url, request.inputs.reference_url, *request.inputs.landmark_urls,
                       request.inputs.structural_guide_url, request.inputs.depth_guide_url]
    assert len(calls) == 1


@pytest.mark.parametrize("field", ["structural_guide_url", "depth_guide_url"])
@pytest.mark.parametrize("invalid", ["missing", "remote", "jpeg", "corrupt", "wrong_size", "rotated"])
async def test_nano_guides_reject_each_invalid_reference_before_upload(monkeypatch, nano_guides_enabled, uploads, field, invalid):
    request = nano_guides_body()
    values = {"missing": None, "remote": "https://v3.fal.media/files/guide.png", "jpeg": jpeg(),
              "corrupt": "data:image/png;base64,broken",
              "wrong_size": "data:image/png;base64," + base64.b64encode(sized_png((1376, 768))).decode()}
    if invalid == "rotated":
        output = io.BytesIO()
        exif = Image.Exif()
        exif[274] = 6
        Image.new("RGB", (688, 384)).save(output, format="PNG", exif=exif)
        value = "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()
    else:
        value = values[invalid]
    setattr(request.inputs, field, value)
    provider(monkeypatch, lambda request: pytest.fail("Invalid guide reached the paid queue"))
    with pytest.raises(HTTPException) as error:
        await illustration.submit(request)
    assert error.value.status_code == 400
    assert uploads == []


async def test_nano_guides_missing_both_cannot_fallback(monkeypatch, nano_guides_enabled, uploads):
    request = nano_body(parameters=illustration.NANO_GUIDES_KEYFRAME_PARAMETERS)
    provider(monkeypatch, lambda request: pytest.fail("Missing guides reached the paid queue"))
    with pytest.raises(HTTPException, match="require both") as error:
        await illustration.submit(request)
    assert error.value.status_code == 400
    assert uploads == []


async def test_nano_guides_require_the_exact_current_quote(nano_guides_enabled, uploads):
    with pytest.raises(HTTPException) as error:
        await illustration.submit(nano_body())
    assert error.value.status_code == 409
    assert uploads == []


@pytest.mark.parametrize("profile", ["qwen", "nano_v1", "depth"])
async def test_older_profiles_never_ignore_structural_guides(monkeypatch, nano_enabled, uploads, profile):
    request = nano_body() if profile == "nano_v1" else keyframe_body() if profile == "qwen" else body()
    if profile == "qwen":
        monkeypatch.setenv("ILLUSTRATION_KEYFRAME_MODEL", illustration.KEYFRAME_MODEL)
        monkeypatch.setenv("ILLUSTRATION_KEYFRAME_RESERVATION_USD", "0.10")
    request.inputs.structural_guide_url = "data:image/png;base64," + base64.b64encode(sized_png()).decode()
    request.inputs.depth_guide_url = request.inputs.structural_guide_url
    provider(monkeypatch, lambda request: pytest.fail("Unquoted guides reached the paid queue"))
    with pytest.raises(HTTPException) as error:
        await illustration.submit(request)
    assert error.value.status_code == 400
    assert uploads == []


@pytest.mark.parametrize("change", ["missing_map", "material_kind", "jpeg_map", "wrong_render_size", "wrong_capture_size",
    "missing_labels", "missing_crops", "duplicate_labels", "unknown_label", "three_crops", "three_labels",
    "jpeg_crop", "tiny_crop", "oversize_map", "broken_png", "qwen_model"])
async def test_nano_invalid_inputs_never_upload_or_submit(monkeypatch, nano_enabled, uploads, change):
    request = nano_body()
    if change == "missing_map":
        request.inputs.reference_url = None
    elif change == "material_kind":
        request.inputs.reference_kind = "source-art-material-crops-v1"
    elif change == "jpeg_map":
        request.inputs.reference_url = jpeg()
    elif change == "wrong_render_size":
        request.inputs.image_url = png()
    elif change == "wrong_capture_size":
        request.inputs.image_size.width = 687
    elif change == "missing_labels":
        request.inputs.landmark_labels = None
    elif change == "missing_crops":
        request.inputs.landmark_urls = None
    elif change == "duplicate_labels":
        request.inputs.landmark_labels[1] = request.inputs.landmark_labels[0]
    elif change == "unknown_label":
        request.inputs.landmark_labels[1] = "Invented Landmark"
    elif change == "three_crops":
        request.inputs.landmark_urls.pop()
    elif change == "three_labels":
        request.inputs.landmark_labels.pop()
    elif change == "jpeg_crop":
        request.inputs.landmark_urls[0] = jpeg()
    elif change == "tiny_crop":
        request.inputs.landmark_urls[0] = "data:image/png;base64," + base64.b64encode(sized_png((8, 32))).decode()
    elif change == "oversize_map":
        request.inputs.reference_url = "data:image/png;base64," + base64.b64encode(sized_png((4097, 32))).decode()
    elif change == "broken_png":
        request.inputs.landmark_urls[0] = "data:image/png;base64,broken"
    elif change == "qwen_model":
        request.model = illustration.KEYFRAME_MODEL
    provider(monkeypatch, lambda request: pytest.fail("provider called"))
    with pytest.raises(HTTPException) as error:
        await illustration.submit(request)
    assert error.value.status_code == (409 if change == "qwen_model" else 400)
    assert uploads == []


@pytest.mark.parametrize("changes", [{"reservation": .31}, {"parameters": {**illustration.NANO_KEYFRAME_PARAMETERS, "num_images": 2}},
    {"parameters": {**illustration.NANO_KEYFRAME_PARAMETERS, "aspect_ratio": "auto"}},
    {"parameters": {**illustration.NANO_KEYFRAME_PARAMETERS, "negative_prompt": "aerial"}}])
async def test_nano_changed_profile_is_rejected_before_upload(nano_enabled, uploads, changes):
    with pytest.raises(HTTPException) as error:
        await illustration.submit(nano_body(**changes))
    assert error.value.status_code == 409
    assert uploads == []


@pytest.mark.parametrize("size,compatible", [((1376, 768), True), ((1344, 768), False), ((1376, 760), False)])
async def test_nano_status_measures_raw_bytes_without_resizing(monkeypatch, nano_enabled, size, compatible):
    from providers import image
    raw = sized_png(size)
    url = "https://v3.fal.media/files/raw.png"
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(return_value=fal_client.Completed(logs=None, metrics={})))
    monkeypatch.setattr(fal_client, "result_async", AsyncMock(return_value={"images": [{"url": url, "width": 1, "height": 1}]}))
    download = AsyncMock(return_value=(raw, "image/png"))
    monkeypatch.setattr(image, "_fetch_url_bytes", download)
    result = await illustration.status("nano-id", illustration.NANO_KEYFRAME_MODEL)
    assert result["status"] == "ready" and result["image"]["width"] == size[0] and result["image"]["height"] == size[1]
    assert result["raw_image"] == {"valid": True, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                                    "width": size[0], "height": size[1], "format": "PNG"}
    assert result["normalization"]["compatible"] is compatible
    assert result["normalization"]["crop"] is False and result["normalization"]["stretch"] is False
    download.assert_awaited_once_with(url)


async def test_nano_raw_download_failure_retains_original_url_unaccepted(monkeypatch, nano_enabled):
    from providers import image
    url = "https://v3.fal.media/files/raw.png"
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(return_value=fal_client.Completed(logs=None, metrics={})))
    monkeypatch.setattr(fal_client, "result_async", AsyncMock(return_value={"images": [{"url": url}]}))
    monkeypatch.setattr(image, "_fetch_url_bytes", AsyncMock(side_effect=OSError("read unavailable")))
    result = await illustration.status("nano-id", illustration.NANO_KEYFRAME_MODEL)
    assert result["status"] == "ready" and result["image"]["url"] == url
    assert result["raw_image"]["valid"] is False and result["normalization"]["compatible"] is False


async def test_qwen_refuses_nano_landmark_fields_before_upload(monkeypatch, keyframes_enabled, uploads):
    request = keyframe_body()
    request.inputs.landmark_urls = nano_body().inputs.landmark_urls
    request.inputs.landmark_labels = nano_body().inputs.landmark_labels
    provider(monkeypatch, lambda request: pytest.fail("provider called"))
    with pytest.raises(HTTPException) as error:
        await illustration.submit(request)
    assert error.value.status_code == 400 and uploads == []


def jpeg(size=(40, 40), color=(180, 90, 60)):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, format="JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode()


def crop_reference():
    output = io.BytesIO()
    Image.new("RGB", (40, 40), (90, 110, 130)).save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()


def keyframe_body(stage="first", reference=True, **changes):
    request = body(**{"model": illustration.KEYFRAME_MODEL, "parameters": illustration.KEYFRAME_PARAMETERS, **changes})
    request.inputs.control_lora_image_url = None
    request.inputs.keyframe_stage = stage
    request.inputs.reference_url = crop_reference() if reference else None
    request.inputs.reference_kind = "source-art-material-crops-v1" if reference else None
    return request


@pytest.fixture
def keyframes_enabled(monkeypatch, enabled):
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_GENERATION_ENABLED", "1")
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_RESERVATION_USD", "0.1")


@pytest.fixture
def uploads(monkeypatch):
    seen = []
    async def upload(url):
        seen.append(url)
        return f"https://v3.fal.media/files/{len(seen)}.png"
    monkeypatch.setattr(illustration, "to_fal_url", upload)
    return seen


def provider(monkeypatch, handler):
    monkeypatch.setattr(illustration.httpx, "AsyncClient",
                        lambda **kwargs: HTTPClient(transport=httpx.MockTransport(handler), follow_redirects=False))


def pure_outline(mode="RGB", background=(0, 0, 0), edge=(255, 255, 255)):
    output = io.BytesIO()
    image = Image.new(mode, (688, 384), background)
    image.paste(edge, (40, 30, 41, 330))
    image.save(output, "PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()


def flux_body(**changes):
    request = nano_body(**{"model": illustration.FLUX_KEYFRAME_MODEL, "reservation": .15,
                          "parameters": illustration.FLUX_KEYFRAME_PARAMETERS, **changes})
    request.inputs.depth_guide_url = "data:image/png;base64," + base64.b64encode(sized_png(color=(160, 160, 160))).decode()
    request.inputs.outline_guide_url = pure_outline()
    return request


@pytest.fixture
def flux_enabled(monkeypatch, keyframes_enabled):
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_MODEL", illustration.FLUX_KEYFRAME_MODEL)
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_RESERVATION_USD", ".15")


@pytest.mark.parametrize("mode", ["walk", "orbit", "plan"])
def test_flux_prompt_preserves_the_actual_saved_camera_mode(mode):
    request = flux_body()
    request.inputs.scene_identity.mode = mode
    prompt = illustration.flux_keyframe_prompt(request.prompt, request.inputs)
    assert ("eye-level" in prompt) is (mode == "walk")
    assert ("exact saved-camera" in prompt) is (mode != "walk")


async def test_flux_is_opt_in_and_pins_the_bounded_reference_controlnet_contract(monkeypatch, keyframes_enabled):
    assert illustration.configuration(keyframe=True)["model"] == illustration.KEYFRAME_MODEL
    with pytest.raises(HTTPException) as error:
        await illustration.submit(flux_body())
    assert error.value.status_code == 409
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_MODEL", illustration.FLUX_KEYFRAME_MODEL)
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_RESERVATION_USD", ".15")
    config = await illustration.keyframe_capabilities()
    assert config == {"enabled": True, "model": illustration.FLUX_KEYFRAME_MODEL,
                      "reservation": .15, "parameters": illustration.FLUX_KEYFRAME_PARAMETERS, "reason": None}
    parameters = config["parameters"]
    assert parameters["structural_guidance"] == "saved-camera-controlnet-v1"
    assert parameters["prompt_version"] == "saved-camera-flux-reference-controlnet-v1"
    assert parameters["num_images"] == 1 and parameters["output_format"] == "jpeg"
    assert parameters["use_real_cfg"] is False and parameters["ip_adapters"] == []
    assert config["reservation"] >= .075 * 1 + .005  # one rounded-up MP + one gate
    assert parameters["gate"] == illustration.KEYFRAME_PARAMETERS["gate"]
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_NANO_GUIDES_ENABLED", "1")
    assert (await illustration.keyframe_capabilities())["parameters"] == parameters


@pytest.mark.parametrize("reservation", [".149", "0", "nan", "inf", "11"])
async def test_flux_insufficient_or_invalid_reservation_disables_before_upload(monkeypatch, flux_enabled, uploads, reservation):
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_RESERVATION_USD", reservation)
    assert illustration.configuration(keyframe=True)["enabled"] is False
    with pytest.raises(HTTPException) as error:
        await illustration.submit(flux_body())
    assert error.value.status_code == 503 and uploads == []


@pytest.mark.parametrize("balanced", [False, True])
@pytest.mark.parametrize("code", [200, 302, 503, "timeout"])
async def test_flux_uses_scalar_reference_and_two_union_controls_in_one_paid_post(monkeypatch, flux_enabled, uploads, code, balanced):
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_FLUX_BALANCED_ENABLED", "1" if balanced else "0")
    parameters = illustration.FLUX_BALANCED_KEYFRAME_PARAMETERS if balanced else illustration.FLUX_KEYFRAME_PARAMETERS
    request = flux_body(parameters=parameters)
    request.inputs.structural_guide_url = request.inputs.image_url  # retained proof, never sent
    calls = []
    def handler(http_request):
        calls.append(http_request)
        assert str(http_request.url) == f"https://queue.fal.run/{illustration.FLUX_KEYFRAME_MODEL}"
        assert http_request.headers["X-Fal-No-Retry"] == "1"
        payload = json.loads(http_request.content)
        assert payload["image_url"] == "https://v3.fal.media/files/1.png"
        assert payload["reference_image_url"] == "https://v3.fal.media/files/2.png"
        assert payload["image_size"] == {"width": 688, "height": 384}
        assert payload["controlnet_unions"] == [{"path": "Shakker-Labs/FLUX.1-dev-ControlNet-Union-Pro", "controls": [
            {"control_mode": "depth", "control_image_url": "https://v3.fal.media/files/3.png",
             "conditioning_scale": .2 if balanced else 1, "start_percentage": 0, "end_percentage": 1},
            {"control_mode": "canny", "control_image_url": "https://v3.fal.media/files/4.png",
             "conditioning_scale": .4 if balanced else 1, "start_percentage": 0, "end_percentage": 1}]}]
        for key in ("num_images", "num_inference_steps", "guidance_scale", "seed", "strength", "output_format",
                    "enable_safety_checker", "sync_mode", "use_real_cfg", "ip_adapters", "controlnets",
                    "reference_strength", "reference_start", "reference_end"):
            assert payload[key] == parameters[key]
        assert not {"prompt_version", "structural_guidance", "gate", "normalization", "image_urls", "landmark_urls",
                    "landmark_labels", "reference_kind", "scene_identity", "structural_guide_url", "negative_prompt"} & set(payload)
        assert all(name in payload["prompt"] for name in request.inputs.landmark_labels)
        assert "pure edge control" in payload["prompt"] and "reference-only image" in payload["prompt"]
        assert "source crop image" not in payload["prompt"]  # scalar source, no invented crop inputs
        if code == "timeout":
            raise httpx.ReadTimeout("Lost response", request=http_request)
        return httpx.Response(code, json={"request_id": "flux-id"}, headers={"location": "https://foreign.test"})
    provider(monkeypatch, handler)
    if code == 200:
        assert await illustration.submit(request) == {"request_id": "flux-id", "model": illustration.FLUX_KEYFRAME_MODEL}
    else:
        with pytest.raises((httpx.HTTPStatusError, httpx.ReadTimeout)):
            await illustration.submit(request)
    assert uploads == [request.inputs.image_url, request.inputs.reference_url,
                       request.inputs.depth_guide_url, request.inputs.outline_guide_url]
    assert len(calls) == 1
    assert "control_image_url" not in illustration.FLUX_KEYFRAME_PARAMETERS["controlnet_unions"][0]["controls"][0]
    assert "control_image_url" not in illustration.FLUX_BALANCED_KEYFRAME_PARAMETERS["controlnet_unions"][0]["controls"][0]


async def test_balanced_flux_profile_requires_explicit_opt_in_and_preserves_the_original_contract(monkeypatch, flux_enabled, uploads):
    original = json.loads(json.dumps(illustration.FLUX_KEYFRAME_PARAMETERS))
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_FLUX_BALANCED_ENABLED", "1")
    config = await illustration.keyframe_capabilities()
    assert config["enabled"] is True and config["reservation"] == .15
    assert config["parameters"] == illustration.FLUX_BALANCED_KEYFRAME_PARAMETERS
    assert config["parameters"]["strength"] == .85
    assert config["parameters"]["prompt_version"] == "saved-camera-flux-reference-controlnet-v2"
    assert [c["conditioning_scale"] for c in config["parameters"]["controlnet_unions"][0]["controls"]] == [.2, .4]
    assert original == illustration.FLUX_KEYFRAME_PARAMETERS
    with pytest.raises(HTTPException) as error:
        await illustration.submit(flux_body())  # old v1 quote must not silently use v2
    assert error.value.status_code == 409 and uploads == []
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_FLUX_BALANCED_ENABLED", "0")
    assert (await illustration.keyframe_capabilities())["parameters"] == original
    with pytest.raises(HTTPException) as error:
        await illustration.submit(flux_body(parameters=illustration.FLUX_BALANCED_KEYFRAME_PARAMETERS))
    assert error.value.status_code == 409 and uploads == []
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_MODEL", illustration.KEYFRAME_MODEL)
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_RESERVATION_USD", ".10")
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_FLUX_BALANCED_ENABLED", "1")
    assert (await illustration.keyframe_capabilities())["parameters"] == illustration.KEYFRAME_PARAMETERS


@pytest.mark.parametrize("field", ["depth_guide_url", "outline_guide_url"])
@pytest.mark.parametrize("invalid", ["missing", "remote", "jpeg", "corrupt", "wrong_size", "rotated"])
async def test_flux_requires_each_registered_guide_before_upload(monkeypatch, flux_enabled, uploads, field, invalid):
    request = flux_body()
    values = {"missing": None, "remote": "https://v3.fal.media/files/guide.png", "jpeg": jpeg((688, 384)),
              "corrupt": "data:image/png;base64,broken",
              "wrong_size": "data:image/png;base64," + base64.b64encode(sized_png((689, 384))).decode()}
    if invalid == "rotated":
        output = io.BytesIO()
        exif = Image.Exif()
        exif[274] = 6
        Image.new("RGB", (688, 384)).save(output, "PNG", exif=exif)
        value = "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()
    else:
        value = values[invalid]
    setattr(request.inputs, field, value)
    provider(monkeypatch, lambda request: pytest.fail("Invalid Flux guide reached the paid queue"))
    with pytest.raises(HTTPException) as error:
        await illustration.submit(request)
    assert error.value.status_code == 400 and uploads == []


@pytest.mark.parametrize("outline", [
    pure_outline(edge=(255, 200, 0)), pure_outline(edge=(180, 180, 180)),
    pure_outline(mode="RGBA", background=(0, 0, 0, 0), edge=(255, 255, 255, 255)),
    "data:image/png;base64," + base64.b64encode(sized_png(color=(0, 0, 0))).decode(),
    "data:image/png;base64," + base64.b64encode(sized_png(color=(255, 255, 255))).decode(),
])
async def test_flux_rejects_coloured_annotated_transparent_or_empty_outline_before_upload(monkeypatch, flux_enabled, uploads, outline):
    request = flux_body()
    request.inputs.outline_guide_url = outline
    provider(monkeypatch, lambda request: pytest.fail("Non-pure outline reached the paid queue"))
    with pytest.raises(HTTPException) as error:
        await illustration.submit(request)
    assert error.value.status_code == 400 and uploads == []


@pytest.mark.parametrize("field", ["reference_url", "landmark_urls", "landmark_labels", "scene_identity"])
async def test_flux_keeps_all_original_map_landmark_provenance_required(monkeypatch, flux_enabled, uploads, field):
    request = flux_body()
    setattr(request.inputs, field, None)
    provider(monkeypatch, lambda request: pytest.fail("Missing source provenance reached the paid queue"))
    with pytest.raises(HTTPException) as error:
        await illustration.submit(request)
    assert error.value.status_code == 400 and uploads == []


@pytest.mark.parametrize("changes", [
    {"reservation": .16}, {"parameters": {**illustration.FLUX_KEYFRAME_PARAMETERS, "use_real_cfg": True}},
    {"parameters": {**illustration.FLUX_KEYFRAME_PARAMETERS, "ip_adapters": [{"path": "unquoted"}]}},
    {"parameters": {**illustration.FLUX_KEYFRAME_PARAMETERS, "reference_strength": .8}},
    {"parameters": {**illustration.FLUX_KEYFRAME_PARAMETERS, "controlnet_unions": []}},
])
async def test_flux_rejects_any_unquoted_cost_or_control_change_before_upload(flux_enabled, uploads, changes):
    with pytest.raises(HTTPException) as error:
        await illustration.submit(flux_body(**changes))
    assert error.value.status_code == 409 and uploads == []


@pytest.mark.parametrize("profile", ["qwen", "nano_v1", "nano_v2", "depth"])
async def test_old_profiles_refuse_new_flux_outline_field(monkeypatch, enabled, uploads, profile):
    if profile == "depth":
        request = body()
    else:
        monkeypatch.setenv("ILLUSTRATION_KEYFRAME_GENERATION_ENABLED", "1")
        monkeypatch.setenv("ILLUSTRATION_KEYFRAME_MODEL", illustration.KEYFRAME_MODEL if profile == "qwen" else illustration.NANO_KEYFRAME_MODEL)
        monkeypatch.setenv("ILLUSTRATION_KEYFRAME_RESERVATION_USD", ".10" if profile == "qwen" else ".30")
        monkeypatch.setenv("ILLUSTRATION_KEYFRAME_NANO_GUIDES_ENABLED", "1" if profile == "nano_v2" else "0")
        request = keyframe_body() if profile == "qwen" else nano_guides_body() if profile == "nano_v2" else nano_body()
    request.inputs.outline_guide_url = pure_outline()
    provider(monkeypatch, lambda request: pytest.fail("Old profile ignored Flux controls"))
    with pytest.raises(HTTPException) as error:
        await illustration.submit(request)
    assert error.value.status_code == 400 and uploads == []


@pytest.mark.parametrize("size,format,valid", [((688, 384), "JPEG", True), ((1376, 768), "JPEG", False),
    ((688, 380), "JPEG", False), ((688, 384), "PNG", False)])
async def test_flux_status_measures_exact_jpeg_bytes_and_preserves_incompatible_raw(monkeypatch, flux_enabled, size, format, valid):
    from providers import image
    output = io.BytesIO()
    Image.new("RGB", size).save(output, format)
    raw = output.getvalue()
    url = "https://v3.fal.media/files/raw.jpg"
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_GENERATION_ENABLED", "0")  # stored request recovery remains free
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(return_value=fal_client.Completed(logs=None, metrics={})))
    monkeypatch.setattr(fal_client, "result_async", AsyncMock(return_value={"images": [{"url": url, "width": 1, "height": 1}]}))
    download = AsyncMock(return_value=(raw, "image/jpeg"))
    monkeypatch.setattr(image, "_fetch_url_bytes", download)
    result = await illustration.status("flux-id", illustration.FLUX_KEYFRAME_MODEL)
    assert result["status"] == "ready" and result["image"] == {"url": url, "width": size[0], "height": size[1]}
    assert result["raw_image"]["valid"] is valid
    assert result["raw_image"]["sha256"] == hashlib.sha256(raw).hexdigest()
    assert result["raw_image"]["bytes"] == len(raw) and result["raw_image"]["format"] == format
    assert "normalization" not in result
    download.assert_awaited_once_with(url)


@pytest.mark.parametrize("failure", ["download", "corrupt", "rotated"])
async def test_flux_raw_failure_retains_original_output_unaccepted(monkeypatch, flux_enabled, failure):
    from providers import image
    url = "https://v3.fal.media/files/raw.jpg"
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(return_value=fal_client.Completed(logs=None, metrics={})))
    monkeypatch.setattr(fal_client, "result_async", AsyncMock(return_value={"images": [{"url": url}]}))
    if failure == "download":
        fetch = AsyncMock(side_effect=OSError("read unavailable"))
    else:
        output = io.BytesIO()
        exif = Image.Exif()
        exif[274] = 6
        Image.new("RGB", (688, 384)).save(output, "JPEG", exif=exif)
        fetch = AsyncMock(return_value=(b"broken" if failure == "corrupt" else output.getvalue(), "image/jpeg"))
    monkeypatch.setattr(image, "_fetch_url_bytes", fetch)
    result = await illustration.status("flux-id", illustration.FLUX_KEYFRAME_MODEL)
    assert result["status"] == "ready" and result["image"]["url"] == url
    assert result["raw_image"]["valid"] is False


async def test_keyframe_option_is_separate_floored_and_off_under_mock(monkeypatch, enabled):
    assert (await illustration.keyframe_capabilities())["enabled"] is False  # depth flag alone is not enough
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_GENERATION_ENABLED", "1")
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_RESERVATION_USD", "0.1")
    config = await illustration.keyframe_capabilities()
    assert config["enabled"] and config["model"] == illustration.KEYFRAME_MODEL and config["reservation"] == 0.1
    assert config["parameters"]["num_images"] == 2
    assert config["parameters"]["prompt_version"] == "saved-camera-qwen-keyframe-v5"
    assert "aerial view" in config["parameters"]["negative_prompt"]
    assert "lettering" in config["parameters"]["negative_prompt"]
    assert illustration.configuration()["model"] == illustration.MODEL
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_RESERVATION_USD", "0.05")  # below two images plus the gate
    assert illustration.configuration(keyframe=True)["enabled"] is False
    monkeypatch.setenv("ILLUSTRATION_KEYFRAME_RESERVATION_USD", "0.1")
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    assert illustration.configuration(keyframe=True)["enabled"] is False
    with pytest.raises(HTTPException) as error:
        await illustration.submit(keyframe_body())
    assert error.value.status_code == 503


@pytest.mark.parametrize("code", [200, 500, None])
async def test_keyframe_uploads_inputs_then_posts_once(monkeypatch, keyframes_enabled, uploads, code):
    calls = []
    def handler(request):
        calls.append(request)
        assert str(request.url) == f"https://queue.fal.run/{illustration.KEYFRAME_MODEL}"
        assert request.headers["X-Fal-No-Retry"] == "1"
        payload = json.loads(request.content)
        assert payload["image_urls"] == ["https://v3.fal.media/files/1.png", "https://v3.fal.media/files/2.png"]
        assert payload["image_size"] == {"width": 64, "height": 32}
        assert payload["num_images"] == 2 and payload["enable_safety_checker"] is True
        assert not {"gate", "prompt_version", "image_url", "control_lora_image_url", "reference_url",
                    "keyframe_stage", "scene_identity", "reference_kind"} & set(payload)
        assert payload["negative_prompt"] == illustration.KEYFRAME_PARAMETERS["negative_prompt"]
        assert "Image 2" in payload["prompt"] and "Copper Kettle" in payload["prompt"]
        assert "Hand inked stonework" in payload["prompt"]
        if code is None:
            raise httpx.ReadTimeout("Lost response", request=request)
        return httpx.Response(code, json={"request_id": "kf-id"})
    provider(monkeypatch, handler)
    if code == 200:
        assert await illustration.submit(keyframe_body()) == {"request_id": "kf-id", "model": illustration.KEYFRAME_MODEL}
    else:
        with pytest.raises((httpx.HTTPStatusError, httpx.ReadTimeout)):
            await illustration.submit(keyframe_body())
    assert uploads == [png(), crop_reference()]  # exact render first, source-art material crops second
    assert len(calls) == 1


async def test_keyframe_without_art_describes_the_style_in_words(monkeypatch, keyframes_enabled, uploads):
    sent = []
    def handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"request_id": "kf-id"})
    provider(monkeypatch, handler)
    await illustration.submit(keyframe_body(reference=False))
    words, = sent
    assert len(words["image_urls"]) == 1 and "Image 2" not in words["prompt"]
    assert "Hand inked stonework" in words["prompt"] and "Copper Kettle" in words["prompt"]


async def test_keyframe_asks_for_every_surface_and_names_the_largest_object(monkeypatch, keyframes_enabled, uploads):
    sent = []
    def handler(request):
        sent.append(json.loads(request.content)["prompt"])
        return httpx.Response(200, json={"request_id": "kf-id"})
    provider(monkeypatch, handler)
    request = keyframe_body()
    kettle = request.inputs.scene_identity.objects[0]
    # Largest first: a path (ground) and a tree, then the well; the building and ground are never named.
    request.inputs.scene_identity.objects = [kettle.model_copy(update={"id": i, "label": label, "kind": kind}) for i, label, kind in
                                             [("street", "Main Street", "path"), ("oak", "Old Oak", "tree"), ("well", "Plaza Stone Well", "well")]] + [kettle]
    await illustration.submit(request)
    await illustration.submit(keyframe_body(reference=False))
    named, plain = sent
    assert "Paint every surface, including large objects close to the camera and the Old Oak, so nothing keeps the render's flat grey or green colours." in named
    assert "Paint every surface, including large objects close to the camera, so nothing keeps" in plain
    assert "Main Street" not in named.split("Paint every surface")[1].split("colours.")[0]


async def test_source_art_conditions_materials_without_replacing_saved_camera(monkeypatch, keyframes_enabled, uploads):
    sent = []
    def handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"request_id": "kf-id"})
    provider(monkeypatch, handler)
    request = keyframe_body()
    landmark = request.inputs.scene_identity.objects[0]
    request.inputs.scene_identity.objects.append(landmark.model_copy(update={
        "id": "bakery", "label": "Little Oxblood Bakery", "kind": "building",
        "center_percent": (70, 50), "bounds_percent": (60, 20, 90, 80),
    }))
    await illustration.submit(request)
    payload, = sent
    prompt = payload["prompt"]
    assert uploads == [png(), crop_reference()]
    assert "Image 1 alone defines the camera" in prompt
    assert "isolated material crops from the saved world artwork" in prompt
    assert "no shared viewpoint, layout or spatial relationship" in prompt
    assert "Never reproduce the sample sheet, its grid or any crop's composition" in prompt
    assert "surface detail" in prompt and "leave passages open" in prompt
    assert "same place" not in prompt
    # Every visible identity reaches the provider, with locations from the saved
    # object pass rather than an inferred location in the appearance reference.
    records = json.loads(prompt.split("bounds describe only visible pixels): ", 1)[1].split(". Match names", 1)[0])
    assert records[1] == {"name": "Little Oxblood Bakery", "kind": "building",
                          "center_percent": [70, 50], "bounds_percent": [60, 20, 90, 80]}
    assert payload["image_size"] == {"width": 64, "height": 32}
    assert payload["num_images"] == 2


# "chain" is the v1 warp input; the web now composites chains and sends "first".
@pytest.mark.parametrize("change", ["no_stage", "chain", "mask", "no_identity",
                                    "remote_reference", "garbage_reference", "jpeg_render",
                                    "no_reference_kind", "reference_kind_without_image", "jpeg_reference"])
async def test_invalid_keyframe_requests_never_reach_the_provider(monkeypatch, keyframes_enabled, uploads, change):
    request = keyframe_body("chain") if change == "chain" else keyframe_body()
    if change == "no_stage":
        request.inputs.keyframe_stage = None
    elif change == "mask":
        request.inputs.mask_url = mask_url()
    elif change == "no_identity":
        request.inputs.scene_identity = None
    elif change == "remote_reference":
        request.inputs.reference_url = "https://foreign.test/art.png"
    elif change == "garbage_reference":
        request.inputs.reference_url = "data:image/png;base64,garbage"
    elif change == "jpeg_render":
        request.inputs.image_url = jpeg((64, 32))
    elif change == "no_reference_kind":
        request.inputs.reference_kind = None
    elif change == "reference_kind_without_image":
        request.inputs.reference_url = None
    elif change == "jpeg_reference":
        request.inputs.reference_url = jpeg()
    provider(monkeypatch, lambda request: pytest.fail("provider called"))
    with pytest.raises(HTTPException) as error:
        await illustration.submit(request)
    assert error.value.status_code == 400
    assert uploads == []


@pytest.mark.parametrize("changes", [{"reservation": 0.2}, {"parameters": illustration.PARAMETERS}, {"parameters": {
    **illustration.KEYFRAME_PARAMETERS, "prompt_version": "saved-camera-qwen-keyframe-v2"}}, {"parameters": {
    **illustration.KEYFRAME_PARAMETERS, "prompt_version": "saved-camera-qwen-keyframe-v3"}}, {"parameters": {
    **illustration.KEYFRAME_PARAMETERS, "prompt_version": "saved-camera-qwen-keyframe-v4"}}])
async def test_keyframe_rejects_changed_configuration(keyframes_enabled, uploads, changes):
    with pytest.raises(HTTPException) as error:
        await illustration.submit(keyframe_body(**changes))
    assert error.value.status_code == 409


@pytest.mark.parametrize("field,value", [("control_lora_image_url", None), ("keyframe_stage", "first"), ("reference_url", jpeg()),
                                       ("reference_kind", "source-art-material-crops-v1")])
async def test_depth_route_needs_depth_and_refuses_keyframe_inputs(enabled, field, value):
    request = body()
    setattr(request.inputs, field, value)
    with pytest.raises(HTTPException) as error:
        await illustration.submit(request)
    assert error.value.status_code == 400


async def test_keyframe_status_returns_every_safe_candidate(monkeypatch, keyframes_enabled):
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(return_value=fal_client.Completed(logs=None, metrics={})))
    monkeypatch.setattr(fal_client, "result_async", AsyncMock(return_value={
        "images": [{"url": "https://fal.media/a.jpg"}, {"url": "https://fal.media/b.jpg"}],
        "has_nsfw_concepts": [True, False], "seed": 3}))
    safe = {"url": "https://fal.media/b.jpg"}
    assert await illustration.status("kf-id", illustration.KEYFRAME_MODEL) == {
        "status": "ready", "image": safe, "images": [safe], "seed": 3}
    fal_client.result_async.return_value = {"images": [{"url": "https://fal.media/a.jpg"}], "has_nsfw_concepts": [True]}
    assert (await illustration.status("kf-id", illustration.KEYFRAME_MODEL))["status"] == "failed"


def fal_url(n):
    return f"https://v3.fal.media/files/candidate-{n}.jpg"


def gate_body(**changes):
    return illustration.GateInput(**{"image_urls": [fal_url(0), fal_url(1)], "box": [8, 4, 40, 28],
                                     "width": 64, "height": 32, "label": "building", **changes})


async def test_nano_gate_measures_exact_normalized_jpeg_without_download(monkeypatch, enabled):
    from providers import image
    url = jpeg((688, 384))
    raw = base64.b64decode(url.split(",", 1)[1])
    download = AsyncMock(side_effect=AssertionError("normalized image downloaded"))
    monkeypatch.setattr(image, "_fetch_url_bytes", download)
    sam = AsyncMock(return_value={"mask": None, "request_id": "sam-normalized", "score": None})
    monkeypatch.setattr(illustration.segmenter, "sam3_box_mask", sam)
    result = await illustration.gate(gate_body(image_urls=[url], width=688, height=384, box=[8, 4, 200, 300]))
    assert result == {"masks": [{"mask_png": None, "request_id": "sam-normalized", "score": None}]}
    sam.assert_awaited_once_with(raw, (8, 4, 200, 300), "building", (688, 384))
    download.assert_not_awaited()


@pytest.mark.parametrize("url,width,height", [(jpeg((688, 384)), 64, 32), (jpeg((1376, 768)), 688, 384),
    (jpeg((688, 380)), 688, 384), ("data:image/jpeg;base64,broken", 688, 384),
    ("data:image/png;base64," + base64.b64encode(sized_png()).decode(), 688, 384)])
async def test_nano_gate_rejects_wrong_bytes_before_any_sam_request(monkeypatch, enabled, url, width, height):
    sam = AsyncMock(side_effect=AssertionError("segmenter called"))
    monkeypatch.setattr(illustration.segmenter, "sam3_box_mask", sam)
    with pytest.raises(HTTPException) as error:
        await illustration.gate(gate_body(image_urls=[jpeg((688, 384)), url], width=width, height=height))
    assert error.value.status_code == 400
    sam.assert_not_awaited()


def image_bytes(color):
    output = io.BytesIO()
    Image.new("RGB", (64, 32), color).save(output, format="JPEG")
    return output.getvalue()


@pytest.fixture
def candidates(monkeypatch):
    fetched = []
    async def fetch(url):
        fetched.append(url)
        return image_bytes((0, 0, 0) if url == fal_url(0) else (255, 255, 255)), "image/jpeg"
    monkeypatch.setattr("providers.image._fetch_url_bytes", fetch)
    return fetched


async def test_gate_never_runs_under_mock(monkeypatch, enabled, candidates):
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    with pytest.raises(HTTPException) as error:
        await illustration.gate(gate_body())
    assert error.value.status_code == 503
    assert candidates == []


@pytest.mark.parametrize("changes", [
    {"image_urls": ["http://v3.fal.media/files/a.jpg"]}, {"image_urls": ["https://fal.media.evil.test/a.jpg"]},
    {"image_urls": ["https://user@v3.fal.media/files/a.jpg"]}, {"image_urls": ["https://v3.fal.media:8443/files/a.jpg"]},
    {"image_urls": ["data:image/png;base64,AAAA"]}, {"box": [40, 4, 8, 28]}, {"box": [8, 4, 65, 28]}, {"box": [-1, 4, 40, 28]},
])
async def test_gate_rejects_foreign_images_and_bad_boxes(monkeypatch, enabled, candidates, changes):
    monkeypatch.setattr(illustration.segmenter, "sam3_box_mask", AsyncMock(side_effect=AssertionError("segmenter called")))
    with pytest.raises(HTTPException) as error:
        await illustration.gate(gate_body(**changes))
    assert error.value.status_code == 400
    assert candidates == []


@pytest.mark.parametrize("label", ["well", "object"])
async def test_gate_prompts_sam3_with_the_subjects_word(monkeypatch, enabled, candidates, label):
    # Near a well no building is large enough: the web gates the well, by its kind.
    sam = AsyncMock(return_value={"mask": None, "request_id": "sam", "score": None, "crop": (0, 0, 64, 32)})
    monkeypatch.setattr(illustration.segmenter, "sam3_box_mask", sam)
    await illustration.gate(gate_body(label=label))
    assert [call.args[2] for call in sam.await_args_list] == [label, label]


def test_gate_accepts_at_most_four_images():
    with pytest.raises(ValidationError):
        gate_body(image_urls=[fal_url(n) for n in range(5)])


async def test_gate_returns_full_frame_one_bit_masks(monkeypatch, enabled, candidates):
    calls = []
    async def sam(image, box, label, size):
        calls.append((tuple(box), label, size))
        if image != image_bytes((0, 0, 0)):
            return {"mask": None, "request_id": "sam-2", "score": None, "crop": (0, 0, 64, 32)}
        mask = Image.new("1", size, 0)
        mask.paste(255, (8, 4, 40, 28))
        return {"mask": mask, "request_id": "sam-1", "score": 0.9, "crop": (0, 0, 64, 32)}
    monkeypatch.setattr(illustration.segmenter, "sam3_box_mask", sam)
    first, second = (await illustration.gate(gate_body()))["masks"]
    assert second == {"mask_png": None, "request_id": "sam-2", "score": None}
    assert first["request_id"] == "sam-1" and first["score"] == 0.9
    with Image.open(io.BytesIO(base64.b64decode(first["mask_png"]))) as mask:
        assert mask.format == "PNG" and mask.mode == "1" and mask.size == (64, 32)
        assert mask.getbbox() == (8, 4, 40, 28)
    assert candidates == [fal_url(0), fal_url(1)]
    assert calls[0] == ((8, 4, 40, 28), "building", (64, 32))


async def test_gate_outage_is_an_error_not_an_empty_mask(monkeypatch, enabled, candidates):
    monkeypatch.setattr(illustration.segmenter, "sam3_box_mask", AsyncMock(side_effect=httpx.ReadTimeout("lost")))
    with pytest.raises(HTTPException) as error:
        await illustration.gate(gate_body())
    assert error.value.status_code == 502
