"""Image generation with quality tiers (fal + OpenRouter slugs).

Three tiers map to model slugs (fal verified 2026-04; OpenRouter added 2026-06
after the broad bakeoff, docs/research/07). Each tier is overridable via env
(`FAL_IMAGE_MODEL_FAST` / `..._BALANCED` / `..._PRO`). A request may also pass
an explicit `tier` or `model_override` per call. Resolution order: explicit
override > per-request tier > FAL_IMAGE_MODEL legacy env > default.

Slugs prefixed `openrouter:` route through OpenRouter's image-modality chat API
(riverflow, recraft, …) instead of fal — same GeneratedImage out, provenance
kept in the model string. `_args_for` keeps the per-model arg-shape divergence
localised — seedream/gpt-image-2 use `image_size`, nano-banana family uses
`aspect_ratio`. Add new entries here as more models join.
"""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from typing import Any, cast

import fal_client
import httpx
import openai
from openai import AsyncOpenAI
from tenacity import (
    AsyncRetrying,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

# OpenRouter-served image models (bakeoff field: sourceful/riverflow-v2.5-*,
# recraft/recraft-v4.1-*). The prefix keeps fal slugs unambiguous and shows
# provider provenance in final.image_model.
OPENROUTER_IMAGE_PREFIX = "openrouter:"

TIER_MODELS: dict[str, str] = {
    "fast":     "fal-ai/nano-banana",
    "balanced": "fal-ai/nano-banana-pro",
    # Bakeoff quality winner (docs/research/07): best medium adherence; layout
    # fidelity is saturated across the field so this is the "I want the best
    # one" tier. Revert knob: FAL_IMAGE_MODEL_PRO (e.g. back to seedream-v4).
    "pro":      "openrouter:sourceful/riverflow-v2.5-pro",
}
TIER_ENV_KEYS: dict[str, str] = {
    "fast":     "FAL_IMAGE_MODEL_FAST",
    "balanced": "FAL_IMAGE_MODEL_BALANCED",
    "pro":      "FAL_IMAGE_MODEL_PRO",
}
DEFAULT_TIER = "balanced"

# Aspect strings → seedream-style image_size enum (fal expects one of these).
SEEDREAM_SIZE_MAP: dict[str, str] = {
    "16:9": "landscape_16_9",
    "9:16": "portrait_16_9",
    "1:1":  "square_hd",
    "4:3":  "landscape_4_3",
    "3:4":  "portrait_4_3",
}

# Non-fal image backends. Every target speaks the OpenAI Images wire format
# (`POST {base}/images/generations`), so the only thing that varies is the base
# URL + key — data, not a registry. `custom` (or unknown) must supply
# IMAGE_BASE_URL, covering OpenAI-compatible local servers (LocalAI, vLLM-image,
# SD wrappers). fal stays the default and is handled separately.
IMAGE_BASE_URLS: dict[str, str] = {
    "openai": "https://api.openai.com/v1",
}
DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-1"

# Aspect → image size. gpt-image-1 and dall-e-3 accept DIFFERENT size sets
# (the only common one is 1024x1024), so pick per model family — otherwise the
# default IMAGE_MODEL=gpt-image-1 would 400 on a 16:9 request (1792x1024 is a
# dall-e size gpt-image rejects). Override wholesale with IMAGE_SIZE.
GPT_IMAGE_SIZE_MAP: dict[str, str] = {
    "16:9": "1536x1024",
    "9:16": "1024x1536",
    "1:1":  "1024x1024",
    "4:3":  "1536x1024",
    "3:4":  "1024x1536",
}
DALLE_SIZE_MAP: dict[str, str] = {
    "16:9": "1792x1024",
    "9:16": "1024x1792",
    "1:1":  "1024x1024",
    "4:3":  "1792x1024",
    "3:4":  "1024x1792",
}


@dataclass
class GeneratedImage:
    jpeg_bytes: bytes
    mime_type: str
    model: str
    provider_request_id: str | None


def _ensure_fal_key() -> None:
    if not os.environ.get("FAL_KEY"):
        raise RuntimeError("FAL_KEY is not set")


def _resolve_tier(tier: str | None) -> str:
    candidate = (tier or os.environ.get("FAL_IMAGE_TIER") or DEFAULT_TIER).lower()
    if candidate not in TIER_MODELS:
        return DEFAULT_TIER
    return candidate


def _resolve_model(tier: str | None, model_override: str | None) -> str:
    if model_override:
        return model_override
    resolved_tier = _resolve_tier(tier)
    env_key = TIER_ENV_KEYS[resolved_tier]
    legacy = os.environ.get("FAL_IMAGE_MODEL")  # backwards-compat for old setups
    return os.environ.get(env_key) or legacy or TIER_MODELS[resolved_tier]


def _args_for(
    model: str,
    prompt: str,
    aspect_ratio: str,
    reference_urls: list[str] | None = None,
) -> dict[str, Any]:
    if "seedream" in model or "gpt-image" in model:
        # seedream + fal-hosted gpt-image-2 take `image_size` presets (same
        # enum) and are text-to-image only here — no reference conditioning
        # (verified via scripts/verify-fal-models.py: no image_urls on either).
        return {
            "prompt": prompt,
            "image_size": SEEDREAM_SIZE_MAP.get(aspect_ratio, "landscape_16_9"),
        }
    # nano-banana + nano-banana-pro accept aspect_ratio directly, plus an optional
    # `image_urls` list. NOTE (verified via scripts/verify-fal-models.py): NO image
    # model in use accepts `negative_prompt` (nano-banana, nano-banana-pro and
    # flux-pro/kontext all omit it) — so we never send one; the MEDIUM LOCK in the
    # prompt text is the model-agnostic style guard. And the text-to-image nano
    # endpoints accept `image_urls` but IGNORE it — an empirical test (a photoreal
    # prompt + an engraving ref came back still-photoreal) confirms fresh-gen image
    # conditioning is a no-op here; refs only bite on the edit/continue endpoints
    # (nano-banana/edit takes image_urls, kontext a singular image_url). We still
    # pass them (harmless, future-proof), but the prompt TEXT does the real work.
    args: dict[str, Any] = {"prompt": prompt, "aspect_ratio": aspect_ratio}
    if reference_urls and "nano-banana" in model:
        args["image_urls"] = reference_urls
    return args


def conditioning_preamble(roles: list[str], mode: str) -> str:
    """Prompt prefix telling nano-banana how to read the ordered reference
    images (image 1, 2, …). The order encodes weight: the region you came from
    is strongest, then the immediate parent's world, then the global style
    anchor. Empty roles → no preamble (plain text-to-image)."""
    if not roles:
        return ""
    enter = (
        "Continue the scene outward from" if mode == "expand" else "Reveal what is inside"
    )
    lines: list[str] = []
    for i, role in enumerate(roles, start=1):
        if role == "region":
            if mode == "place_scene":
                # World Mode CORE mechanic — stepping INSIDE a place. The region
                # ref is its EXTERIOR as the map drew it; this page is the INTERIOR,
                # architecturally continuous with that exterior so the move inward
                # is seamless (same building from within, not a zoom of the outside
                # and not a loose reinvention — the drift the user kept hitting).
                lines.append(
                    f"Image {i}: the EXTERIOR of the place being entered, as the map "
                    "shows it. Draw its INTERIOR — the scene just inside it — keeping "
                    "its architecture, stone, materials, columns, windows, colours "
                    "and era faithfully continuous with this exterior. The inside of "
                    "THAT exact building, a seamless step within it; not a zoom of "
                    "the outside, not a new building, not a different style."
                )
            else:
                lines.append(
                    f"Image {i}: the spot you are entering — {enter.lower()} it, "
                    "keeping its composition, depth and framing."
                )
        elif role == "parent":
            lines.append(
                f"Image {i}: the surrounding scene — match its world, palette, "
                "lighting and, above all, its ART MEDIUM (the drawing/render "
                "technique itself), not just the colours."
            )
        elif role == "anchor":
            lines.append(
                f"Image {i}: the overall look of this world — stay consistent "
                "with its art medium and palette."
            )
        elif role == "style":
            # The persistent medium exemplar (root/pinned render). This is the
            # load-bearing line for style consistency: the user's complaint was
            # interiors coming back photoreal / isometric when the source is an
            # engraving. Name the medium and forbid drift explicitly.
            lines.append(
                f"Image {i}: the STYLE REFERENCE — the exact art MEDIUM of this "
                "world (e.g. hand-drawn engraving / woodcut hatching / ink line "
                "work; or watercolour, flat infographic, blueprint — whatever it "
                "shows). Reproduce THIS medium faithfully: same linework, texture "
                "and level of stylisation. Do NOT switch to photorealism, a 3D "
                "render, isometric line-art or any other medium, however much the "
                "subject might invite it."
            )
        else:
            lines.append(f"Image {i}: visual reference — stay consistent with it.")
    return (
        "Use the reference images as visual grounding so this page belongs to the "
        "same continuous world (do not copy them verbatim):\n"
        + "\n".join(lines)
        + "\n\n"
    )


def _image_provider() -> str:
    """The active image provider, normalised. Defaults to `fal`."""
    return (os.environ.get("IMAGE_PROVIDER", "") or "fal").strip().lower() or "fal"


def active_provider() -> str:
    """Public accessor so callers (e.g. generate.py) can gate fal-only paths
    such as the draft/final tier race without reaching into a private."""
    return _image_provider()


def _resolve_image_provider() -> tuple[str, str, str]:
    """Resolve (provider, base_url, api_key) for a non-fal image backend.

    fal is the default and is handled separately in `generate_image`; this only
    runs for OpenAI-images-compatible targets. Mirrors the LLM provider seam:
    env-var only, `custom` (or unknown) needs IMAGE_BASE_URL, and a keyless
    local server defaults to a placeholder key.
    """
    provider = _image_provider()
    base_url = os.environ.get("IMAGE_BASE_URL", "").strip() or IMAGE_BASE_URLS.get(
        provider, ""
    )
    if not base_url:
        raise RuntimeError(
            f"IMAGE_BASE_URL must be set for IMAGE_PROVIDER={provider!r}"
        )
    api_key = os.environ.get("IMAGE_API_KEY", "").strip()
    if not api_key:
        if provider == "custom":
            api_key = "sk-noauth"
        else:
            raise RuntimeError(f"IMAGE_API_KEY is not set for IMAGE_PROVIDER={provider!r}")
    return provider, base_url, api_key


def _image_model() -> str:
    return os.environ.get("IMAGE_MODEL", "").strip() or DEFAULT_OPENAI_IMAGE_MODEL


def _openai_size(aspect_ratio: str, model: str) -> str:
    override = os.environ.get("IMAGE_SIZE", "").strip()
    if override:
        return override
    m = model.lower()
    table = DALLE_SIZE_MAP if ("dall-e" in m or "dalle" in m) else GPT_IMAGE_SIZE_MAP
    return table.get(aspect_ratio, "1024x1024")


async def _generate_with_slug(
    model: str,
    prompt: str,
    aspect_ratio: str,
    reference_urls: list[str] | None,
) -> GeneratedImage:
    """One slug, one attempt (plus its own transient retries). The dispatch
    body of generate_image, extracted so the failover chain can call it per
    candidate."""
    from obs import span

    if model.startswith(OPENROUTER_IMAGE_PREFIX):
        # OpenRouter image-modality slug (riverflow / recraft / …): needs only
        # OPENROUTER_API_KEY (already required for the planner), not FAL_KEY.
        # Text-to-image semantics — refs would be ignored, same as seedream.
        slug = model.removeprefix(OPENROUTER_IMAGE_PREFIX)
        async with span(
            "image.generate",
            model=model,
            prompt_len=len(prompt),
            provider="openrouter",
        ) as ctx:
            generated = await _openrouter_image(slug, prompt, aspect_ratio)
            ctx["bytes"] = len(generated.jpeg_bytes)
        return generated

    _ensure_fal_key()
    # Reference conditioning: upload each data URL to fal storage (queue
    # endpoints choke on multi-MB inline data URLs) and pass them as image_urls.
    # Only nano-banana accepts refs; other fal models stay text-only.
    fal_refs: list[str] | None = None
    if reference_urls and "nano-banana" in model:
        from ._common import to_fal_url

        fal_refs = [await to_fal_url(u) for u in reference_urls]
    async with span(
        "image.generate",
        model=model,
        prompt_len=len(prompt),
        provider="fal",
        refs=len(fal_refs or []),
    ) as ctx:
        result = await _fal_subscribe(
            model, _args_for(model, prompt, aspect_ratio, fal_refs)
        )
        image_info = _first_image(result)
        jpeg_bytes, mime = await _fetch_image_bytes(image_info)
        ctx["bytes"] = len(jpeg_bytes)
    return GeneratedImage(
        jpeg_bytes=jpeg_bytes,
        mime_type=mime,
        model=model,
        provider_request_id=str(result.get("requestId") or "") or None,
    )


async def generate_image(
    prompt: str,
    aspect_ratio: str,
    tier: str | None = None,
    model_override: str | None = None,
    reference_urls: list[str] | None = None,
) -> GeneratedImage:
    from _env import env_flag
    from obs import log, span
    from providers import breaker, mock, model_router

    if mock.on():
        m = mock.mock_image(prompt, op="fresh", aspect_ratio=aspect_ratio)
        return GeneratedImage(m.jpeg_bytes, m.mime_type, m.model, m.request_id)
    if _image_provider() != "fal":
        # Reference conditioning is fal/nano-banana only — other providers stay
        # text-only (refs ignored). Custom IMAGE_PROVIDER deployments sit
        # outside the failover chain (their slugs aren't in the registry).
        prov, base_url, api_key = _resolve_image_provider()
        model = model_override or _image_model()
        async with span(
            "image.generate", model=model, prompt_len=len(prompt), provider=prov
        ) as ctx:
            generated = await _openai_compatible_image(
                base_url, api_key, model, prompt, aspect_ratio
            )
            ctx["bytes"] = len(generated.jpeg_bytes)
        return generated

    model = _resolve_model(tier, model_override)
    if not env_flag("PROVIDER_FALLBACK"):
        return await _generate_with_slug(model, prompt, aspect_ratio, reference_urls)

    # PROVIDER_FALLBACK: the resolved slug plus its registry chain, with
    # circuit-open slugs skipped (three consecutive failures → cooldown).
    # A degraded page beats an error frame; the final's image_model says
    # honestly which model actually rendered. Fresh-gen only by design.
    candidates = [model, *model_router.fallback_chain(model)]
    open_skipped = [c for c in candidates if not breaker.available(c)]
    usable = [c for c in candidates if breaker.available(c)] or [model]
    if open_skipped:
        log("warn", "image.breaker_skip", skipped=",".join(open_skipped))
    last_exc: Exception | None = None
    for i, slug in enumerate(usable):
        try:
            generated = await _generate_with_slug(
                slug, prompt, aspect_ratio, reference_urls
            )
        except Exception as exc:
            breaker.record_failure(slug)
            last_exc = exc
            log(
                "warn",
                "image.fallback_step",
                failed=slug,
                error=f"{type(exc).__name__}: {exc}",
                remaining=len(usable) - i - 1,
            )
            continue
        breaker.record_success(slug)
        if i > 0:
            log("warn", "image.fallback_used", requested=model, used=slug)
        return generated
    raise last_exc if last_exc is not None else RuntimeError("no image candidates")


def encode_data_url(jpeg_bytes: bytes, mime_type: str = "image/jpeg") -> str:
    b64 = base64.b64encode(jpeg_bytes).decode("ascii")
    return f"data:{mime_type};base64,{b64}"


def _first_image(result: dict) -> dict:
    images = result.get("images") or []
    if not images:
        raise RuntimeError("fal returned no images")
    first = images[0]
    if not isinstance(first, dict):
        raise RuntimeError("fal image entry malformed")
    return first


_HTTPX: httpx.AsyncClient | None = None


def _http_client() -> httpx.AsyncClient:
    global _HTTPX
    if _HTTPX is None or _HTTPX.is_closed:
        _HTTPX = httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=10.0),
            limits=httpx.Limits(
                max_keepalive_connections=20, max_connections=50
            ),
        )
    return _HTTPX


