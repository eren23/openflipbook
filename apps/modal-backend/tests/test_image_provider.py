"""Unit tests for providers.image.

Covers the resolution helpers (tier, model, args) and the retry classifier
(_is_retryable). The fal_client.subscribe_async path is exercised by
mocking fal_client at the module level so no network hits are made.
"""

from __future__ import annotations

import base64

import fal_client
import httpx
import openai
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


def test_pro_tier_defaults_to_riverflow_the_quality_winner() -> None:
    """Pro = riverflow (bakeoff quality winner — the dense, detailed maps). It's
    slow/occasionally-empty but now reliable via the SSE heartbeat + fail-fast
    fal failover. Trade detail for speed via FAL_IMAGE_MODEL_PRO."""
    assert image._resolve_model("pro", None) == "openrouter:sourceful/riverflow-v2.5-pro"
    assert image.TIER_MODELS["pro"].startswith(image.OPENROUTER_IMAGE_PREFIX)


def test_pro_tier_can_opt_into_fast_fal_via_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FAL_IMAGE_MODEL_PRO", "fal-ai/nano-banana-pro")
    assert image._resolve_model("pro", None) == "fal-ai/nano-banana-pro"


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


# --- image conditioning (multi-reference) -----------------------------------


def test_args_for_nano_banana_ignores_reference_urls() -> None:
    # Fresh-gen is a no-op for refs: the nano text-to-image endpoint ignores
    # image_urls, so _args_for must never emit it (see image.py comment).
    args = image._args_for("fal-ai/nano-banana-pro", "p", "16:9", ["u1", "u2"])
    assert args == {"prompt": "p", "aspect_ratio": "16:9"}
    assert "image_urls" not in args


def test_args_for_seedream_ignores_reference_urls() -> None:
    # seedream is text-to-image only here — refs must never leak into its args.
    args = image._args_for(
        "fal-ai/bytedance/seedream/v4/text-to-image", "p", "16:9", ["u1"]
    )
    assert "image_urls" not in args


def test_args_for_nano_banana_empty_refs_unchanged() -> None:
    # No refs → byte-identical to today's text-only args (back-compat).
    assert image._args_for("fal-ai/nano-banana", "p", "1:1", []) == {
        "prompt": "p",
        "aspect_ratio": "1:1",
    }


async def test_generate_image_ignores_reference_urls_on_fresh_gen(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Fresh-gen no longer uploads refs to fal nor passes image_urls (the nano
    # text-to-image endpoint ignores them). Refs supplied -> still text-only.
    monkeypatch.setenv("FAL_KEY", "fk")
    captured: dict = {}
    uploaded: list[str] = []

    async def fake_to_fal(data_url: str) -> str:
        uploaded.append(data_url)
        return f"fal://{data_url[-1]}"

    async def fake_sub(model: str, args: dict, **kw: object) -> dict:
        captured["args"] = args
        return {"images": [{"url": "http://x"}], "requestId": "r1"}

    async def fake_fetch(info: dict) -> tuple[bytes, str]:
        return b"jpeg", "image/jpeg"

    monkeypatch.setattr("providers._common.to_fal_url", fake_to_fal)
    monkeypatch.setattr(image, "_fal_subscribe", fake_sub)
    monkeypatch.setattr(image, "_fetch_image_bytes", fake_fetch)

    out = await image.generate_image(
        "a cat", "16:9", reference_urls=["data:a", "data:b"]
    )
    assert out.jpeg_bytes == b"jpeg"
    assert uploaded == []  # no wasted fal upload on fresh-gen
    assert "image_urls" not in captured["args"]


def test_conditioning_preamble_orders_signals_for_tap() -> None:
    out = image.conditioning_preamble(["region", "parent", "anchor"], "tap")
    assert "Image 1" in out and "Image 2" in out and "Image 3" in out
    assert "inside" in out.lower()  # tap reveals what's inside the region
    assert "palette" in out.lower() or "world" in out.lower()  # parent anchors look


def test_conditioning_preamble_expand_continues_outward() -> None:
    out = image.conditioning_preamble(["region", "parent", "anchor"], "expand")
    assert "outward" in out.lower()


def test_conditioning_preamble_empty_is_blank() -> None:
    assert image.conditioning_preamble([], "tap") == ""


def test_conditioning_preamble_place_scene_steps_inside_consistently() -> None:
    # World Mode CORE mechanic: stepping INSIDE a place. The region ref is the
    # place's EXTERIOR from the map; the page is its INTERIOR, architecturally
    # continuous with that exterior — a seamless step within the SAME building,
    # not a zoom of the outside and not a reinvention.
    out = image.conditioning_preamble(["region", "parent"], "place_scene")
    low = out.lower()
    assert "exterior" in low and "interior" in low   # exterior crop -> interior
    assert "architecture" in low                     # keep the place's architecture
    assert "seamless" in low or "continuous" in low  # the move inward is continuous
    assert "exact" in low                            # the inside of THAT exact place
    assert "outward" not in low                      # not expand
    # the step-inside / exterior framing is place_scene-only, not a plain tap
    assert "exterior" not in image.conditioning_preamble(["region"], "tap").lower()


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


def _fal_http_error(
    status: int, message: str = "boom", error_type: str | None = None
) -> fal_client.FalClientHTTPError:
    req = httpx.Request("POST", "https://fal.run/x")
    resp = httpx.Response(status, request=req)
    return fal_client.FalClientHTTPError(
        message,
        status_code=status,
        response_headers={},
        response=resp,
        error_type=error_type,
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

    async def fake_sub(model: str, args: dict, **kw: object) -> dict:
        return {"images": [{"url": "http://x"}], "requestId": "r1"}

    async def fake_fetch(info: dict) -> tuple[bytes, str]:
        return b"jpeg", "image/jpeg"

    monkeypatch.setattr(image, "_fal_subscribe", fake_sub)
    monkeypatch.setattr(image, "_fetch_image_bytes", fake_fetch)
    out = await image.generate_image("a cat", "16:9")
    assert out.jpeg_bytes == b"jpeg"
    assert out.model == image.TIER_MODELS["balanced"]
    assert out.provider_request_id == "r1"


# ---------- OpenRouter image slugs (openrouter: prefix) -------------------


class _FakeORResponse:
    id = "gen-123"

    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def model_dump(self) -> dict:
        return self._payload


def _fake_or_client(payload: dict, captured: dict) -> object:
    from types import SimpleNamespace

    async def create(**kwargs: object) -> _FakeORResponse:
        captured.update(kwargs)
        return _FakeORResponse(payload)

    return SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=create))
    )


