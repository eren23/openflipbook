"""Free contract/transport tests for image-led drafts; no real provider calls."""

from __future__ import annotations

import base64
import copy
import hashlib
import io
import json
import math
import sys
from unittest.mock import AsyncMock, MagicMock

import fal_client
import httpx
import pytest
from fal_client.client import FalClientHTTPError
from fastapi import HTTPException
from PIL import Image
from pydantic import ValidationError

from providers import image_led_walk as walk

HTTPClient = httpx.AsyncClient


def image(size=(128, 96), color=(70, 110, 150), format="PNG", exif=None):
    output = io.BytesIO()
    options = {"exif": exif} if exif is not None else {}
    Image.new("RGBA" if len(color) == 4 else "RGB", size, color).save(output, format=format, **options)
    data = output.getvalue()
    return {
        "url": f"data:image/{'png' if format == 'PNG' else 'jpeg'};base64," + base64.b64encode(data).decode(),
        "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
        "width": size[0], "height": size[1],
    }


def refresh_intent(request):
    if "source" in request:
        source = request["source"]
        width, height, sha256 = source["width"], source["height"], source["sha256"]
        landmarks = [walk.Landmark(**row) for row in request["landmarks"]]
        anchors = [walk.RoutePoint(x=(r.source_rectangle.left + r.source_rectangle.width / 2) / width,
                                  y=(r.source_rectangle.top + r.source_rectangle.height / 2) / height) for r in landmarks]
    else:
        dimensions = request["route_intent"]["map_dimensions"]
        width, height, sha256 = dimensions["width"], dimensions["height"], request["source_sha256"]
        landmarks = [walk.LandmarkIdentity(**row) for row in request["landmarks"]]
        anchors = [walk.RoutePoint(**row["anchor"]) for row in request["route_intent"]["checkpoints"][0]["landmark_relations"]]
    request["route_intent"] = walk.build_route_intent(walk.Route(**request["route"]), sha256, width, height, landmarks, anchors)
    return request


def payload(index=0, anchor=False):
    original = image()
    result = {
        "profile": walk.PROFILE, "model": walk.MODEL, "reservation": 0.15,
        "parameters": copy.deepcopy(walk.PARAMETERS), "prompt": "Rich hand-painted fantasy street",
        "source_projection": "illustrated_oblique_or_unknown", "source": original,
        "landmarks": [
            {"id": "bookshop", "label": "Mossbound Bookshop", "visual": "Moss-green roof, projecting arched book window and books",
             "source_rectangle": {"left": 0, "top": 32, "width": 48, "height": 48},
             "image": image((48, 48), (20, 150, 35))},
            {"id": "inn", "label": "Glassroot Inn", "visual": "Teal roof and carved moth emblem",
             "source_rectangle": {"left": 0, "top": 0, "width": 48, "height": 32},
             "image": image((48, 32), (30, 110, 120))},
            {"id": "forge", "label": "Lantern Forge", "visual": "Red roof and open orange hearth",
             "source_rectangle": {"left": 80, "top": 32, "width": 48, "height": 48},
             "image": image((48, 48), (180, 45, 35))},
            {"id": "glass", "label": "Tideglass Conservatory", "visual": "Faceted transparent glass, teal ribs and plants",
             "source_rectangle": {"left": 80, "top": 0, "width": 48, "height": 32},
             "image": image((48, 32), (30, 150, 180))},
        ],
        "route": {"frame": "original-image-normalized", "points": [{"x": 0.5, "y": 0.9}, {"x": 0.5, "y": 0.7}, {"x": 0.5, "y": 0.5}],
                  "checkpoint_index": index, "map_sha256": original["sha256"]},
    }
    if index or anchor:
        prior = image((146, 82), (175, 150, 95), "JPEG")
        result["prior"] = {"checkpoint_index": index - 1 if index else 0,
                           "image": prior, "reviewed_sha256": prior["sha256"]}
    return refresh_intent(result)


def profile_payload(model, *, index=0, repair=False, mask=False):
    request = payload(index=index)
    request.update(model=model, parameters=copy.deepcopy(walk.STILL_PROFILES[model]["parameters"]))
    if model == walk.FLUX_MODEL:
        request["source"] = image((1024, 768))
        request["route"]["map_sha256"] = request["source"]["sha256"]
        for landmark in request["landmarks"]:
            landmark["source_rectangle"] = {k: v * 8 for k, v in landmark["source_rectangle"].items()}
            r = landmark["source_rectangle"]
            landmark["image"] = image((r["width"], r["height"]))
        if request.get("prior"):
            prior = image((512, 288), (175, 150, 95))
            request["prior"].update(image=prior, reviewed_sha256=prior["sha256"])
    if repair:
        target = image((512, 288), (100, 110, 120))
        request["repair"] = {"checkpoint_index": index, "source_sha256": request["source"]["sha256"],
                             "target_sha256": target["sha256"], "image": target}
        if mask:
            request["repair"]["mask"] = image((512, 288), (255, 255, 255, 0))
    return refresh_intent(request)


def select_profile(monkeypatch, model):
    monkeypatch.setenv("IMAGE_LED_WALK_MODEL", model)
    monkeypatch.setenv(walk.STILL_PROFILES[model]["reservation_env"], "0.15")


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.delenv("MOCK_PROVIDERS", raising=False)
    monkeypatch.delenv("IMAGE_LED_WALK_MODEL", raising=False)
    for profile in walk.STILL_PROFILES.values():
        monkeypatch.delenv(profile["reservation_env"], raising=False)
    monkeypatch.setenv("IMAGE_LED_WALK_ENABLED", "1")
    monkeypatch.setenv("IMAGE_LED_WALK_RESERVATION_USD", "0.15")
    monkeypatch.setenv("SHARED_TOKEN", "test")
    monkeypatch.setenv("FAL_KEY", "test")


def test_default_profile_is_nanopro_and_unknown_operator_endpoint_is_disabled(enabled, monkeypatch):
    assert walk.configuration()["model"] == walk.MODEL
    assert walk.configuration()["parameters"]["prompt_version"] == "image-led-walk-v4"
    monkeypatch.setenv("IMAGE_LED_WALK_MODEL", "https://untrusted.test/edit")
    assert walk.configuration()["enabled"] is False
    assert walk.configuration()["model"] is None


