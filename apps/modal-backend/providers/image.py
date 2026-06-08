"""fal-ai image generation with quality tiers.

Three tiers map to fal model slugs (verified 2026-04). Each tier is overridable
via env (`FAL_IMAGE_MODEL_FAST` / `..._BALANCED` / `..._PRO`). A request may
also pass an explicit `tier` or `model_override` per call. Resolution order:
explicit override > per-request tier > FAL_IMAGE_MODEL legacy env > default.

`_args_for` keeps the per-model arg-shape divergence localised — seedream uses
`image_size`, nano-banana uses `aspect_ratio`. Add new entries here as more
models join.
"""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from typing import Any, cast

import fal_client
import httpx
from tenacity import (
    AsyncRetrying,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

TIER_MODELS: dict[str, str] = {
    "fast":     "fal-ai/nano-banana",
    "balanced": "fal-ai/nano-banana-pro",
    "pro":      "fal-ai/bytedance/seedream/v4/text-to-image",
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
    negative_prompt: str | None = None,
) -> dict[str, Any]:
    if "seedream" in model:
        # seedream is text-to-image only here — no reference conditioning, and it
        # ignores negative_prompt.
        return {
            "prompt": prompt,
            "image_size": SEEDREAM_SIZE_MAP.get(aspect_ratio, "landscape_16_9"),
        }
    # nano-banana + nano-banana-pro both accept aspect_ratio directly, plus an
    # optional `image_urls` list for multi-reference conditioning.
    args: dict[str, Any] = {"prompt": prompt, "aspect_ratio": aspect_ratio}
    if reference_urls and "nano-banana" in model:
        args["image_urls"] = reference_urls
    # A negative prompt is honoured by nano-banana-pro and flux/kontext; base
    # nano-banana and seedream ignore (or reject) it, so only attach it where it
    # actually lands. Gated upstream behind IMAGE_NEGATIVE_PROMPT (off by default
    # pending a fal-schema check).
    if negative_prompt and (
        "nano-banana-pro" in model or "flux" in model or "kontext" in model
    ):
        args["negative_prompt"] = negative_prompt
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


async def generate_image(
    prompt: str,
    aspect_ratio: str,
    tier: str | None = None,
    model_override: str | None = None,
    reference_urls: list[str] | None = None,
    negative_prompt: str | None = None,
) -> GeneratedImage:
    from obs import span

    if _image_provider() != "fal":
        # Reference conditioning is fal/nano-banana only — other providers stay
        # text-only (refs ignored).
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

    _ensure_fal_key()
    model = _resolve_model(tier, model_override)
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
            model, _args_for(model, prompt, aspect_ratio, fal_refs, negative_prompt)
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


def _is_retryable(exc: BaseException) -> bool:
    """fal/transport transients worth retrying. 4xx-other should fail fast.

    fal_client raises its own exception hierarchy (`FalClientHTTPError`,
    `FalClientTimeoutError`) for queue/HTTP failures — NOT bare httpx
    exceptions — so the classifier checks those first. Falls back to httpx
    exceptions for the post-fal CDN download path.
    """
    if isinstance(exc, fal_client.FalClientHTTPError):
        code = exc.status_code
        return code == 429 or 500 <= code < 600
    if isinstance(exc, fal_client.FalClientTimeoutError):
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