def _or_payload(url: str) -> dict:
    return {"choices": [{"message": {"images": [{"image_url": {"url": url}}]}}]}


def test_args_for_gpt_image_uses_image_size_and_never_refs() -> None:
    # fal-hosted gpt-image-2: image_size presets, refs must never leak
    # (verify-fal-models.py: no image_urls on its text-to-image schema).
    args = image._args_for("openai/gpt-image-2", "p", "16:9", ["u1"])
    assert args["image_size"] == "landscape_16_9"
    assert "aspect_ratio" not in args
    assert "image_urls" not in args


async def test_generate_image_routes_openrouter_prefix_without_fal_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # An openrouter: slug must dispatch off the fal path entirely — no FAL_KEY
    # demanded (conftest scrubs it) — and strip the prefix for the wire call.
    sentinel = image.GeneratedImage(
        jpeg_bytes=b"x",
        mime_type="image/png",
        model="openrouter:sourceful/riverflow-v2.5-pro",
        provider_request_id=None,
    )
    seen: dict[str, str] = {}

    async def fake_or(slug: str, prompt: str, aspect: str) -> image.GeneratedImage:
        seen["slug"] = slug
        seen["aspect"] = aspect
        return sentinel

    monkeypatch.setattr(image, "_openrouter_image", fake_or)
    out = await image.generate_image("a map", "16:9", tier="pro")  # pro = riverflow
    assert out is sentinel
    assert seen["slug"] == "sourceful/riverflow-v2.5-pro"  # prefix stripped
    assert seen["aspect"] == "16:9"


async def test_openrouter_image_parses_data_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    b64 = base64.b64encode(b"PNGDATA").decode("ascii")
    captured: dict = {}
    fake = _fake_or_client(_or_payload(f"data:image/png;base64,{b64}"), captured)
    monkeypatch.setattr(image, "_OPENROUTER_CLIENT", fake)

    out = await image._openrouter_image("sourceful/riverflow-v2.5-pro", "a map", "16:9")

    assert out.jpeg_bytes == b"PNGDATA"
    assert out.mime_type == "image/png"
    assert out.model == "openrouter:sourceful/riverflow-v2.5-pro"
    assert out.provider_request_id == "gen-123"
    # The proven bakeoff request shape: image modality + aspect via image_config.
    assert captured["model"] == "sourceful/riverflow-v2.5-pro"
    assert captured["extra_body"]["modalities"] == ["image"]
    assert captured["extra_body"]["image_config"]["aspect_ratio"] == "16:9"