@pytest.mark.parametrize("model", [walk.SUNBURST_MODEL, walk.FLUX_MODEL, walk.SEEDREAM_MODEL])
async def test_switching_model_cannot_inherit_nanopro_reservation(enabled, monkeypatch, model):
    monkeypatch.setenv("IMAGE_LED_WALK_MODEL", model)
    # The fixture has the legacy NanoPro reservation, but no ceiling for this model.
    assert walk.configuration()["enabled"] is False
    assert walk.configuration()["reservation"] == 0
    upload, post = AsyncMock(), AsyncMock()
    monkeypatch.setattr(walk, "to_fal_url", upload)
    monkeypatch.setattr(walk, "post_once", post)
    with pytest.raises(HTTPException) as error:
        await walk.submit(walk.ImageLedInput(**profile_payload(model)))
    assert error.value.status_code == 503
    upload.assert_not_awaited()
    post.assert_not_awaited()
    select_profile(monkeypatch, model)
    assert walk.configuration()["enabled"] is True


@pytest.mark.parametrize("value", ["0", "0.149", "nan", "inf", "11", "garbage"])
async def test_selected_model_reservation_must_be_explicit_finite_and_bounded(enabled, monkeypatch, value):
    monkeypatch.setenv("IMAGE_LED_WALK_MODEL", walk.SUNBURST_MODEL)
    monkeypatch.setenv("IMAGE_LED_WALK_SUNBURST_RESERVATION_USD", value)
    assert walk.configuration()["enabled"] is False


@pytest.mark.parametrize("model", list(walk.STILL_PROFILES))
async def test_allowlisted_profile_transmits_only_its_schema_and_ordered_inputs(enabled, monkeypatch, model):
    select_profile(monkeypatch, model)
    request = walk.ImageLedInput(**profile_payload(model, index=1, repair=True))
    uploads = []

    async def upload(url):
        uploads.append(url)
        return f"https://fal.media/input-{len(uploads)}.png"

    post = AsyncMock(return_value="known-model-request")
    monkeypatch.setattr(walk, "to_fal_url", upload)
    monkeypatch.setattr(walk, "post_once", post)
    result = await walk.submit(request)
    assert uploads == [request.repair.image.url, request.prior.image.url, request.source.url,
                       *(landmark.image.url for landmark in request.landmarks)]
    endpoint, arguments = post.call_args.args
    assert endpoint == model
    parameters = {k: v for k, v in walk.STILL_PROFILES[model]["parameters"].items() if k != "prompt_version"}
    assert arguments == {**parameters, "image_urls": [f"https://fal.media/input-{i}.png" for i in range(1, len(uploads) + 1)],
                         "prompt": walk.image_led_prompt(request)}
    assert "Image 1 is the exact unapproved repair target" in arguments["prompt"]
    assert "Image 2 is the immediately preceding owner-reviewed" in arguments["prompt"]
    assert "Image 3 is the original world artwork" in arguments["prompt"]
    assert result["model"] == model and result["prompt_version"] == "image-led-walk-v4"
    post.assert_awaited_once()


@pytest.mark.parametrize("model", list(walk.STILL_PROFILES))
async def test_other_model_parameters_cannot_leak_into_a_profile(enabled, monkeypatch, model):
    select_profile(monkeypatch, model)
    request = profile_payload(model)
    request["parameters"]["mask_url"] = "https://foreign.test/mask.png"
    upload, post = AsyncMock(), AsyncMock()
    monkeypatch.setattr(walk, "to_fal_url", upload)
    monkeypatch.setattr(walk, "post_once", post)
    with pytest.raises(HTTPException) as error:
        await walk.submit(walk.ImageLedInput(**request))
    assert error.value.status_code == 409
    upload.assert_not_awaited()
    post.assert_not_awaited()


@pytest.mark.parametrize("model", [walk.FLUX_MODEL, walk.SEEDREAM_MODEL])
async def test_actual_reference_overflow_including_repair_and_predecessor_blocks_before_upload(enabled, monkeypatch, model):
    select_profile(monkeypatch, model)
    request = profile_payload(model, index=1, repair=True)
    for index in range(4):
        landmark = copy.deepcopy(request["landmarks"][index])
        landmark.update(id=f"extra-{index}", label=f"Extra original building {index}")
        request["landmarks"].append(landmark)
    refresh_intent(request)
    upload, post = AsyncMock(), AsyncMock()
    monkeypatch.setattr(walk, "to_fal_url", upload)
    monkeypatch.setattr(walk, "post_once", post)
    with pytest.raises(HTTPException) as error:
        await walk.submit(walk.ImageLedInput(**request))
    assert error.value.status_code == 400
    assert "reference limit" in error.value.detail
    upload.assert_not_awaited()
    post.assert_not_awaited()


@pytest.mark.parametrize("size", [(255, 256), (256, 255), (2001, 2000)])
async def test_flux_rejects_incompatible_actual_reference_dimensions(enabled, monkeypatch, size):
    select_profile(monkeypatch, walk.FLUX_MODEL)
    request = profile_payload(walk.FLUX_MODEL)
    request["landmarks"][-1]["image"] = image(size)
    upload = AsyncMock()
    monkeypatch.setattr(walk, "to_fal_url", upload)
    with pytest.raises(HTTPException) as error:
        await walk.submit(walk.ImageLedInput(**request))
    assert error.value.status_code == 400
    upload.assert_not_awaited()


async def test_sunburst_mask_and_repair_hashes_are_bound_before_any_upload(enabled, monkeypatch):
    select_profile(monkeypatch, walk.SUNBURST_MODEL)
    request = profile_payload(walk.SUNBURST_MODEL, mask=True, repair=True)
    original = walk.input_fingerprint(walk.ImageLedInput(**request))
    changed = copy.deepcopy(request)
    changed["repair"]["mask"] = image((512, 288), (0, 0, 0, 255))
    assert walk.input_fingerprint(walk.ImageLedInput(**changed)) != original
    upload, post = AsyncMock(return_value="https://fal.media/mask.png"), AsyncMock(return_value="masked-request")
    monkeypatch.setattr(walk, "to_fal_url", upload)
    monkeypatch.setattr(walk, "post_once", post)
    await walk.submit(walk.ImageLedInput(**request))
    assert upload.await_args_list[-1].args == (request["repair"]["mask"]["url"],)
    assert post.call_args.args[1]["mask_url"] == "https://fal.media/mask.png"
    post.reset_mock()
    upload.reset_mock()
    request["repair"]["mask"]["sha256"] = "0" * 64
    with pytest.raises(HTTPException) as error:
        await walk.submit(walk.ImageLedInput(**request))
    assert error.value.status_code == 400
    upload.assert_not_awaited()
    post.assert_not_awaited()