async def _fetch_image_bytes(image_info: dict) -> tuple[bytes, str]:
    url = image_info.get("url")
    if not isinstance(url, str) or not url:
        raise RuntimeError("fal image missing url")
    mime = str(image_info.get("content_type") or "image/jpeg")
    resp = await _http_client().get(url)
    resp.raise_for_status()
    return resp.content, mime


async def _fetch_url_bytes(url: str) -> tuple[bytes, str]:
    """Download an image URL (the dall-e-style response path)."""
    resp = await _http_client().get(url)
    resp.raise_for_status()
    mime = (resp.headers.get("content-type") or "image/jpeg").split(";")[0].strip()
    return resp.content, mime or "image/jpeg"


async def _post_image_json(
    url: str, headers: dict[str, str], payload: dict[str, Any]
) -> dict[str, Any]:
    """POST to an OpenAI-images-compatible endpoint with bounded retry,
    reusing the same transient classifier as the fal path."""
    async for attempt in AsyncRetrying(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=0.5, min=0.5, max=4),
        retry=retry_if_exception(_is_retryable),
        reraise=True,
    ):
        with attempt:
            resp = await _http_client().post(url, headers=headers, json=payload)
            resp.raise_for_status()
            return cast(dict[str, Any], resp.json())
    raise RuntimeError("unreachable")  # pragma: no cover