async def test_openrouter_image_fetches_http_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}
    fake = _fake_or_client(_or_payload("http://cdn/img.jpg"), captured)
    monkeypatch.setattr(image, "_OPENROUTER_CLIENT", fake)

    async def fake_fetch(url: str) -> tuple[bytes, str]:
        assert url == "http://cdn/img.jpg"
        return b"JPEGDATA", "image/jpeg"

    monkeypatch.setattr(image, "_fetch_url_bytes", fake_fetch)
    out = await image._openrouter_image("recraft/recraft-v4.1-pro", "p", "1:1")
    assert out.jpeg_bytes == b"JPEGDATA"
    assert out.mime_type == "image/jpeg"


async def test_openrouter_image_no_image_fails_fast(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}
    fake = _fake_or_client(
        {"choices": [{"message": {"content": "cannot draw that"}}]}, captured
    )
    monkeypatch.setattr(image, "_OPENROUTER_CLIENT", fake)
    with pytest.raises(RuntimeError, match="no image"):
        await image._openrouter_image("sourceful/riverflow-v2.5-fast", "p", "1:1")


def test_openrouter_client_requires_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(image, "_OPENROUTER_CLIENT", None)
    with pytest.raises(RuntimeError, match="OPENROUTER_API_KEY"):
        image._openrouter_client()


def _openai_status_error(status: int) -> openai.APIStatusError:
    req = httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions")
    resp = httpx.Response(status, request=req)
    return openai.APIStatusError("boom", response=resp, body=None)


def test_retryable_openai_rate_limit() -> None:
    assert image._is_retryable(_openai_status_error(429)) is True


@pytest.mark.parametrize("code", [500, 502, 503])
def test_retryable_openai_5xx(code: int) -> None:
    assert image._is_retryable(_openai_status_error(code)) is True


@pytest.mark.parametrize("code", [400, 401, 403, 404, 422])
def test_not_retryable_openai_4xx_other(code: int) -> None:
    assert image._is_retryable(_openai_status_error(code)) is False


def test_retryable_openai_connection_error() -> None:
    req = httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions")
    err = openai.APIConnectionError(request=req)
    assert image._is_retryable(err) is True


def test_empty_openrouter_image_response_fails_fast_not_retried() -> None:
    # An empty image response (the "pro" tier's `content='None'`) must FAIL FAST,
    # not retry the flaky/slow model 3x in place (that blew the upstream timeout,
    # "network error"). generate_image's forced fal failover handles it instead.
    exc = image._EmptyImageResponse("returned no image (content='None')")
    assert image._is_retryable(exc) is False
    assert isinstance(exc, RuntimeError)  # still a RuntimeError for callers


async def test_openrouter_image_failure_falls_back_to_fal_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The "pro" tier (openrouter riverflow) must auto-fall-back to fal even with
    # PROVIDER_FALLBACK OFF — a degraded fal page beats a slow timeout / banner.
    monkeypatch.delenv("PROVIDER_FALLBACK", raising=False)
    monkeypatch.setattr(
        image, "_resolve_model",
        lambda tier, override: "openrouter:sourceful/riverflow-v2.5-pro",
    )
    seen: list[str] = []

    async def fake_slug(model: str, prompt: str, aspect: str, refs: object) -> image.GeneratedImage:
        seen.append(model)
        if model.startswith(image.OPENROUTER_IMAGE_PREFIX):
            raise image._EmptyImageResponse("no image (content='None')")
        return image.GeneratedImage(b"jpeg", "image/jpeg", model, "r")

    monkeypatch.setattr(image, "_generate_with_slug", fake_slug)
    result = await image.generate_image("a map", "16:9", tier="pro")

    assert seen[0].startswith(image.OPENROUTER_IMAGE_PREFIX)  # tried riverflow first
    assert result.model == "fal-ai/nano-banana-pro"  # …then fell over to fal



# ---------- stochastic no-media retries (RETRY_NO_MEDIA, default ON) ---------
#
# fal sometimes fails a render stochastically: a 422 tagged no_media_generated,
# or a 200 whose images array is empty. The SAME request usually succeeds on
# the next attempt (verified live), so both classes are retried in place.
# Plain 4xx stays fail-fast (pinned above by test_not_retryable_fal_4xx_other).


def test_retryable_fal_no_media_generated_error_type() -> None:
    err = _fal_http_error(422, error_type="no_media_generated")
    assert image._is_retryable(err) is True


def test_retryable_fal_no_media_generated_in_message() -> None:
    # The detail-list repr case: the marker rides the stringified body.
    err = _fal_http_error(
        422,
        message="[{'loc': ['body'], 'msg': '...', 'type': 'no_media_generated'}]",
    )
    assert image._is_retryable(err) is True


def test_no_media_retry_kill_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RETRY_NO_MEDIA", "false")
    assert (
        image._is_retryable(_fal_http_error(422, error_type="no_media_generated"))
        is False
    )
    assert image._is_retryable(image._EmptyFalResult("fal returned no images")) is False