@pytest.mark.parametrize("model", [walk.MODEL, walk.FLUX_MODEL, walk.SEEDREAM_MODEL])
async def test_unsupported_masks_are_rejected_before_upload(enabled, monkeypatch, model):
    select_profile(monkeypatch, model)
    upload = AsyncMock()
    monkeypatch.setattr(walk, "to_fal_url", upload)
    with pytest.raises(HTTPException) as error:
        await walk.submit(walk.ImageLedInput(**profile_payload(model, repair=True, mask=True)))
    assert error.value.status_code == 400
    upload.assert_not_awaited()


@pytest.mark.parametrize("field,value", [("target_sha256", "0" * 64), ("source_sha256", "0" * 64), ("checkpoint_index", 1)])
def test_repair_provenance_cannot_change_checkpoint_source_or_exact_target(field, value):
    request = profile_payload(walk.SUNBURST_MODEL, repair=True)
    request["repair"][field] = value
    with pytest.raises(ValidationError):
        walk.ImageLedInput(**request)


@pytest.mark.parametrize("saved_model", list(walk.STILL_PROFILES))
async def test_status_polls_immutable_saved_model_after_operator_switch_or_disable(enabled, monkeypatch, saved_model):
    monkeypatch.setenv("IMAGE_LED_WALK_MODEL", walk.SEEDREAM_MODEL)
    monkeypatch.setenv("IMAGE_LED_WALK_ENABLED", "0")
    poll, result, post = AsyncMock(return_value=fal_client.Completed(logs=[], metrics={})), AsyncMock(return_value={"images": [{"url": "https://fal.media/original.png"}]}), AsyncMock()
    monkeypatch.setattr(fal_client, "status_async", poll)
    monkeypatch.setattr(fal_client, "result_async", result)
    monkeypatch.setattr(walk, "post_once", post)
    monkeypatch.setattr(walk, "raw_output_metadata", AsyncMock(return_value={"valid": True}))
    response = await walk.status("saved-request", model=saved_model)
    assert response["model"] == saved_model
    poll.assert_awaited_once_with(saved_model, "saved-request")
    result.assert_awaited_once_with(saved_model, "saved-request")
    post.assert_not_awaited()


async def test_legacy_status_defaults_to_nanopro_after_profile_switch(enabled, monkeypatch):
    monkeypatch.setenv("IMAGE_LED_WALK_MODEL", walk.FLUX_MODEL)
    poll = AsyncMock(return_value=fal_client.Queued(position=0))
    monkeypatch.setattr(fal_client, "status_async", poll)
    await walk.status("old-v3-request")
    poll.assert_awaited_once_with(walk.MODEL, "old-v3-request")


async def test_unknown_saved_model_cannot_poll_an_arbitrary_endpoint(enabled, monkeypatch):
    poll = AsyncMock()
    monkeypatch.setattr(fal_client, "status_async", poll)
    with pytest.raises(HTTPException) as error:
        await walk.status("saved-request", model="https://untrusted.test/edit")
    assert error.value.status_code == 400
    poll.assert_not_awaited()


@pytest.mark.parametrize("key", ["IMAGE_LED_WALK_ENABLED", "IMAGE_LED_WALK_RESERVATION_USD", "SHARED_TOKEN", "FAL_KEY"])
async def test_default_off_requires_each_capability(enabled, monkeypatch, key):
    monkeypatch.delenv(key)
    monkeypatch.setattr(walk, "to_fal_url", AsyncMock(side_effect=AssertionError("No upload")))
    assert walk.configuration()["enabled"] is False
    with pytest.raises(HTTPException) as error:
        await walk.submit(walk.ImageLedInput(**payload()))
    assert error.value.status_code == 503


@pytest.mark.parametrize("value", ["", "0", "-1", "0.149", "nan", "inf", "11", "garbage"])
def test_invalid_or_below_price_reservation_disabled(enabled, monkeypatch, value):
    monkeypatch.setenv("IMAGE_LED_WALK_RESERVATION_USD", value)
    assert walk.configuration()["enabled"] is False


async def test_mock_disables_submission_and_recovery(enabled, monkeypatch):
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    monkeypatch.setattr(walk, "to_fal_url", AsyncMock(side_effect=AssertionError("No upload")))
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(side_effect=AssertionError("No status")))
    for call in (walk.submit(walk.ImageLedInput(**payload())), walk.status("known-id")):
        with pytest.raises(HTTPException) as error:
            await call
        assert error.value.status_code == 503


@pytest.mark.parametrize("change", [
    lambda p: p.update(profile="saved-camera-v1"),
    lambda p: p.update(model="fal-ai/other"),
    lambda p: p.update(depth="fake"),
    lambda p: p.update(objects="fake"),
    lambda p: p.update(outline="fake"),
    lambda p: p.update(camera="fake"),
    lambda p: p.update(source_projection="top_down"),
    lambda p: p["source"].update(url="https://example.test/image.png", bytes="100"),
    lambda p: p["landmarks"][0].update(mask="fake"),
    lambda p: p["route"].update(frame="authored_metres"),
    lambda p: p["route"]["points"][0].update(x=True),
    lambda p: p["route"]["points"][0].update(y=float("nan")),
    lambda p: p["route"]["points"][0].update(x=-0.1),
    lambda p: p["route"]["points"][0].update(x=1.1),
    lambda p: p["route"].update(checkpoint_index=True),
    lambda p: p["route"].update(map_sha256="0" * 64),
    lambda p: p["route"].update(checkpoint_index=3),
    lambda p: p["route"].update(points=[p["route"]["points"][0]]),
    lambda p: p["route"].update(points=[p["route"]["points"][0]] * 13),
    lambda p: p["route"]["points"].__setitem__(1, p["route"]["points"][0]),
    lambda p: p.update(landmarks=[]),
    lambda p: p.update(landmarks=p["landmarks"] * 3),
    lambda p: p["landmarks"][1].update(id=p["landmarks"][0]["id"]),
    lambda p: p["landmarks"][1].update(label=" MOSSBOUND BOOKSHOP "),
    lambda p: p["landmarks"][0].update(visual="   "),
    lambda p: p["landmarks"][0]["source_rectangle"].update(left=100),
    lambda p: p["landmarks"][0]["source_rectangle"].update(top=90),
    lambda p: p["landmarks"][0]["source_rectangle"].update(width=True),
    lambda p: p["landmarks"][0]["source_rectangle"].update(width=31),
    lambda p: p.update(prompt="   "),
])
def test_strict_profile_rejects_proxy_fields_and_unbound_route(change):
    request = payload()
    change(request)
    with pytest.raises(ValidationError):
        walk.ImageLedInput(**request)