async def _openai_compatible_image(
    base_url: str, api_key: str, model: str, prompt: str, aspect_ratio: str
) -> GeneratedImage:
    """Generate one image via the OpenAI Images API (or any compatible server).

    Handles both response shapes: gpt-image-1 returns inline `b64_json`,
    dall-e-style returns a `url` we then fetch. `response_format` is NOT sent —
    gpt-image-1 rejects it — so we accept whichever shape the server emits.
    """
    url = f"{base_url.rstrip('/')}/images/generations"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "size": _openai_size(aspect_ratio, model),
        "n": 1,
    }
    data = await _post_image_json(url, headers, payload)
    items = data.get("data") or []
    if not items or not isinstance(items[0], dict):
        raise RuntimeError("image provider returned no images")
    item = items[0]
    b64 = item.get("b64_json")
    if isinstance(b64, str) and b64:
        return GeneratedImage(
            jpeg_bytes=base64.b64decode(b64),
            mime_type="image/png",
            model=model,
            provider_request_id=None,
        )
    img_url = item.get("url")
    if isinstance(img_url, str) and img_url:
        raw, mime = await _fetch_url_bytes(img_url)
        return GeneratedImage(
            jpeg_bytes=raw, mime_type=mime, model=model, provider_request_id=None
        )
    raise RuntimeError("image provider returned neither b64_json nor url")