def test_retryable_empty_fal_result() -> None:
    assert image._is_retryable(image._EmptyFalResult("fal returned no images")) is True


async def test_fal_subscribe_retries_no_media_then_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The stochastic evidence, pinned: first attempt raises the tagged 422,
    # the identical retry succeeds.
    calls = {"n": 0}

    async def fake_subscribe(model: str, arguments: dict, with_logs: bool) -> dict:
        calls["n"] += 1
        if calls["n"] == 1:
            raise _fal_http_error(422, error_type="no_media_generated")
        return {"images": [{"url": "https://cdn/x.jpg"}]}

    monkeypatch.setattr(image.fal_client, "subscribe_async", fake_subscribe)
    result = await image._fal_subscribe("fal-ai/nano-banana", {}, require_images=True)
    assert calls["n"] == 2
    assert result["images"]


async def test_fal_subscribe_require_images_retries_empty_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = {"n": 0}

    async def fake_subscribe(model: str, arguments: dict, with_logs: bool) -> dict:
        calls["n"] += 1
        return {"images": []} if calls["n"] == 1 else {"images": [{"url": "u"}]}

    monkeypatch.setattr(image.fal_client, "subscribe_async", fake_subscribe)
    result = await image._fal_subscribe("fal-ai/nano-banana", {}, require_images=True)
    assert calls["n"] == 2
    assert result["images"]


async def test_fal_subscribe_require_images_accepts_bria_singular_image(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # BRIA Expand answers with a singular `image` object, not `images: [...]` —
    # a successful outpaint must NOT be mistaken for an empty result.
    async def fake_subscribe(model: str, arguments: dict, with_logs: bool) -> dict:
        return {"image": {"url": "https://cdn/expanded.jpg"}}

    monkeypatch.setattr(image.fal_client, "subscribe_async", fake_subscribe)
    result = await image._fal_subscribe("fal-ai/bria/expand", {}, require_images=True)
    assert result["image"]["url"].endswith("expanded.jpg")


async def test_fal_subscribe_default_ignores_empty_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Non-image callers (segmenter masks, video) keep byte-identical behaviour.
    async def fake_subscribe(model: str, arguments: dict, with_logs: bool) -> dict:
        return {"masks": []}

    monkeypatch.setattr(image.fal_client, "subscribe_async", fake_subscribe)
    result = await image._fal_subscribe("fal-ai/sam-3", {})
    assert result == {"masks": []}


async def test_fal_subscribe_deadline_fails_fast(monkeypatch) -> None:
    # Live-caught 2026-07-20: a fal edit call hung 12+ min; heartbeats kept
    # the dead stream open forever. The per-attempt deadline turns a hang
    # into TimeoutError (→ the friendly "took too long" frame) and is NOT
    # retried — one deadline, not three stacked.
    import asyncio

    from providers import image as image_provider

    calls = {"n": 0}

    async def hung_subscribe(model, arguments=None, with_logs=False):
        calls["n"] += 1
        await asyncio.sleep(30)

    monkeypatch.setenv("FAL_CALL_TIMEOUT_S", "30")  # floor clamps to 30s
    monkeypatch.setattr(image_provider.fal_client, "subscribe_async", hung_subscribe)
    # Shrink the effective deadline below the floor via a direct patch of the
    # env read is not possible (floor 30s) — instead patch wait_for's timeout
    # source: use a tiny sleep vs a tiny deadline by patching asyncio.wait_for
    # would test the stdlib, not us. So: patch subscribe to outlive a 30s
    # deadline is too slow for CI — instead verify the wiring by patching
    # asyncio.wait_for to observe the timeout value and raise immediately.
    seen = {}

    async def spy_wait_for(coro, timeout=None):
        seen["timeout"] = timeout
        coro.close()
        raise TimeoutError("deadline")

    monkeypatch.setattr(image_provider.asyncio, "wait_for", spy_wait_for)
    with pytest.raises(TimeoutError):
        await image_provider._fal_subscribe("fal-ai/x", {})
    assert seen["timeout"] == 30.0  # env honored (with the 30s floor)
    assert calls["n"] == 0  # wait_for raised before subscribe ran (spy short-circuit)


async def test_fal_subscribe_deadline_not_retried(monkeypatch) -> None:

    from providers import image as image_provider

    attempts = {"n": 0}

    async def spy_wait_for(coro, timeout=None):
        attempts["n"] += 1
        coro.close()
        raise TimeoutError("deadline")

    monkeypatch.setattr(image_provider.asyncio, "wait_for", spy_wait_for)
    with pytest.raises(TimeoutError):
        await image_provider._fal_subscribe("fal-ai/x", {})
    assert attempts["n"] == 1  # a hang fails FAST — no 3x deadline stack