def test_landmark_count_generic_and_route_can_loop():
    request = payload()
    request["landmarks"] = request["landmarks"][:1]
    request["route"]["points"].append(request["route"]["points"][0])
    refresh_intent(request)
    assert len(walk.ImageLedInput(**request).landmarks) == 1


@pytest.mark.parametrize("change", [
    lambda p: p.pop("prior"),
    lambda p: p["prior"].update(checkpoint_index=1),
    lambda p: p["prior"].update(reviewed_sha256="0" * 64),
])
def test_later_view_requires_exact_previous_reviewed_bytes(change):
    request = payload(index=1)
    change(request)
    with pytest.raises(ValidationError):
        walk.ImageLedInput(**request)


@pytest.mark.parametrize("change", [
    lambda p: p.update(reservation=0.16),
    lambda p: p["parameters"].update(seed=43),
    lambda p: p["parameters"].update(num_images=True),
    lambda p: p["parameters"].update(num_images=1.0),
    lambda p: p["parameters"].update(enable_web_search=True),
    lambda p: p["parameters"].update(depth=1),
    lambda p: p["parameters"].update(prompt_version="other"),
])
async def test_config_drift_rejected_before_upload(enabled, monkeypatch, change):
    request = payload()
    change(request)
    monkeypatch.setattr(walk, "to_fal_url", AsyncMock(side_effect=AssertionError("No upload")))
    with pytest.raises(HTTPException) as error:
        await walk.submit(walk.ImageLedInput(**request))
    assert error.value.status_code == 409


@pytest.mark.parametrize("change", [
    lambda p: p["landmarks"][-1]["image"].update(sha256="0" * 64),
    lambda p: p["landmarks"][-1]["image"].update(bytes=1),
    lambda p: p["landmarks"][-1]["image"].update(width=64),
    lambda p: p["landmarks"][-1]["image"].update(url="https://fal.media/image.png"),
    lambda p: p["landmarks"][-1]["image"].update(url="data:image/png;base64,invalid"),
    lambda p: p["landmarks"][-1].update(image=image((48, 32), (20, 40, 60, 0))),
])
async def test_all_images_validated_before_first_upload(enabled, monkeypatch, change):
    request = payload()
    change(request)
    upload = AsyncMock()
    post = AsyncMock()
    monkeypatch.setattr(walk, "to_fal_url", upload)
    monkeypatch.setattr(walk, "post_once", post)
    with pytest.raises(HTTPException) as error:
        await walk.submit(walk.ImageLedInput(**request))
    assert error.value.status_code == 400
    upload.assert_not_awaited()
    post.assert_not_awaited()


def test_reference_rotation_rejected_even_with_rehashed_descriptor():
    exif = Image.Exif()
    exif[274] = 6
    with pytest.raises(HTTPException):
        walk.validate_image(walk.SourceImage(**image(format="JPEG", exif=exif)))


@pytest.mark.parametrize("index,anchor", [(0, False), (0, True), (1, False), (2, False)])
async def test_source_first_or_prior_first_exact_named_inputs(enabled, monkeypatch, index, anchor):
    request = walk.ImageLedInput(**payload(index, anchor))
    uploaded = []

    async def upload(url):
        uploaded.append(url)
        return f"https://fal.media/ref-{len(uploaded)}.png"

    post = AsyncMock(return_value="known-request-id")
    monkeypatch.setattr(walk, "to_fal_url", upload)
    monkeypatch.setattr(walk, "post_once", post)
    result = await walk.submit(request)
    expected = [request.source.url, *(landmark.image.url for landmark in request.landmarks)]
    if request.prior:
        expected.insert(0, request.prior.image.url)
    assert uploaded == expected
    slug, arguments = post.call_args.args
    assert slug == walk.MODEL
    assert len(arguments["image_urls"]) == len(expected)
    assert "prompt_version" not in arguments
    assert not {"depth", "controlnets", "controlnet_unions", "image_size", "mask_url"} & arguments.keys()
    text = arguments["prompt"]
    assert "not texture samples" in text
    assert "not metres or cardinal directions" in text
    for landmark in request.landmarks:
        assert landmark.label in text and landmark.visual in text
    assert "exact saved-camera" not in text and "proxy" not in text
    assert ("immediately preceding owner-reviewed" in text) is bool(index)
    assert result["input_sha256"] == walk.input_fingerprint(request)
    assert result["spatial_validation"] == "unmeasured"
    post.assert_awaited_once()


def test_fingerprint_binds_image_role_route_crop_and_review():
    original = walk.ImageLedInput(**payload(index=1))
    initial = walk.input_fingerprint(original)
    for change in (
        lambda p: p["route"]["points"][1].update(y=0.6),
        lambda p: p["landmarks"][0].update(visual="Different arched bookbay"),
        lambda p: p["landmarks"][0]["source_rectangle"].update(left=1),
        lambda p: p.update(prompt="Different requested illustration medium"),
    ):
        request = payload(index=1)
        change(request)
        refresh_intent(request)
        assert walk.input_fingerprint(walk.ImageLedInput(**request)) != initial


@pytest.mark.parametrize("response", [200, 307, 429, 500, None, "bad-id"])
async def test_one_paid_transport_attempt_no_retry_or_redirect(enabled, monkeypatch, response):
    calls = []
    monkeypatch.setattr(walk, "to_fal_url", AsyncMock(return_value="https://fal.media/ref.png"))

    def handler(request):
        calls.append(request)
        assert str(request.url) == f"https://queue.fal.run/{walk.MODEL}"
        assert request.headers["X-Fal-No-Retry"] == "1"
        assert json.loads(request.content)["num_images"] == 1
        if response is None:
            raise httpx.ReadTimeout("Ambiguous acknowledgment", request=request)
        code = 200 if response == "bad-id" else response
        return httpx.Response(code, json={"request_id": "../../foreign" if response == "bad-id" else "saved-id"},
                              headers={"location": "https://foreign.test"})

    def client(**kwargs):
        assert kwargs["follow_redirects"] is False
        assert kwargs["transport"]._pool._retries == 0
        return HTTPClient(transport=httpx.MockTransport(handler), follow_redirects=False)

    monkeypatch.setattr(walk.httpx, "AsyncClient", client)
    if response == 200:
        assert (await walk.submit(walk.ImageLedInput(**payload())))["request_id"] == "saved-id"
    else:
        with pytest.raises((httpx.HTTPStatusError, httpx.ReadTimeout, HTTPException)):
            await walk.submit(walk.ImageLedInput(**payload()))
    assert len(calls) == 1