_OPENROUTER_CLIENT: AsyncOpenAI | None = None


def _openrouter_client() -> AsyncOpenAI:
    """Module-level singleton for `openrouter:` image slugs.

    Pinned to the OpenRouter base URL on purpose — NOT llm._client(), whose
    LLM_PROVIDER seam may point at Ollama/LM Studio, which can't serve image
    modalities. Explicit generous timeout: riverflow-pro takes 1-3 MINUTES
    with no bytes on the wire (152s measured live, 2026-06-10), and an
    unbounded await would hang the SSE worker.
    """
    global _OPENROUTER_CLIENT
    if _OPENROUTER_CLIENT is None:
        api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError(
                "OPENROUTER_API_KEY is not set (required for openrouter: image models)"
            )
        _OPENROUTER_CLIENT = AsyncOpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=api_key,
            timeout=float(os.environ.get("OPENROUTER_IMAGE_TIMEOUT_S", "240")),
            default_headers={
                "HTTP-Referer": os.environ.get(
                    "OPENROUTER_REFERER", "https://github.com/eren23/openflipbook"
                ),
                "X-Title": "Endless Canvas",
            },
        )
    return _OPENROUTER_CLIENT


async def _openrouter_image(
    slug: str, prompt: str, aspect_ratio: str
) -> GeneratedImage:
    """One image via OpenRouter's image-modality chat API (riverflow/recraft).

    Request shape proven by the bakeoff harness (scripts/bakeoff): a chat
    completion with `modalities: ["image"]`; the image comes back base64 in
    `message.images[0].image_url.url` (or, defensively, an http(s) URL).
    """
    client = _openrouter_client()
    async for attempt in AsyncRetrying(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=0.5, min=0.5, max=4),
        retry=retry_if_exception(_is_retryable),
        reraise=True,
    ):
        with attempt:
            resp = await client.chat.completions.create(
                model=slug,
                messages=[{"role": "user", "content": prompt}],
                extra_body={
                    "modalities": ["image"],
                    "image_config": {"aspect_ratio": aspect_ratio},
                },
            )
            msg = (resp.model_dump().get("choices") or [{}])[0].get("message") or {}
            images = msg.get("images") or []
            if not images:
                # Malformed/empty responses fail fast (RuntimeError is not
                # retryable) — mirrors _first_image on the fal path.
                content = str(msg.get("content"))[:160]
                raise RuntimeError(
                    f"openrouter image model returned no image (content={content!r})"
                )
            url = str((images[0].get("image_url") or {}).get("url") or "")
            if url.startswith("data:"):
                header, _, b64 = url.partition(",")
                mime = header.removeprefix("data:").split(";")[0] or "image/png"
                raw = base64.b64decode(b64)
            elif url.startswith("http"):
                raw, mime = await _fetch_url_bytes(url)
            else:
                raise RuntimeError("openrouter image url malformed")
            return GeneratedImage(
                jpeg_bytes=raw,
                mime_type=mime or "image/png",
                model=f"{OPENROUTER_IMAGE_PREFIX}{slug}",
                provider_request_id=str(getattr(resp, "id", "") or "") or None,
            )
    raise RuntimeError("unreachable")  # pragma: no cover


