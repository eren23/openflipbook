"""Unit tests for providers.image.

Covers the resolution helpers (tier, model, args) and the retry classifier
(_is_retryable). The fal_client.subscribe_async path is exercised by
mocking fal_client at the module level so no network hits are made.
"""

from __future__ import annotations

import fal_client
import httpx
import pytest

from providers import image


def test_resolve_tier_default_when_unset() -> None:
    assert image._resolve_tier(None) == image.DEFAULT_TIER


def test_resolve_tier_invalid_falls_back() -> None:
    assert image._resolve_tier("ultra") == image.DEFAULT_TIER


def test_resolve_tier_explicit_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAL_IMAGE_TIER", "fast")
    assert image._resolve_tier("pro") == "pro"  # arg beats env


def test_resolve_tier_env_when_no_arg(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAL_IMAGE_TIER", "fast")
    assert image._resolve_tier(None) == "fast"


def test_resolve_model_explicit_override_short_circuits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FAL_IMAGE_MODEL_PRO", "fal-ai/some-other")
    out = image._resolve_model("pro", model_override="custom/slug")
    assert out == "custom/slug"


def test_resolve_model_uses_per_tier_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAL_IMAGE_MODEL_BALANCED", "fal-ai/custom-balanced")
    assert image._resolve_model("balanced", None) == "fal-ai/custom-balanced"


def test_resolve_model_legacy_env_falls_through() -> None:
    """No per-tier env, no override → legacy env or built-in default."""
    out = image._resolve_model("balanced", None)
    assert out == image.TIER_MODELS["balanced"]


def test_resolve_model_legacy_env_used_for_unset_tier(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FAL_IMAGE_MODEL", "fal-ai/legacy-slug")
    # Per-tier env is unset; legacy should win over the built-in default.
    out = image._resolve_model("fast", None)
    assert out == "fal-ai/legacy-slug"


def test_args_for_seedream_uses_image_size() -> None:
    args = image._args_for("fal-ai/bytedance/seedream/v4/text-to-image", "p", "16:9")
    assert args["image_size"] == "landscape_16_9"
    assert "aspect_ratio" not in args


def test_args_for_seedream_unknown_aspect_falls_back() -> None:
    args = image._args_for("fal-ai/bytedance/seedream/v4/text-to-image", "p", "weird")
    assert args["image_size"] == "landscape_16_9"


def test_args_for_nano_banana_passes_aspect() -> None:
    args = image._args_for("fal-ai/nano-banana", "hello", "9:16")
    assert args == {"prompt": "hello", "aspect_ratio": "9:16"}


def test_first_image_extracts_first_dict() -> None:
    assert image._first_image({"images": [{"url": "x"}, {"url": "y"}]}) == {"url": "x"}


def test_first_image_raises_when_empty() -> None:
    with pytest.raises(RuntimeError, match="no images"):
        image._first_image({"images": []})


def test_first_image_raises_when_malformed() -> None:
    with pytest.raises(RuntimeError, match="malformed"):
        image._first_image({"images": ["not-a-dict"]})


def test_encode_data_url_round_trip() -> None:
    out = image.encode_data_url(b"hello", mime_type="image/png")
    assert out.startswith("data:image/png;base64,")
    assert out.endswith("aGVsbG8=")


def test_ensure_fal_key_raises_without_env() -> None:
    with pytest.raises(RuntimeError, match="FAL_KEY"):
        image._ensure_fal_key()


def test_ensure_fal_key_passes_when_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAL_KEY", "x")
    image._ensure_fal_key()  # should not raise


# ---------- _is_retryable -----------------------------------------------


def _fal_http_error(status: int) -> fal_client.FalClientHTTPError:
    req = httpx.Request("POST", "https://fal.run/x")
    resp = httpx.Response(status, request=req)
    return fal_client.FalClientHTTPError(
        "boom",
        status_code=status,
        response_headers={},
        response=resp,
    )


def test_retryable_fal_429() -> None:
    assert image._is_retryable(_fal_http_error(429)) is True


@pytest.mark.parametrize("code", [500, 502, 503, 599])
def test_retryable_fal_5xx(code: int) -> None:
    assert image._is_retryable(_fal_http_error(code)) is True


@pytest.mark.parametrize("code", [400, 401, 403, 404, 422])
def test_not_retryable_fal_4xx_other(code: int) -> None:
    assert image._is_retryable(_fal_http_error(code)) is False


def test_retryable_fal_timeout() -> None:
    assert image._is_retryable(fal_client.FalClientTimeoutError(60.0)) is True


def test_retryable_httpx_transport_error() -> None:
    assert image._is_retryable(httpx.ConnectError("nope")) is True


def test_retryable_httpx_status_5xx() -> None:
    req = httpx.Request("GET", "https://fal.ai/x")
    resp = httpx.Response(503, request=req)
    err = httpx.HTTPStatusError("boom", request=req, response=resp)
    assert image._is_retryable(err) is True


def test_not_retryable_httpx_status_400() -> None:
    req = httpx.Request("GET", "https://fal.ai/x")
    resp = httpx.Response(400, request=req)
    err = httpx.HTTPStatusError("boom", request=req, response=resp)
    assert image._is_retryable(err) is False


def test_not_retryable_random_value_error() -> None:
    assert image._is_retryable(ValueError("unrelated")) is False