@pytest.mark.parametrize("state,expected", [
    (fal_client.Queued(position=1), "queued"), (fal_client.InProgress(logs=[]), "running"),
    (fal_client.Completed(logs=[], metrics={}, error="Failed"), "failed"),
])
async def test_status_never_submits_and_disabled_generation_can_recover(enabled, monkeypatch, state, expected):
    monkeypatch.setenv("IMAGE_LED_WALK_ENABLED", "0")
    status = AsyncMock(return_value=state)
    monkeypatch.setattr(fal_client, "status_async", status)
    monkeypatch.setattr(walk, "post_once", AsyncMock(side_effect=AssertionError("No submit")))
    assert (await walk.status("known-id"))["status"] == expected
    status.assert_awaited_once_with(walk.MODEL, "known-id")


@pytest.mark.parametrize("request_id", ["", "../other", "a" * 101])
async def test_status_rejects_invalid_ids_before_network(enabled, monkeypatch, request_id):
    status = AsyncMock()
    monkeypatch.setattr(fal_client, "status_async", status)
    with pytest.raises(HTTPException) as error:
        await walk.status(request_id)
    assert error.value.status_code == 400
    status.assert_not_awaited()


@pytest.mark.parametrize("result", [
    {}, {"images": []}, {"images": [{"url": "https://fal.media/one.png"}] * 2},
    {"images": [{"url": "https://fal.media/one.png"}], "has_nsfw_concepts": [True]},
    {"images": [{"url": "http://fal.media/one.png"}]},
    {"images": [{"url": "https://fal.media.foreign.test/one.png"}]},
    {"images": [{"url": "https://user@fal.media/one.png"}]},
    {"images": [{"url": "https://fal.media:443/one.png"}]},
])
async def test_result_requires_one_safe_owned_storage_output(enabled, monkeypatch, result):
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(return_value=fal_client.Completed(logs=[], metrics={})))
    monkeypatch.setattr(fal_client, "result_async", AsyncMock(return_value=result))
    metadata = AsyncMock()
    monkeypatch.setattr(walk, "raw_output_metadata", metadata)
    assert (await walk.status("known-id"))["status"] == "failed"
    metadata.assert_not_awaited()


async def test_read_failure_retains_known_id_for_caller_recovery(enabled, monkeypatch):
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(return_value=fal_client.Completed(logs=[], metrics={})))
    monkeypatch.setattr(fal_client, "result_async", AsyncMock(side_effect=httpx.ReadTimeout("Read failed")))
    monkeypatch.setattr(walk, "post_once", AsyncMock(side_effect=AssertionError("No new submission")))
    with pytest.raises(httpx.ReadTimeout):
        await walk.status("same-known-id")


async def test_terminal_provider_failure_is_not_retry(enabled, monkeypatch):
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(return_value=fal_client.Completed(logs=[], metrics={})))
    monkeypatch.setattr(fal_client, "result_async", AsyncMock(side_effect=FalClientHTTPError(
        status_code=422, message="Failed", response_headers={}, response="Failed")))
    assert (await walk.status("known-id"))["status"] == "failed"


@pytest.mark.parametrize("format,opaque,orientation", [("PNG", True, 1), ("JPEG", True, 1), ("PNG", False, 1), ("PNG", True, 6)])
async def test_status_measures_original_raw_bytes_without_dimension_substitution(enabled, monkeypatch, format, opaque, orientation):
    exif = Image.Exif()
    exif[274] = orientation
    encoded = image((160, 90), (80, 100, 120) if opaque else (80, 100, 120, 0), format, exif)
    data = base64.b64decode(encoded["url"].split(",", 1)[1])
    monkeypatch.setattr(fal_client, "status_async", AsyncMock(return_value=fal_client.Completed(logs=[], metrics={})))
    monkeypatch.setattr(fal_client, "result_async", AsyncMock(return_value={"images": [{"url": "https://v3.fal.media/raw.png", "width": 688, "height": 384}]}))

    def client(**kwargs):
        assert kwargs["follow_redirects"] is False
        return HTTPClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, content=data)))

    monkeypatch.setattr(walk.httpx, "AsyncClient", client)
    result = await walk.status("known-id")
    assert result["status"] == "ready"
    assert result["image"]["width"] == 160 and result["image"]["height"] == 90
    assert result["raw_image"]["bytes"] == len(data)
    assert result["raw_image"]["sha256"] == hashlib.sha256(data).hexdigest()
    assert result["raw_image"]["valid"] is (format == "PNG" and opaque and orientation == 1)
    assert result["accepted"] is False and result["spatial_validation"] == "unmeasured"
    assert "normalization" not in result and "gate" not in result


async def test_raw_download_caps_bytes_and_refuses_redirect(monkeypatch):
    for response in (httpx.Response(307, headers={"location": "https://private.test"}),
                     httpx.Response(200, content=b"x" * (walk.MAX_IMAGE_BYTES + 1))):
        calls = []

        def handler(request, calls=calls, response=response):
            calls.append(request)
            return response

        monkeypatch.setattr(walk.httpx, "AsyncClient", lambda **kwargs: HTTPClient(transport=httpx.MockTransport(handler), follow_redirects=False))
        assert (await walk.raw_output_metadata("https://fal.media/raw.png"))["valid"] is False
        assert len(calls) == 1


def test_new_router_registered_and_shared_token_protected(monkeypatch):
    sys.modules.setdefault("modal", MagicMock())
    from fastapi.testclient import TestClient

    from generate import fastapi_app

    monkeypatch.setenv("SHARED_TOKEN", "image-led-test")
    monkeypatch.setenv("IMAGE_LED_WALK_ENABLED", "0")
    client = TestClient(fastapi_app)
    for method, path in (("GET", "/image-led-walk/capabilities"), ("POST", "/image-led-walk/generate"), ("GET", "/image-led-walk/requests/known-id"),
                         ("GET", "/image-led-walk/video/capabilities"), ("POST", "/image-led-walk/video/generate"), ("GET", "/image-led-walk/video/requests/known-id")):
        assert client.request(method, path).status_code == 401
    response = client.get("/image-led-walk/capabilities", headers={"x-openflipbook-token": "image-led-test"})
    assert response.status_code == 200
    assert response.json()["enabled"] is False


def video_payload():
    still = payload()
    return {
        "profile": walk.PROFILE, "model": walk.VIDEO_MODEL, "reservation": 0.4,
        "parameters": copy.deepcopy(walk.VIDEO_PARAMETERS), "prompt": still["prompt"],
        "source_sha256": still["source"]["sha256"], "route": still["route"],
        "route_intent": still["route_intent"],
        "landmarks": [{key: ref[key] for key in ("id", "label", "visual")} for ref in still["landmarks"]],
        "start": image((160, 90), (120, 90, 50)), "end": image((160, 90), (130, 90, 50)),
    }