def _is_retryable(exc: BaseException) -> bool:
    """fal/openai/transport transients worth retrying. 4xx-other fails fast.

    fal_client raises its own exception hierarchy (`FalClientHTTPError`,
    `FalClientTimeoutError`) for queue/HTTP failures — NOT bare httpx
    exceptions — so the classifier checks those first. The openai SDK (the
    `openrouter:` image path) likewise wraps transport errors in its own
    types. Falls back to httpx exceptions for the post-fal CDN download path.
    """
    if isinstance(exc, fal_client.FalClientHTTPError):
        code = exc.status_code
        return code == 429 or 500 <= code < 600
    if isinstance(exc, fal_client.FalClientTimeoutError):
        return True
    if isinstance(exc, openai.APIStatusError):  # RateLimitError subclasses this
        return exc.status_code == 429 or 500 <= exc.status_code < 600
    if isinstance(exc, openai.APIConnectionError):  # APITimeoutError subclasses this
        return True
    if isinstance(exc, httpx.TransportError):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        return code == 429 or 500 <= code < 600
    return False


async def _fal_subscribe(model: str, arguments: dict) -> dict:
    """fal_client.subscribe_async with bounded exponential backoff.

    Three attempts max. Doesn't retry on auth/4xx-other so a misconfigured
    key fails fast. Wider safety net would mask real bugs.
    """
    async for attempt in AsyncRetrying(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=0.5, min=0.5, max=4),
        retry=retry_if_exception(_is_retryable),
        reraise=True,
    ):
        with attempt:
            return await fal_client.subscribe_async(
                model, arguments=arguments, with_logs=False
            )
    raise RuntimeError("unreachable")  # pragma: no cover
