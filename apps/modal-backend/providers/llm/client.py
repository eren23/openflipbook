"""AsyncOpenAI plumbing shared by every LLM/VLM call in this package.

Provider/base-URL resolution, the singleton client, model/tier selection, the
`_complete_json` structured-output ladder with `_create_with_retry` backoff,
and the tolerant JSON/message helpers. Split out of the old providers/llm.py
monolith — every name is re-exported unchanged from providers.llm.

Calls to `_client` / `_safe_log` route through the `providers.llm` package
namespace (`_llm.*`) so tests that monkeypatch `providers.llm._client` etc.
keep intercepting them exactly as they did on the monolith.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any, cast

from openai import (
    APIConnectionError,
    APITimeoutError,
    AsyncOpenAI,
    BadRequestError,
    InternalServerError,
    RateLimitError,
)

from _env import env_flag
from providers import llm as _llm

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_VLM_MODEL = "google/gemini-3-flash-preview"
DEFAULT_TEXT_MODEL = "google/gemini-3-flash-preview"

# Built-in base URLs per provider. This is DATA, not a behavior registry —
# every target speaks the OpenAI wire protocol, so the only thing that varies
# is the endpoint + key. `custom` (or any unknown value) must supply
# LLM_BASE_URL, which covers OpenAI-compatible local servers (Ollama,
# LM Studio, vLLM) and self-hosted proxies. Anthropic/Google entries are their
# OpenAI-compatibility endpoints so the single AsyncOpenAI code path is reused.
_LLM_BASE_URLS = {
    "openrouter": OPENROUTER_BASE_URL,
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "google": "https://generativelanguage.googleapis.com/v1beta/openai/",
}


# Allowed kinds match the EntityKind union in packages/config. Strings only —
# wire format is JSON. Any other kind emitted by the VLM is dropped on parse.
ENTITY_KINDS = ("person", "place", "item", "creature")

# Relative scale buckets for the scale-space map. Composed into an integer
# scale-level (component=-1, peer=0, container=+1) for zoom level-of-detail.
SCALE_KINDS = ("component", "peer", "container")


def _coerce_scale(raw: Any) -> str:
    """Coerce a VLM-emitted scale to one of SCALE_KINDS; default 'peer'."""
    if isinstance(raw, str):
        s = raw.strip().lower()
        if s in SCALE_KINDS:
            return s
    return "peer"


_OPENAI_CLIENT: AsyncOpenAI | None = None


def _llm_provider() -> str:
    """The active LLM provider, normalised. Defaults to `openrouter`."""
    return (os.environ.get("LLM_PROVIDER", "") or "openrouter").strip().lower() or "openrouter"


def _resolve_provider() -> tuple[str, str, str, dict[str, str]]:
    """Resolve (provider, base_url, api_key, default_headers) from env.

    Selection is env-var only — no registry, no YAML. `LLM_PROVIDER` unset (or
    `openrouter`) reproduces today's request byte-for-byte: OPENROUTER_API_KEY,
    the OpenRouter base URL, and the HTTP-Referer/X-Title attribution headers.
    Any other provider speaks the same OpenAI wire protocol at a different base
    URL with LLM_API_KEY. `custom` (or an unknown value) targets an
    OpenAI-compatible server (Ollama/LM Studio/vLLM) via LLM_BASE_URL.
    """
    provider = _llm_provider()
    base_override = os.environ.get("LLM_BASE_URL", "").strip()
    if provider == "openrouter":
        api_key = os.environ.get("OPENROUTER_API_KEY")
        if not api_key:
            raise RuntimeError("OPENROUTER_API_KEY is not set")
        headers = {
            "HTTP-Referer": os.environ.get(
                "OPENROUTER_REFERER", "https://github.com/eren23/openflipbook"
            ),
            "X-Title": "Endless Canvas",
        }
        return provider, base_override or OPENROUTER_BASE_URL, api_key, headers
    base_url = base_override or _LLM_BASE_URLS.get(provider, "")
    if not base_url:
        raise RuntimeError(
            f"LLM_BASE_URL must be set for LLM_PROVIDER={provider!r} "
            "(e.g. http://localhost:11434/v1 for Ollama)"
        )
    api_key = os.environ.get("LLM_API_KEY", "").strip()
    if not api_key:
        if provider == "custom":
            # Local OpenAI-compatible servers usually need no auth, but the
            # SDK requires a non-empty string.
            api_key = "sk-noauth"
        else:
            raise RuntimeError(f"LLM_API_KEY is not set for LLM_PROVIDER={provider!r}")
    return provider, base_url, api_key, {}


def _client() -> AsyncOpenAI:
    """Module-level singleton AsyncOpenAI client.

    Constructing AsyncOpenAI is cheap individually (~5 ms) but happens up to 4
    times per /sse/generate today; the underlying httpx pool also restarts
    each time, so warm keepalives never benefit. Reuse one instance.
    """
    from providers import mock

    if mock.on():
        # MOCK_PROVIDERS: ONE seam covers every text/VLM/judge call (the
        # judges borrow this client too) — zero keys, zero network.
        return mock.mock_llm_client()  # type: ignore[return-value]
    global _OPENAI_CLIENT
    if _OPENAI_CLIENT is None:
        provider, base_url, api_key, headers = _resolve_provider()
        _OPENAI_CLIENT = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
            default_headers=headers or None,
            # _create_with_retry is the single source of retry truth — disable
            # the SDK's own 2 retries so a transient 429/5xx can't fan out to
            # (2+1)*(2+1)=9 paid attempts per logical call.
            max_retries=0,
            # Cap per-request wall time so a hung upstream can't pin a container
            # (and its Modal slot) for the SDK default of 600s. Env-tunable.
            timeout=_request_timeout_s(),
        )
        # Surface the resolved provider + structured-output tier on cold start
        # so a deployer who swapped providers/models sees a weak model fall to
        # the prompt+repair tier in the logs, rather than discovering degraded
        # click-grounding / extraction quality weeks later.
        try:
            from obs import log

            vlm = _vlm_model()
            txt = _text_model(online=False)
            log(
                "info",
                "llm.startup",
                provider=provider,
                base_url=base_url,
                vlm_model=vlm,
                text_model=txt,
                vlm_tier=_resolve_structured_tier(provider, vlm),
                text_tier=_resolve_structured_tier(provider, txt),
            )
            for role, model in (("vlm", vlm), ("text", txt)):
                if _resolve_structured_tier(provider, model) == "prompt":
                    log(
                        "warn",
                        "llm.weak_structured_output",
                        role=role,
                        model=model,
                        note="No JSON mode / tool-calling detected — using prompt+repair. "
                        "Structured quality (click grounding, extraction) may degrade. "
                        "Set LLM_STRUCTURED_OUTPUT to override.",
                    )
        except Exception:
            # `obs` import or log call should never block client init.
            pass
    return _OPENAI_CLIENT


def _cache_enabled() -> bool:
    return env_flag("OPENROUTER_CACHE", "true")


def _system_message(text: str) -> Any:
    """System message body. Wraps in a content-block list with `cache_control`
    when caching is enabled, so OpenRouter passes the marker through to
    backends that honour it (Anthropic, Gemini-on-Vertex). Backends that
    don't recognise the marker ignore it silently — no behavior regression.
    """
    if _cache_enabled():
        return {
            "role": "system",
            "content": [
                {
                    "type": "text",
                    "text": text,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
        }
    return {"role": "system", "content": text}


def _log_cache_usage(span_ctx: dict[str, Any], response: Any) -> None:
    try:
        usage = getattr(response, "usage", None)
        if not usage:
            return
        details = getattr(usage, "prompt_tokens_details", None)
        cached = (
            getattr(details, "cached_tokens", None)
            if details is not None
            else None
        )
        if cached is not None:
            span_ctx["cached_tokens"] = cached
        prompt_tokens = getattr(usage, "prompt_tokens", None)
        if prompt_tokens is not None:
            span_ctx["prompt_tokens"] = prompt_tokens
    except Exception:
        pass


def _vlm_model() -> str:
    # LLM_VLM_MODEL (provider-native slug) wins; OPENROUTER_VLM_MODEL is the
    # back-compat path; then the built-in default.
    return (
        os.environ.get("LLM_VLM_MODEL")
        or os.environ.get("OPENROUTER_VLM_MODEL")
        or DEFAULT_VLM_MODEL
    )


def _web_search_enabled(online: bool) -> bool:
    if not online:
        return False
    # Web search here is OpenRouter's :online / web-plugin brokering, which
    # only exists on the openrouter provider. On direct providers there is no
    # equivalent on this path, so report disabled (the planner still works,
    # just without OpenRouter-brokered grounding).
    if _llm_provider() != "openrouter":
        return False
    return env_flag("OPENROUTER_ENABLE_WEB_SEARCH", "true")


def _supports_online_suffix(model: str) -> bool:
    # Gemini-family on OpenRouter requires the web plugin path; other models
    # accept the `:online` suffix shorthand.
    return "gemini" not in model.lower()


# `response_format={"type": "json_object"}` isn't universally supported on
# OpenRouter: most Mistral / Grok / older Llama slugs silently strip it and
# return freeform text, which `_safe_json` then collapses to `{}` — silently
# breaking the world-memory pipeline + planner JSON contract. Branch by model
# family so a deployer can swap to any known-good family without losing
# structured output.
_STRUCTURED_OUTPUT_FAMILIES = ("gemini", "gpt", "claude", "qwen")

# Instruct tunes that follow forced tool-calls more reliably than JSON mode.
# Used only on direct/custom providers (e.g. a local Ollama/vLLM server); the
# openrouter path never selects the tool rung, preserving today's behavior.
_TOOL_CALL_FAMILIES = ("llama", "mistral", "mixtral", "hermes", "command")


def _supports_structured_output(model: str) -> bool:
    m = model.lower()
    return any(family in m for family in _STRUCTURED_OUTPUT_FAMILIES)


def _resolve_structured_tier(provider: str, model: str) -> str:
    """Pick how to coax structured JSON out of (provider, model).

    Returns one of ``json_object`` | ``tool`` | ``prompt`` (descending
    fidelity). `LLM_STRUCTURED_OUTPUT` (default ``auto``) lets an operator pin
    a tier explicitly. This is a pure substring ladder — data, not a registry.

    On the **openrouter** provider a known-good family resolves to
    ``json_object`` and everything else falls to ``prompt``. The ``tool`` rung
    is reserved for direct/custom providers.
    """
    override = os.environ.get("LLM_STRUCTURED_OUTPUT", "auto").strip().lower()
    if override and override != "auto":
        return override
    m = model.lower()
    if provider in ("openai", "google", "anthropic"):
        # All three honour json_object on their OpenAI-compatible endpoints.
        return "json_object"
    if provider == "openrouter":
        return "json_object" if _supports_structured_output(model) else "prompt"
    # custom / unknown (local OpenAI-compatible servers): decide by family.
    if any(fam in m for fam in _STRUCTURED_OUTPUT_FAMILIES):
        return "json_object"
    if any(fam in m for fam in _TOOL_CALL_FAMILIES):
        return "tool"
    return "prompt"


def _maybe_response_format(model: str) -> dict[str, Any]:
    """Returns the kwargs slice to pass to `chat.completions.create` when
    `response_format` is supported, or `{}` otherwise. Callers spread it
    into their kwargs so a non-supporting model just gets a freeform call
    that `_safe_json` can still recover the best-effort JSON from."""
    if _supports_structured_output(model):
        return {"response_format": {"type": "json_object"}}
    return {}


def _text_model(online: bool) -> str:
    base = (
        os.environ.get("LLM_TEXT_MODEL")
        or os.environ.get("OPENROUTER_TEXT_MODEL")
        or DEFAULT_TEXT_MODEL
    )
    if _web_search_enabled(online) and _supports_online_suffix(base):
        return f"{base}:online"
    return base


def _web_plugin_extra(model: str, online: bool) -> dict[str, Any]:
    if _web_search_enabled(online) and not _supports_online_suffix(model):
        return {"plugins": [{"id": "web"}]}
    return {}


_TIER_LADDER = ("json_object", "tool", "prompt")

_JSON_ONLY_HINT = (
    "IMPORTANT: Respond with ONLY a single JSON object matching the shape "
    "described above. No prose, no explanation, no markdown code fences."
)
_JSON_REPAIR_HINT = (
    "Your previous reply was not valid JSON. Output ONLY the JSON object — "
    "no prose, no code fences, nothing else."
)


def _safe_log(level: str, event: str, **kv: Any) -> None:
    """Best-effort structured log that never raises into the request path."""
    try:
        from obs import log

        log(level, event, **kv)
    except Exception:
        pass


def _tier_attempts(tier: str) -> list[str]:
    """The ordered rungs to try for a starting tier (degrade-on-error path).

    `json_schema` is not implemented yet, so it maps to `json_object` (the
    closest structured rung); an unknown override starts at the top so it still
    walks the full ladder.
    """
    start = "json_object" if tier == "json_schema" else tier
    if start not in _TIER_LADDER:
        start = "json_object"
    idx = _TIER_LADDER.index(start)
    return list(_TIER_LADDER[idx:])


def _rung_kwargs(rung: str, schema: dict[str, Any] | None, schema_name: str) -> dict[str, Any]:
    """The create() kwargs specific to a rung. Spread by the caller so the
    structured params bypass the SDK's strict per-arg typing, matching the
    existing `**_maybe_response_format(...)` pattern."""
    if rung == "json_object":
        return {"response_format": {"type": "json_object"}}
    if rung == "tool":
        return {
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": schema_name,
                        "parameters": schema or {"type": "object"},
                    },
                }
            ],
            "tool_choice": {"type": "function", "function": {"name": schema_name}},
        }
    return {}


def _with_json_hint(messages: list[Any], hint: str) -> list[Any]:
    """Append a JSON-only instruction to the last user turn.

    Weak local models often ignore a trailing system message, so the hint
    rides on the user turn. Handles both string content and the multimodal
    block-list shape (text + image_url).
    """
    out: list[Any] = [dict(m) for m in messages]
    for m in reversed(out):
        if m.get("role") == "user":
            content = m.get("content")
            if isinstance(content, str):
                m["content"] = f"{content}\n\n{hint}"
            elif isinstance(content, list):
                m["content"] = [*content, {"type": "text", "text": hint}]
            return out
    out.append({"role": "system", "content": hint})
    return out


def _choice_content(response: Any) -> str:
    try:
        if not response.choices:
            return ""
        return response.choices[0].message.content or ""
    except Exception:
        return ""


def _parse_choice_json(response: Any) -> dict[str, Any]:
    return _safe_json(_choice_content(response).strip() or "{}")


def _parse_tool_json(response: Any) -> dict[str, Any]:
    try:
        if not response.choices:
            return {}
        msg = response.choices[0].message
        tool_calls = getattr(msg, "tool_calls", None)
        if tool_calls:
            args = tool_calls[0].function.arguments
            if args:
                return _safe_json(args)
        # Some servers ignore tool_choice and answer in content instead.
        return _safe_json((msg.content or "{}").strip())
    except Exception:
        return {}


def _coerce_json_dict(parsed: Any) -> dict[str, Any] | None:
    """A reply that should be one object sometimes arrives list-wrapped
    ([{...}]) — gemini does this occasionally even under response_format
    json_object, and it took the whole click path down in prod. Unwrap to
    the first dict; anything else is a miss."""
    if isinstance(parsed, list):
        parsed = next((p for p in parsed if isinstance(p, dict)), None)
    return cast(dict[str, Any], parsed) if isinstance(parsed, dict) else None


def salvage_json(raw: str) -> tuple[Any, str | None]:
    """Parse a VLM JSON reply, salvaging what a truncated reply left intact.

    Returns (payload, failure). failure is None on a clean parse; otherwise a
    short reason for the caller to LOG — silence is how the located=0 bug
    hid. A max_tokens-truncated reply cuts mid-array, but every complete
    element before the cut is still valid JSON: walk them with raw_decode
    instead of collapsing the whole reply to {} (partial detections beat
    none). Pure — no I/O, no logging."""
    # Clean paths first: full parse, then the brace-slice (prose-wrapped JSON).
    try:
        coerced = _coerce_json_dict(json.loads(raw))
        if coerced is not None:
            return coerced, None
    except json.JSONDecodeError:
        pass
    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        try:
            coerced = _coerce_json_dict(json.loads(raw[start : end + 1]))
            if coerced is not None:
                return coerced, None
        except json.JSONDecodeError:
            pass
    # Salvage: locate the first top-level array — keyed ({"detections": [...)
    # or bare ([...) — and decode complete elements until the cut.
    m = re.search(r'"([^"\\]+)"\s*:\s*\[', raw)
    key = m.group(1) if m else None
    arr_start = m.end() if m else raw.find("[") + 1
    if arr_start <= 0:
        return {}, "unparseable"
    decoder = json.JSONDecoder()
    items: list[Any] = []
    i = arr_start
    n = len(raw)
    while i < n:
        while i < n and raw[i] in " \t\r\n,":
            i += 1
        if i >= n or raw[i] == "]":
            break
        try:
            item, i = decoder.raw_decode(raw, i)
        except json.JSONDecodeError:
            break
        items.append(item)
    if not items:
        return {}, "unparseable"
    payload: Any = {key: items} if key else items
    return payload, f"salvaged {len(items)} of truncated array {key or '<bare>'}"


def _safe_json(raw: str) -> dict[str, Any]:
    payload, failure = salvage_json(raw)
    if failure is not None:
        # Truncation/garbage used to collapse to {} in total silence here —
        # every _complete_json caller then saw an empty diff and moved on.
        _safe_log("warn", "llm.json_salvage", failure=failure, reply_chars=len(raw))
    if isinstance(payload, dict):
        return payload
    return _coerce_json_dict(payload) or {}


# Transient upstream failures worth a retry — NOT BadRequestError (a 400 means
# the request itself is wrong; that's the tier-downgrade path, not a retry).
_TRANSIENT_LLM_ERRORS = (
    APITimeoutError,
    APIConnectionError,
    RateLimitError,
    InternalServerError,
)


def _request_timeout_s() -> float:
    """Per-request wall-clock cap for the LLM/VLM client (LLM_REQUEST_TIMEOUT_S,
    default 60s, floor 5s). The SDK default is 600s — far too long to hold a
    container slot on a hung upstream."""
    try:
        return max(5.0, float(os.environ.get("LLM_REQUEST_TIMEOUT_S", "") or 60.0))
    except ValueError:
        return 60.0


async def _create_with_retry(
    client: Any,
    *,
    max_retries: int = 2,
    base_delay: float = 1.0,
    **kwargs: Any,
) -> Any:
    """chat.completions.create with exponential backoff on TRANSIENT errors.

    The planner (plan_page) was killed by a single APITimeoutError on the
    Gemini/OpenRouter web-search path; one flaky upstream request shouldn't fail
    the whole generation. Retries timeouts / rate-limits / connection / 5xx with
    backoff; re-raises anything else (incl. BadRequestError) immediately so the
    tier-downgrade ladder still works.
    """
    last: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            return await client.chat.completions.create(**kwargs)
        except _TRANSIENT_LLM_ERRORS as err:
            last = err
            if attempt == max_retries:
                break
            delay = base_delay * (2**attempt)
            _llm._safe_log(
                "warn",
                "llm.retry",
                error=type(err).__name__,
                attempt=attempt + 1,
                max_retries=max_retries,
                delay=delay,
                model=kwargs.get("model"),
            )
            await asyncio.sleep(delay)
    assert last is not None
    raise last


async def _complete_json(
    *,
    model: str,
    messages: list[Any],
    max_tokens: int,
    temperature: float,
    schema: dict[str, Any] | None = None,
    schema_name: str = "result",
    extra_body: dict[str, Any] | None = None,
    span_ctx: dict[str, Any] | None = None,
    response_sink: list[Any] | None = None,
) -> dict[str, Any]:
    """Issue a chat completion and return parsed JSON, degrading gracefully.

    Picks a structured-output strategy via `_resolve_structured_tier`, then
    walks DOWN the ladder (json_object -> tool -> prompt) if a provider rejects
    the chosen mechanism with a 400. The prompt rung adds a JSON-only hint and
    one repair retry. The caller's existing `_build_*` / `_parse_*` coercers
    stay the source of truth, so a weak model degrades to "thinner but valid"
    rather than crashing. On the default OpenRouter path this issues the exact
    same json_object request as before.

    `response_sink`, when provided, receives the final raw response object so a
    caller that needs more than the parsed JSON (e.g. the planner reading
    OpenRouter citation annotations) can reach it without changing the return.
    """
    client = _llm._client()
    provider = _llm_provider()
    tier = _resolve_structured_tier(provider, model)
    if span_ctx is not None:
        span_ctx["structured_tier"] = tier
    attempts = _tier_attempts(tier)
    eb = extra_body or None
    last_error: BadRequestError | None = None

    for i, rung in enumerate(attempts):
        kw = _rung_kwargs(rung, schema, schema_name)
        call_messages = (
            _with_json_hint(messages, _JSON_ONLY_HINT) if rung == "prompt" else messages
        )
        try:
            response = await _create_with_retry(
                client,
                model=model,
                messages=call_messages,
                temperature=temperature,
                max_tokens=max_tokens,
                extra_body=eb,
                **kw,
            )
            parsed = _parse_tool_json(response) if rung == "tool" else _parse_choice_json(response)
            if rung == "prompt" and not parsed and _choice_content(response).strip():
                # ONE repair retry — the model emitted prose, nudge harder.
                response = await _create_with_retry(
                    client,
                    model=model,
                    messages=_with_json_hint(messages, _JSON_REPAIR_HINT),
                    temperature=temperature,
                    max_tokens=max_tokens,
                    extra_body=eb,
                )
                parsed = _parse_choice_json(response)
            if span_ctx is not None:
                _log_cache_usage(span_ctx, response)
                finish_reason = (
                    getattr(response.choices[0], "finish_reason", None)
                    if response.choices
                    else None
                )
                if finish_reason:
                    span_ctx["finish_reason"] = finish_reason
            if response_sink is not None:
                response_sink.append(response)
            return parsed
        except BadRequestError as err:
            last_error = err
            next_tier = attempts[i + 1] if i + 1 < len(attempts) else None
            _llm._safe_log(
                "warn",
                "llm.tier_downgrade",
                model=model,
                from_tier=rung,
                next_tier=next_tier,
            )
            continue
    if last_error is not None:
        raise last_error
    return {}