@pytest.mark.parametrize("kind", ["still", "video"])
@pytest.mark.parametrize("labels", [("Bookshop", "ＢＯＯＫＳＨＯＰ"), ("  Inn ", "INN")])  # noqa: RUF001 - intentional NFKC test
def test_normalized_duplicate_names_match_web_preflight(kind, labels):
    request = payload() if kind == "still" else video_payload()
    request["landmarks"][0]["label"], request["landmarks"][1]["label"] = labels
    refresh_intent(request)
    schema = walk.ImageLedInput if kind == "still" else walk.ImageLedVideoInput
    with pytest.raises(ValidationError):
        schema(**request)


@pytest.mark.parametrize("kind", ["still", "video"])
def test_distinct_unicode_spelling_is_not_casefolded_after_web_quote(kind):
    request = payload() if kind == "still" else video_payload()
    request["landmarks"][0]["label"] = "Straße"
    request["landmarks"][1]["label"] = "STRASSE"
    refresh_intent(request)
    schema = walk.ImageLedInput if kind == "still" else walk.ImageLedVideoInput
    assert schema(**request).landmarks[0].label == "Straße"


@pytest.fixture
def video_enabled(enabled, monkeypatch):
    monkeypatch.setenv("MOTION_CALIBRATION_ENABLED", "1")
    monkeypatch.setenv("MOTION_RESERVATION_USD_PER_SECOND", "0.08")


@pytest.mark.parametrize("key", ["IMAGE_LED_WALK_ENABLED", "MOTION_CALIBRATION_ENABLED", "MOTION_RESERVATION_USD_PER_SECOND", "SHARED_TOKEN", "FAL_KEY"])
async def test_video_requires_independent_existing_motion_quote(video_enabled, monkeypatch, key):
    monkeypatch.delenv(key)
    monkeypatch.setattr(walk, "to_fal_url", AsyncMock(side_effect=AssertionError("No upload")))
    assert walk.video_configuration()["enabled"] is False
    with pytest.raises(HTTPException) as error:
        await walk.submit_video(walk.ImageLedVideoInput(**video_payload()))
    assert error.value.status_code == 503


async def test_video_quote_is_operator_rate_times_five_not_live_price(video_enabled, monkeypatch):
    assert (await walk.video_capabilities())["reservation"] == 0.4
    monkeypatch.setenv("MOTION_RESERVATION_USD_PER_SECOND", "0.10")
    assert walk.video_configuration()["reservation"] == 0.5
    monkeypatch.setattr(walk, "to_fal_url", AsyncMock(side_effect=AssertionError("No upload")))
    with pytest.raises(HTTPException) as error:
        await walk.submit_video(walk.ImageLedVideoInput(**video_payload()))
    assert error.value.status_code == 409


@pytest.mark.parametrize("change", [
    lambda p: p.update(source_sha256="0" * 64),
    lambda p: p.update(forward_m=4),
    lambda p: p.update(depth="fake"),
    lambda p: p.update(move={"forward_m": 0}),
    lambda p: p["route"].update(checkpoint_index=2),
    lambda p: p["route"]["points"].__setitem__(1, p["route"]["points"][0]),
    lambda p: p["end"].update(width=688),
    lambda p: p.update(end=p["start"]),
    lambda p: p["end"].update(bytes=walk.camera_motion.MAX_SOURCE_BYTES + 1),
    lambda p: p["landmarks"][0].update(label="   "),
    lambda p: p["landmarks"][1].update(id="bookshop"),
])
def test_video_rejects_unbound_or_fabricated_geometry_inputs(change):
    request = video_payload()
    change(request)
    with pytest.raises(ValidationError):
        walk.ImageLedVideoInput(**request)


@pytest.mark.parametrize("change", [
    lambda p: p["parameters"].update(duration=10),
    lambda p: p["parameters"].update(resolution="1080P"),
    lambda p: p["parameters"].update(prompt_expansion_mode="balanced"),
    lambda p: p["parameters"].update(prompt_expansion_mode="quality"),
    lambda p: p["parameters"].update(prompt_version="image-led-walk-video-v2"),
    lambda p: p["parameters"].update(prompt_version="image-led-walk-video-v2", prompt_expansion_mode="balanced"),
    lambda p: p["parameters"].update(enable_safety_checker=False),
    lambda p: p["parameters"].update(sync_mode=True),
    lambda p: p["parameters"].update(duration=True),
    lambda p: p["parameters"].update(camera_trajectory=[]),
])
async def test_video_exact_profile_rejected_before_upload(video_enabled, monkeypatch, change):
    request = video_payload()
    change(request)
    upload = AsyncMock(side_effect=AssertionError("No upload"))
    post = AsyncMock(side_effect=AssertionError("No paid POST"))
    monkeypatch.setattr(walk, "to_fal_url", upload)
    monkeypatch.setattr(walk, "post_once", post)
    with pytest.raises(HTTPException) as error:
        await walk.submit_video(walk.ImageLedVideoInput(**request))
    assert error.value.status_code == 409
    upload.assert_not_awaited()
    post.assert_not_awaited()


async def test_video_validates_both_exact_endpoint_bytes_before_upload(video_enabled, monkeypatch):
    request = video_payload()
    request["end"]["sha256"] = "0" * 64
    monkeypatch.setattr(walk, "to_fal_url", AsyncMock(side_effect=AssertionError("No upload")))
    with pytest.raises(HTTPException) as error:
        await walk.submit_video(walk.ImageLedVideoInput(**request))
    assert error.value.status_code == 400


async def test_video_single_h3_submission_only_exact_first_last_and_architecture(video_enabled, monkeypatch):
    request = walk.ImageLedVideoInput(**video_payload())
    uploads = []

    async def upload(url):
        uploads.append(url)
        return f"https://fal.media/endpoint-{len(uploads)}.png"

    post = AsyncMock(return_value="known-video-id")
    monkeypatch.setattr(walk, "to_fal_url", upload)
    monkeypatch.setattr(walk, "post_once", post)
    result = await walk.submit_video(request)
    assert uploads == [request.start.url, request.end.url]
    slug, arguments = post.call_args.args
    assert slug == "minimax/h3-max/image-to-video"
    assert arguments["image_url"] == "https://fal.media/endpoint-1.png"
    assert arguments["end_image_url"] == "https://fal.media/endpoint-2.png"
    assert arguments["duration"] == 5 and arguments["resolution"] == "768P"
    assert arguments["prompt_expansion_mode"] == "disabled"
    assert arguments["enable_safety_checker"] is True and arguments["sync_mode"] is False
    assert not {"camera_trajectory", "forward_m", "move", "prompt_version", "depth", "objects"} & arguments.keys()
    assert "must not swap positions" in arguments["prompt"]
    assert "moth emblem" in arguments["prompt"] and "open orange hearth" in arguments["prompt"]
    assert result["spatial_validation"] == "unmeasured"
    assert result["prompt_version"] == "image-led-walk-video-v3"
    post.assert_awaited_once()


