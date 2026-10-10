"""Street-image movement is an explicit, fixed-cost branch; all providers are mocked."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient

import generate
from providers import camera_motion, llm, spend, video


@pytest.fixture(autouse=True)
def isolated(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("SHARED_TOKEN", raising=False)
    monkeypatch.delenv("MAX_DAILY_SPEND", raising=False)
    monkeypatch.delenv("MAX_SESSION_SPEND", raising=False)
    monkeypatch.setattr(generate, "_rate_limited", lambda _req: None)
    spend.reset_for_tests()
    yield
    spend.reset_for_tests()


def request_body(direction: str = "forward", **changes):
    return {"image_data_url": "data:image/png;base64,AAAA", "prompt": "Current fantasy street",
            "session_id": "street-session", "street_walk": {"direction": direction}, **changes}


@pytest.mark.parametrize("direction", ["forward", "left", "right"])
async def test_provider_pins_source_only_h3_and_ignores_other_model_slots(monkeypatch, direction):
    monkeypatch.setenv("FAL_KEY", "test-key")
    monkeypatch.setenv("SHARED_TOKEN", "test-token")
    monkeypatch.setenv("MOCK_PROVIDERS", "0")
    for name in ("FAL_ANIMATE_MODEL", "FAL_DESCENT_MODEL", "FAL_ACTION_MODEL", "FAL_VIDEO_TIER_BALANCED"):
        monkeypatch.setenv(name, "unsupported/override")
    upload = AsyncMock(return_value="https://fal.media/current-street.png")
    submit = AsyncMock(return_value="saved-provider-request")
    status = AsyncMock(return_value={"status": "ready", "video": {"url": "https://fal.media/walk.mp4", "content_type": "video/mp4"}})
    retrying = AsyncMock(side_effect=AssertionError("Retrying transport must not be used"))
    monkeypatch.setattr(video, "to_fal_url", upload)
    monkeypatch.setattr(camera_motion, "post_once", submit)
    monkeypatch.setattr(camera_motion, "status", status)
    monkeypatch.setattr(video, "_fal_subscribe", retrying)
    clip = await video.animate_street_walk(image_data_url="current-street-bytes", direction=direction)
    upload.assert_awaited_once_with("current-street-bytes")
    submit.assert_awaited_once_with(video.H3_MAX_MODEL, {
        "image_url": "https://fal.media/current-street.png", "prompt": video.street_walk_prompt(direction),
        "duration": 5, "resolution": "768P", "prompt_expansion_mode": "balanced", "enable_safety_checker": True,
    })
    assert clip.model == "minimax/h3-max/image-to-video"
    assert clip.duration_seconds == 5
    assert clip.provider_request_id == "saved-provider-request"
    status.assert_awaited_once_with("saved-provider-request", model="leg")
    retrying.assert_not_awaited()
    assert video.street_walk_estimate_usd() == pytest.approx(0.40)


def test_forward_prompt_requests_translation_and_ground_parallax():
    prompt = video.street_walk_prompt("forward")
    assert "camera physically translates through the lane" in prompt
    assert "parallax" in prompt and "ground revealed" in prompt
    assert "supplied street image" in prompt and "First-person" in prompt
    assert "facades" in prompt and "weather" in prompt
    assert "No zoom" in prompt and "no aerial view" in prompt and "no cut" in prompt
    assert "turn gradually" not in prompt


@pytest.mark.parametrize("direction", ["left", "right"])
def test_turn_prompts_rotate_in_place_at_eye_height(direction):
    prompt = video.street_walk_prompt(direction)
    assert f"turn gradually to the {direction} at eye height" in prompt
    assert "Standing in the same spot" in prompt and "without walking forward" in prompt
    assert "camera physically translates" not in prompt


async def test_mock_street_walk_never_submits(monkeypatch):
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    submit = AsyncMock()
    monkeypatch.setattr(camera_motion, "post_once", submit)
    clip = await video.animate_street_walk(image_data_url="street", direction="forward")
    assert clip.model == "mock/street-walk"
    submit.assert_not_awaited()


async def test_missing_key_fails_before_upload_or_submission(monkeypatch):
    upload, submit = AsyncMock(), AsyncMock()
    monkeypatch.setattr(video, "to_fal_url", upload)
    monkeypatch.setattr(camera_motion, "post_once", submit)
    with pytest.raises(RuntimeError, match="FAL_KEY"):
        await video.animate_street_walk(image_data_url="street", direction="forward")
    upload.assert_not_awaited()
    submit.assert_not_awaited()


async def test_known_request_is_polled_without_new_submission(monkeypatch):
    monkeypatch.setenv("FAL_KEY", "test-key")
    monkeypatch.setenv("SHARED_TOKEN", "test-token")
    submit = AsyncMock(return_value="original-request")
    status = AsyncMock(side_effect=[{"status": "queued"}, {"status": "running"},
                                   {"status": "ready", "video": {"url": "https://fal.media/walk.mp4"}}])
    monkeypatch.setattr(video, "to_fal_url", AsyncMock(return_value="https://fal.media/street.png"))
    monkeypatch.setattr(camera_motion, "post_once", submit)
    monkeypatch.setattr(camera_motion, "status", status)
    monkeypatch.setattr(video.asyncio, "sleep", AsyncMock())
    clip = await video.animate_street_walk(image_data_url="street", direction="forward")
    assert clip.provider_request_id == "original-request"
    assert submit.await_count == 1 and status.await_count == 3
    assert all(call.args == ("original-request",) for call in status.await_args_list)


async def test_read_error_keeps_known_provider_identity_without_resubmission(monkeypatch):
    monkeypatch.setenv("FAL_KEY", "test-key")
    monkeypatch.setenv("SHARED_TOKEN", "test-token")
    submit = AsyncMock(return_value="paid-request")
    monkeypatch.setattr(video, "to_fal_url", AsyncMock(return_value="https://fal.media/street.png"))
    monkeypatch.setattr(camera_motion, "post_once", submit)
    monkeypatch.setattr(camera_motion, "status", AsyncMock(side_effect=ConnectionResetError("read failed")))
    with pytest.raises(video.StreetWalkProviderError, match="do not submit another") as failure:
        await video.animate_street_walk(image_data_url="street", direction="forward")
    assert failure.value.provider_request_id == "paid-request"
    assert submit.await_count == 1


async def test_ambiguous_submit_is_not_retried(monkeypatch):
    monkeypatch.setenv("FAL_KEY", "test-key")
    monkeypatch.setenv("SHARED_TOKEN", "test-token")
    monkeypatch.setenv("IMAGE_SUBMIT_MAX_ATTEMPTS", "3")
    submit = AsyncMock(side_effect=ConnectionResetError("unknown submission"))
    status = AsyncMock()
    monkeypatch.setattr(video, "to_fal_url", AsyncMock(return_value="https://fal.media/street.png"))
    monkeypatch.setattr(camera_motion, "post_once", submit)
    monkeypatch.setattr(camera_motion, "status", status)
    with pytest.raises(ConnectionResetError, match="unknown submission"):
        await video.animate_street_walk(image_data_url="street", direction="forward")
    assert submit.await_count == 1
    status.assert_not_awaited()


async def test_missing_shared_token_fails_before_paying_for_unrecoverable_request(monkeypatch):
    monkeypatch.setenv("FAL_KEY", "test-key")
    submit = AsyncMock()
    monkeypatch.setattr(camera_motion, "post_once", submit)
    with pytest.raises(RuntimeError, match="SHARED_TOKEN"):
        await video.animate_street_walk(image_data_url="street", direction="forward")
    submit.assert_not_awaited()


@pytest.mark.parametrize("direction", ["forward", "left", "right"])
def test_endpoint_bypasses_both_legacy_provider_and_ambient_rewriter(monkeypatch, direction):
    legacy, rewrite = AsyncMock(side_effect=AssertionError("legacy branch")), AsyncMock(side_effect=AssertionError("ambient rewrite"))
    submit = AsyncMock(return_value=video.AnimatedClip("https://fal.media/walk.mp4", "video/mp4", video.H3_MAX_MODEL, 5))
    monkeypatch.setattr(video, "animate_image", legacy)
    monkeypatch.setattr(video, "animate_street_walk", submit)
    monkeypatch.setattr(llm, "rewrite_motion_prompt", rewrite)
    response = TestClient(generate.fastapi_app).post("/animate", json=request_body(direction))
    assert response.status_code == 200
    assert response.json()["model"] == video.H3_MAX_MODEL
    assert response.json()["duration_seconds"] == 5
    submit.assert_awaited_once_with(image_data_url="data:image/png;base64,AAAA", direction=direction)
    rewrite.assert_not_awaited()
    legacy.assert_not_awaited()
    assert spend.session_total("street-session") == pytest.approx(0.40)


@pytest.mark.parametrize("changes", [
    {"end_image_data_url": "data:image/png;base64,BBBB"}, {"end_image_data_url": ""},
    {"focus": {"subject": "shop", "x_pct": .5, "y_pct": .5}},
    {"duration": 4}, {"duration": 6}, {"duration": 0},
    {"video_tier": "fast"}, {"video_tier": "pro"},
    {"street_walk": {"direction": "back"}}, {"street_walk": {"direction": "left", "distance": 20}},
])
def test_invalid_street_intent_fails_validation_before_any_spend(monkeypatch, changes):
    submit = AsyncMock()
    monkeypatch.setattr(video, "animate_street_walk", submit)
    response = TestClient(generate.fastapi_app).post("/animate", json=request_body(**changes))
    assert response.status_code == 422
    assert spend.session_total("street-session") == 0
    submit.assert_not_awaited()


def test_street_walk_spend_cap_stops_before_provider(monkeypatch):
    monkeypatch.setenv("MAX_SESSION_SPEND", "0.39")
    submit = AsyncMock()
    monkeypatch.setattr(video, "animate_street_walk", submit)
    response = TestClient(generate.fastapi_app).post("/animate", json=request_body())
    assert response.status_code == 502
    assert "Session spend cap" in response.json()["error"]
    submit.assert_not_awaited()


def test_failed_paid_street_clip_keeps_reservation_and_returns_error(monkeypatch):
    submit = AsyncMock(side_effect=RuntimeError("Provider failure"))
    monkeypatch.setattr(video, "animate_street_walk", submit)
    response = TestClient(generate.fastapi_app).post("/animate", json=request_body())
    assert response.status_code == 502
    assert json.loads(response.content)["stage"] == "fal_animate"
    assert "Provider failure" in response.json()["error"]
    assert spend.session_total("street-session") == pytest.approx(0.40)


def test_endpoint_returns_known_provider_request_for_free_recovery(monkeypatch):
    monkeypatch.setattr(video, "animate_street_walk", AsyncMock(
        side_effect=video.StreetWalkProviderError("known-paid-id", "result remains unresolved")))
    response = TestClient(generate.fastapi_app).post("/animate", json=request_body())
    assert response.status_code == 502
    assert response.json()["provider_request_id"] == "known-paid-id"
    assert spend.session_total("street-session") == pytest.approx(0.40)


def test_recovery_endpoint_only_reads_the_retained_h3_request(monkeypatch):
    monkeypatch.setenv("FAL_KEY", "test-key")
    monkeypatch.setenv("SHARED_TOKEN", "test-token")
    submit = AsyncMock(side_effect=AssertionError("Recovery must not submit"))
    status = AsyncMock(return_value={"status": "ready", "video": {"url": "https://fal.media/existing-walk.mp4"}})
    reserve = Mock(side_effect=AssertionError("Recovery must not reserve spend"))
    monkeypatch.setattr(camera_motion, "post_once", submit)
    monkeypatch.setattr(camera_motion, "status", status)
    monkeypatch.setattr(spend, "reserve", reserve)
    response = TestClient(generate.fastapi_app).post("/street-walk/recover",
        json={"provider_request_id": "already-paid-id"}, headers={"x-openflipbook-token": "test-token"})
    assert response.status_code == 200
    result = response.json()
    assert result["provider_request_id"] == "already-paid-id"
    assert result["model"] == "minimax/h3-max/image-to-video"
    assert result["duration_seconds"] == 5 and result["content_type"] == "video/mp4"
    assert result["video_url"] == "https://fal.media/existing-walk.mp4"
    status.assert_awaited_once_with("already-paid-id", model="leg")
    submit.assert_not_awaited()
    reserve.assert_not_called()


@pytest.mark.parametrize("body", [
    {}, {"provider_request_id": ""}, {"provider_request_id": "../another-model"},
    {"provider_request_id": "x" * 101}, {"provider_request_id": 123},
    {"provider_request_id": "paid-id", "image_data_url": "new-source"},
    {"provider_request_id": "paid-id", "direction": "forward"},
    {"provider_request_id": "paid-id", "model": "other-model"},
])
def test_recovery_refuses_generation_fields_and_invalid_request_identity(monkeypatch, body):
    recover = AsyncMock()
    monkeypatch.setattr(video, "recover_street_walk", recover)
    response = TestClient(generate.fastapi_app).post("/street-walk/recover", json=body)
    assert response.status_code == 422
    recover.assert_not_awaited()


def test_unresolved_recovery_returns_original_request_and_spends_nothing(monkeypatch):
    monkeypatch.setenv("FAL_KEY", "test-key")
    monkeypatch.setenv("SHARED_TOKEN", "test-token")
    submit = AsyncMock(side_effect=AssertionError("No retry submission"))
    monkeypatch.setattr(camera_motion, "post_once", submit)
    monkeypatch.setattr(camera_motion, "status", AsyncMock(side_effect=ConnectionResetError("status read failed")))
    response = TestClient(generate.fastapi_app).post("/street-walk/recover",
        json={"provider_request_id": "retained-paid-id"}, headers={"x-openflipbook-token": "test-token"})
    assert response.status_code == 502
    assert response.json()["provider_request_id"] == "retained-paid-id"
    assert "do not submit another" in response.json()["error"]
    assert spend.daily_total() == 0
    submit.assert_not_awaited()


def test_recovery_keeps_shared_token_boundary(monkeypatch):
    monkeypatch.setenv("SHARED_TOKEN", "test-token")
    recover = AsyncMock()
    monkeypatch.setattr(video, "recover_street_walk", recover)
    response = TestClient(generate.fastapi_app).post("/street-walk/recover", json={"provider_request_id": "known-paid-id"})
    assert response.status_code == 401
    recover.assert_not_awaited()
