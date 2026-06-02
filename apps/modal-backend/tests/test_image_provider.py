"""Unit tests for providers.image.

Covers the resolution helpers (tier, model, args) and the retry classifier
(_is_retryable). The fal_client.subscribe_async path is exercised by
mocking fal_client at the module level so no network hits are made.
"""

from __future__ import annotations

import base64

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


# ---------- multi-provider image backend (PR2) --------------------------


def test_image_provider_defaults_to_fal() -> None:
    assert image._image_provider() == "fal"
    assert image.active_provider() == "fal"


def test_image_provider_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("IMAGE_PROVIDER", "openai")
    assert image._image_provider() == "openai"


def test_resolve_image_provider_openai(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("IMAGE_PROVIDER", "openai")
    monkeypatch.setenv("IMAGE_API_KEY", "sk-img")
    prov, base, key = image._resolve_image_provider()
    assert prov == "openai"
    assert base == "https://api.openai.com/v1"
    assert key == "sk-img"


def test_resolve_image_provider_custom_requires_base(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("IMAGE_PROVIDER", "custom")
    monkeypatch.setenv("IMAGE_API_KEY", "x")
    with pytest.raises(RuntimeError):
        image._resolve_image_provider()


def test_resolve_image_provider_custom_noauth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("IMAGE_PROVIDER", "custom")
    monkeypatch.setenv("IMAGE_BASE_URL", "http://localhost:8080/v1")
    prov, base, key = image._resolve_image_provider()
    assert prov == "custom"
    assert base == "http://localhost:8080/v1"
    assert key == "sk-noauth"


def test_resolve_image_provider_openai_missing_key_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("IMAGE_PROVIDER", "openai")
    with pytest.raises(RuntimeError):
        image._resolve_image_provider()


def test_resolve_image_provider_base_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("IMAGE_PROVIDER", "openai")
    monkeypatch.setenv("IMAGE_API_KEY", "k")
    monkeypatch.setenv("IMAGE_BASE_URL", "http://proxy/v1")
    _, base, _ = image._resolve_image_provider()
    assert base == "http://proxy/v1"


def test_image_model_default() -> None:
    assert image._image_model() == "gpt-image-1"


def test_image_model_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("IMAGE_MODEL", "dall-e-3")
    assert image._image_model() == "dall-e-3"


def test_openai_size_maps_aspect_for_gpt_image() -> None:
    # gpt-image-1 valid sizes: 1024x1024 / 1536x1024 / 1024x1536 / auto.
    assert image._openai_size("1:1", "gpt-image-1") == "1024x1024"
    assert image._openai_size("16:9", "gpt-image-1") == "1536x1024"
    assert image._openai_size("9:16", "gpt-image-1") == "1024x1536"


def test_openai_size_maps_aspect_for_dalle() -> None:
    assert image._openai_size("16:9", "dall-e-3") == "1792x1024"
    assert image._openai_size("1:1", "dall-e-3") == "1024x1024"


def test_openai_size_default_model_is_gpt_image_valid() -> None:
    # Regression: the documented default (IMAGE_MODEL=gpt-image-1) + the default
    # 16:9 aspect must NOT emit a dall-e-only size that gpt-image rejects (400).
    size = image._openai_size("16:9", image.DEFAULT_OPENAI_IMAGE_MODEL)
    assert size in {"1024x1024", "1536x1024", "1024x1536", "auto"}


def test_openai_size_env_override_beats_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("IMAGE_SIZE", "1536x1024")
    assert image._openai_size("16:9", "dall-e-3") == "1536x1024"


async def test_openai_compatible_image_b64(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_post(url: str, headers: dict, payload: dict) -> dict:
        return {"data": [{"b64_json": base64.b64encode(b"PNGDATA").decode("ascii")}]}

    monkeypatch.setattr(image, "_post_image_json", fake_post)
    out = await image._openai_compatible_image(
        "http://x/v1", "k", "gpt-image-1", "a cat", "1:1"
    )
    assert out.jpeg_bytes == b"PNGDATA"
    assert out.mime_type == "image/png"
    assert out.model == "gpt-image-1"


async def test_openai_compatible_image_url_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_post(url: str, headers: dict, payload: dict) -> dict:
        return {"data": [{"url": "http://cdn/img.jpg"}]}

    async def fake_fetch(url: str) -> tuple[bytes, str]:
        return b"JPEGDATA", "image/jpeg"

    monkeypatch.setattr(image, "_post_image_json", fake_post)
    monkeypatch.setattr(image, "_fetch_url_bytes", fake_fetch)
    out = await image._openai_compatible_image(
        "http://x/v1", "k", "dall-e-3", "a dog", "16:9"
    )
    assert out.jpeg_bytes == b"JPEGDATA"
    assert out.mime_type == "image/jpeg"


async def test_generate_image_routes_to_openai(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("IMAGE_PROVIDER", "openai")
    monkeypatch.setenv("IMAGE_API_KEY", "k")
    sentinel = image.GeneratedImage(
        jpeg_bytes=b"x", mime_type="image/png", model="gpt-image-1", provider_request_id=None
    )
    seen: dict[str, str] = {}

    async def fake_openai(
        base: str, key: str, model: str, prompt: str, aspect: str
    ) -> image.GeneratedImage:
        seen["base"] = base
        seen["model"] = model
        return sentinel

    monkeypatch.setattr(image, "_openai_compatible_image", fake_openai)
    out = await image.generate_image("a cat", "1:1")
    assert out is sentinel
    assert seen["base"] == "https://api.openai.com/v1"
    assert seen["model"] == "gpt-image-1"


async def test_generate_image_stays_on_fal_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FAL_KEY", "fk")

    async def fake_sub(model: str, args: dict) -> dict:
        return {"images": [{"url": "http://x"}], "requestId": "r1"}

    async def fake_fetch(info: dict) -> tuple[bytes, str]:
        return b"jpeg", "image/jpeg"

    monkeypatch.setattr(image, "_fal_subscribe", fake_sub)
    monkeypatch.setattr(image, "_fetch_image_bytes", fake_fetch)
    out = await image.generate_image("a cat", "16:9")
    assert out.jpeg_bytes == b"jpeg"
    assert out.model == image.TIER_MODELS["balanced"]
    assert out.provider_request_id == "r1"