async def test_video_ambiguous_ack_is_never_automatically_submitted_again(video_enabled, monkeypatch):
    monkeypatch.setattr(walk, "to_fal_url", AsyncMock(return_value="https://fal.media/frame.png"))
    post = AsyncMock(side_effect=httpx.ReadTimeout("Unknown acknowledgment"))
    monkeypatch.setattr(walk, "post_once", post)
    with pytest.raises(httpx.ReadTimeout):
        await walk.submit_video(walk.ImageLedVideoInput(**video_payload()))
    post.assert_awaited_once()


async def test_video_status_only_reads_fixed_leg_and_keeps_unaccepted_metadata(monkeypatch):
    # Historical balanced/v2 requests remain readable even when new submits are off.
    monkeypatch.setenv("IMAGE_LED_WALK_ENABLED", "0")
    monkeypatch.delenv("FAL_KEY", raising=False)
    saved = {"status": "ready", "video": {"url": "https://fal.media/clip.mp4", "content_type": "video/mp4"}, "audio_status": "unverified"}
    status = AsyncMock(return_value=saved)
    monkeypatch.setattr(walk.camera_motion, "status", status)
    monkeypatch.setattr(walk, "post_once", AsyncMock(side_effect=AssertionError("No submit")))
    result = await walk.video_status("same-known-id")
    status.assert_awaited_once_with("same-known-id", model="leg")
    assert result["video"] == saved["video"]
    assert result["accepted"] is False and result["temporal_validation"] == "owner_review_required"


def test_curved_oblique_route_uses_original_pixel_aspect_and_ends_before_landmark():
    # Independent route evidence from the original 2048x1152 illustration.
    pixels = [(940, 900), (1020, 815), (1060, 720), (1070, 630), (1050, 545), (1030, 465)]
    route = walk.Route(frame="original-image-normalized", map_sha256="a" * 64, checkpoint_index=5,
                       points=[{"x": x / 2048, "y": y / 1152} for x, y in pixels])
    landmarks = [walk.LandmarkIdentity(id="fountain", label="Fountain", visual="Original sculpted fountain"),
                 walk.LandmarkIdentity(id="well", label="Well", visual="Original roofed well")]
    anchors = [walk.RoutePoint(x=1000 / 2048, y=250 / 1152), walk.RoutePoint(x=1310 / 2048, y=750 / 1152)]
    intent = walk.build_route_intent(route, "a" * 64, 2048, 1152, landmarks, anchors)
    rows = intent["checkpoints"]
    assert [row["heading_degrees"] for row in rows] == [43.264295, 22.833654, 6.340192, 346.75948, 345.963757, 345.963757]
    assert [row["turn"] for row in rows] == ["start", "left", "left", "left", "continue", "end"]
    assert [ref["sector"] for ref in rows[0]["landmark_relations"]] == ["ahead_left", "ahead_right"]
    assert rows[-1]["landmark_relations"][0]["sector"] != "at_checkpoint"
    assert rows[-1]["point"] == {"x": 1030 / 2048, "y": 465 / 1152}
    walk.validate_route_intent(walk.RouteIntent(**intent), route, "a" * 64, landmarks)


def test_route_intent_short_turn_across_image_up_and_exact_checkpoint():
    route = walk.Route(frame="original-image-normalized", map_sha256="a" * 64, checkpoint_index=1,
                       points=[{"x": 0.5, "y": 0.9}, {"x": 0.49, "y": 0.6}, {"x": 0.5, "y": 0.3}])
    landmark = walk.LandmarkIdentity(id="well", label="Well", visual="Roofed well")
    intent = walk.build_route_intent(route, "a" * 64, 2048, 1152, [landmark], [route.points[1]])
    rows = intent["checkpoints"]
    assert rows[0]["heading_degrees"] > 350
    assert rows[1]["turn"] == "right" and 0 < rows[1]["turn_from_previous_degrees"] < 10
    assert rows[1]["landmark_relations"][0]["sector"] == "at_checkpoint"
    assert rows[-1]["heading_degrees"] == rows[1]["heading_degrees"]
    assert rows[-1]["turn"] == "end"
    diagonal = walk.Route(frame="original-image-normalized", map_sha256="a" * 64, checkpoint_index=0,
                          points=[{"x": 0.1, "y": 0.9}, {"x": 0.5, "y": 0.5}])
    first = walk.build_route_intent(diagonal, "a" * 64, 2048, 1152, [landmark], [route.points[1]])["checkpoints"][0]
    assert first["heading_degrees"] == pytest.approx(math.degrees(math.atan2(2048, 1152)), abs=1e-6)
    assert first["heading_degrees"] != 45


def test_angle_rounding_matches_javascript_negative_half_and_delta_wrap():
    assert walk._round_angle(-0.0000015) == -0.000001
    assert walk._round_angle(-1.0000005) == -1.000001  # IEEE input lies below the tie in both runtimes.
    assert walk._round_angle(1.0000005) == 1.000001
    assert walk._angle_delta(walk._round_angle(179.9999998)) == -180


@pytest.mark.parametrize("kind", ["still", "video"])
@pytest.mark.parametrize("change", [
    lambda p: p.pop("route_intent"),
    lambda p: p["route_intent"].update(version=True),
    lambda p: p["route_intent"].update(basis="authored_metres"),
    lambda p: p["route_intent"].update(registration="verified"),
    lambda p: p["route_intent"].update(source_sha256="0" * 64),
    lambda p: p["route_intent"].update(checkpoint_index=1),
    lambda p: p["route_intent"].update(camera={"yaw": 0}),
    lambda p: p["route_intent"].update(checkpoints=p["route_intent"]["checkpoints"][:2]),
    lambda p: p["route_intent"]["checkpoints"][1].update(index=2),
    lambda p: p["route_intent"]["checkpoints"][1]["point"].update(x=0.51),
    lambda p: p["route_intent"]["checkpoints"][1].update(heading_degrees=45),
    lambda p: p["route_intent"]["checkpoints"][1].update(turn_from_previous_degrees=30),
    lambda p: p["route_intent"]["checkpoints"][1].update(turn="right"),
    lambda p: p["route_intent"]["checkpoints"][1].update(landmark_relations=p["route_intent"]["checkpoints"][1]["landmark_relations"][:1]),
    lambda p: p["route_intent"]["checkpoints"][1]["landmark_relations"][0].update(id="forge"),
    lambda p: p["route_intent"]["checkpoints"][1]["landmark_relations"][0].update(label="Different building"),
    lambda p: p["route_intent"]["checkpoints"][1]["landmark_relations"][0]["anchor"].update(x=0.9),
    lambda p: p["route_intent"]["checkpoints"][1]["landmark_relations"][0].update(relative_bearing_degrees=0),
    lambda p: p["route_intent"]["checkpoints"][1]["landmark_relations"][0].update(sector="at_checkpoint"),
])
def test_route_intent_tampering_cannot_reach_upload_or_paid_submission(monkeypatch, kind, change):
    request = payload() if kind == "still" else video_payload()
    change(request)
    upload, post = AsyncMock(), AsyncMock()
    monkeypatch.setattr(walk, "to_fal_url", upload)
    monkeypatch.setattr(walk, "post_once", post)
    with pytest.raises(ValidationError):
        (walk.ImageLedInput if kind == "still" else walk.ImageLedVideoInput)(**request)
    upload.assert_not_awaited()
    post.assert_not_awaited()


@pytest.mark.parametrize("change", [
    lambda p: p["route_intent"]["map_dimensions"].update(width=256),
    lambda p: p["route_intent"]["checkpoints"][0]["landmark_relations"][0]["anchor"].update(x=0.5),
])
def test_still_intent_is_bound_to_original_dimensions_and_whole_building_centroid(change):
    request = payload()
    change(request)
    with pytest.raises(ValidationError):
        walk.ImageLedInput(**request)


def test_video_recomputes_aspect_and_preserves_each_unmeasured_shared_anchor():
    request = video_payload()
    request["route"]["points"][1]["x"] = 0.7
    refresh_intent(request)
    walk.ImageLedVideoInput(**request)
    # Video has no original map/crop pixels: it checks the supplied source-plane
    # dimensions and stable anchors, without claiming physical registration.
    request["route_intent"]["map_dimensions"]["width"] = 256
    with pytest.raises(ValidationError):
        walk.ImageLedVideoInput(**request)


def test_numeric_noise_tolerance_does_not_change_local_sectors_or_source_association():
    request = payload()
    request["route_intent"]["checkpoints"][1]["heading_degrees"] += 0.000001
    request["route_intent"]["checkpoints"][1]["landmark_relations"][0]["relative_bearing_degrees"] += 0.000001
    walk.ImageLedInput(**request)
    request["route_intent"]["checkpoints"][1]["heading_degrees"] += 0.0001
    with pytest.raises(ValidationError):
        walk.ImageLedInput(**request)


@pytest.mark.parametrize("kind,version", [("still", "image-led-walk-v1"), ("still", "image-led-walk-v2"), ("video", "image-led-walk-video-v1")])
async def test_older_post_parameters_rejected_without_new_submit_but_known_status_is_unchanged(video_enabled, monkeypatch, kind, version):
    request = payload() if kind == "still" else video_payload()
    request["parameters"]["prompt_version"] = version
    upload, post = AsyncMock(), AsyncMock()
    monkeypatch.setattr(walk, "to_fal_url", upload)
    monkeypatch.setattr(walk, "post_once", post)
    with pytest.raises(HTTPException) as error:
        await (walk.submit(walk.ImageLedInput(**request)) if kind == "still" else walk.submit_video(walk.ImageLedVideoInput(**request)))
    assert error.value.status_code == 409
    upload.assert_not_awaited()
    post.assert_not_awaited()
    if kind == "still":
        monkeypatch.setenv("IMAGE_LED_WALK_ENABLED", "0")
        status = AsyncMock(return_value=fal_client.Queued(position=0))
        monkeypatch.setattr(fal_client, "status_async", status)
        assert (await walk.status("known-v1-id"))["status"] == "queued"
        status.assert_awaited_once_with(walk.MODEL, "known-v1-id")
    else:
        monkeypatch.setenv("MOTION_CALIBRATION_ENABLED", "0")
        status = AsyncMock(return_value={"status": "running"})
        monkeypatch.setattr(walk.camera_motion, "status", status)
        assert (await walk.video_status("known-v1-id"))["status"] == "running"
        status.assert_awaited_once_with("known-v1-id", model="leg")


def test_prompt_explains_local_turn_and_surroundings_without_forcing_arrival_or_visibility():
    request = payload(index=1)
    request["route"]["points"] = [{"x": 0.5, "y": 0.9}, {"x": 0.5, "y": 0.7}, {"x": 0.3, "y": 0.5}]
    refresh_intent(request)
    body = walk.ImageLedInput(**request)
    local = json.loads(walk.route_intent_prompt(body.route_intent).split("pixels: ", 1)[1].split(". Headings", 1)[0])
    assert local["current"]["turn"] == "left"
    assert local["current"]["point"] == body.route.points[1].model_dump()
    text = walk.image_led_prompt(body)
    assert "not cardinal directions, calibrated camera angles, distances or inferred visibility" in text
    assert "does not assert arrival at a fountain" in text
    assert "well's location and roof, terrace corners" in text
    assert "fountain's actual sculpture and basin arrangement" in text
    assert "compact faceted conservatory" in text
    video = walk.ImageLedVideoInput(**video_payload())
    local_video = walk.route_intent_prompt(video.route_intent, video=True)
    assert '"next":' in local_video
    assert '"index":1' in local_video


def test_source_geometry_overrides_generic_appearance_in_v4_prompt():
    request = payload()
    request["landmarks"][0]["visual"] = "A domed glasshouse with glowing windows"
    text = walk.image_led_prompt(walk.ImageLedInput(**request))
    assert walk.PARAMETERS["prompt_version"] == "image-led-walk-v4"
    assert '"appearance_hint":"A domed glasshouse with glowing windows"' in text
    assert "distinctive_architecture" not in text
    assert "original artwork and its building crops override generic appearance hints" in text
    assert "open work bays versus closed doors" in text
    assert "glass-roof brace junctions connected to the same wall bays" in text
    assert "crown, supports, dish count and ground pool" in text
    assert "Features hidden in the original remain unknown" in text
