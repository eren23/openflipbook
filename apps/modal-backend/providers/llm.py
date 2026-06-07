"""OpenRouter-backed LLM/VLM client.

Uses the openai SDK pointed at https://openrouter.ai/api/v1. Defaults are
Gemini 3 Flash (multimodal) for both planning and click-resolution — strong
JSON adherence, large context, cheap. Override via env to use Gemini 3 Pro
or another OpenRouter slug.

Web search: Gemini-family models on OpenRouter don't accept the legacy
`:online` suffix universally, so for those we attach the OpenRouter web
plugin (`extra_body={"plugins": [{"id": "web"}]}`) instead. Other models
keep the `:online` suffix path.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, TypeGuard, cast

from openai import AsyncOpenAI, BadRequestError

from _env import env_flag

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


@dataclass
class Citation:
    url: str
    title: str | None = None


@dataclass
class PagePlan:
    page_title: str
    prompt: str
    facts: list[str]
    sources: list[Citation]


@dataclass
class ClickResolution:
    subject: str
    style: str
    # One-sentence definition of `subject` *as it appears in the parent
    # illustration*. The VLM is the only call site that actually sees the
    # parent image, so it's the right place to disambiguate ambiguous
    # phrases ("Memory Bank" in a SAM 2 diagram vs in a Cursor agent doc).
    # Threaded into plan_page as ground truth so the planner can't drift
    # domains even when web search surfaces a more popular meaning.
    subject_context: str = ""
    # Groundability: did the VLM actually see something meaningful under the
    # crosshair, or is it confabulating? GroundingME (arXiv:2512.17495)
    # reports ~0% rejection rate on current VLMs, so we ask explicitly.
    # ``confidence`` is 0..1; the client can render a "tap something
    # specific?" hint when low. Default True/1.0 keeps the field backward-
    # compatible when older callers / models omit it.
    groundable: bool = True
    confidence: float = 1.0
    # VLM's own best-estimate centroid + bounding box of the resolved
    # subject (0..1 normalised in the image's own frame). Powers the
    # "we think you tapped this — yes/try again" overlay UX. Both optional
    # because not every VLM emits them; older payloads default to None.
    point: tuple[float, float] | None = None
    bbox: tuple[float, float, float, float] | None = None
    # Scale of `subject` relative to the parent's focal subject: "component"
    # (a part of it / smaller), "peer" (beside it / similar), or "container"
    # (it is part of this / bigger). Powers the scale-space map + zoom
    # level-of-detail. Default "peer" keeps older payloads valid.
    scale: str = "peer"
    # World Mode: the VLM's read of what the tapped thing is — "scene" (a place
    # to step INTO), "submap" (a sub-area to map closer), or "explainer" (an
    # object/concept to diagram). Drives the planner's render framing. Default
    # "explainer" keeps classic tap=learn behaviour for non-world callers.
    enter_as: str = "explainer"
    # Semi-autonomy: up to two short clarifying questions to ask before entering
    # (e.g. "Day or night?"). Empty in auto mode and in classic (non-world) mode.
    clarifiers: list[str] = field(default_factory=list)
    # World Mode spatial anchor: what is adjacent to the tapped spot and in which
    # direction, so the entered place keeps its neighbours where the parent map
    # had them. Empty in classic mode.
    surroundings: str = ""


@dataclass
class ClickCandidate:
    """One pre-resolved tappable region for a freshly rendered page.

    Coordinates are 0..1 normalised in the parent image's own frame. Used to
    warm the hover-prefetch cache so a click that lands inside a candidate
    bucket skips the VLM round-trip entirely.
    """

    x_pct: float
    y_pct: float
    subject: str
    style: str
    salience: float


@dataclass
class Neighbor:
    """One proposed neighbouring subject for the expand-outward bloom.

    `scale` is relative to the page's focal subject (see SCALE_KINDS):
    "component" (smaller / a part), "peer" (similar), "container" (bigger).
    """

    subject: str
    scale: str = "peer"
    note: str = ""


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


@dataclass
class ExtractedEntity:
    kind: str
    name: str
    appearance: str
    aliases: list[str]
    facts: list[str]
    # Mirrors EntityState in packages/config: primitive-only key/value bag
    # (the builder below already drops non-primitives), not freeform JSON.
    state: dict[str, str | int | float | bool]
    confidence: float
    bbox: dict[str, float] | None = None


@dataclass
class EntityUpdate:
    match_name: str
    changes: dict[str, Any]
    confidence: float
    # Re-localized box on the current node. The VLM doesn't emit this; the
    # extract endpoint's detector fills it so recurring entities keep a
    # per-node bbox for geometry + the overlay.
    bbox: dict[str, float] | None = None


@dataclass
class EntityExtractionResult:
    added: list[ExtractedEntity]
    updated: list[EntityUpdate]


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
    global _OPENAI_CLIENT
    if _OPENAI_CLIENT is None:
        provider, base_url, api_key, headers = _resolve_provider()
        _OPENAI_CLIENT = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
            default_headers=headers or None,
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


# JSON Schemas for the structured-output ladder. Used as the `tool` rung's
# function parameters and as a shape hint for the `prompt` rung. They are an
# upstream nudge only — the `_build_*` / `_parse_*` coercers below remain the
# source of truth, which is why a weak model degrades to "thinner but valid".
CLICK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "subject": {"type": "string"},
        "style": {"type": "string"},
        "subject_context": {"type": "string"},
        "groundable": {"type": "boolean"},
        "confidence": {"type": "number"},
        "point": {
            "type": "object",
            "properties": {"x": {"type": "number"}, "y": {"type": "number"}},
        },
        "bbox": {
            "type": "object",
            "properties": {
                "x": {"type": "number"},
                "y": {"type": "number"},
                "w": {"type": "number"},
                "h": {"type": "number"},
            },
        },
        "scale": {"type": "string", "enum": ["component", "peer", "container"]},
        "enter_as": {"type": "string", "enum": ["scene", "submap", "explainer"]},
        "clarifiers": {"type": "array", "items": {"type": "string"}},
        "surroundings": {"type": "string"},
    },
    "required": ["subject"],
}

PLAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "page_title": {"type": "string"},
        "prompt": {"type": "string"},
        "facts": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["page_title", "prompt"],
}

CANDIDATES_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "x_pct": {"type": "number"},
                    "y_pct": {"type": "number"},
                    "subject": {"type": "string"},
                    "style": {"type": "string"},
                    "salience": {"type": "number"},
                },
                "required": ["x_pct", "y_pct", "subject"],
            },
        }
    },
    "required": ["candidates"],
}

NEIGHBORS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "neighbors": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "subject": {"type": "string"},
                    "scale": {
                        "type": "string",
                        "enum": ["component", "peer", "container"],
                    },
                    "note": {"type": "string"},
                },
                "required": ["subject"],
            },
        }
    },
    "required": ["neighbors"],
}

EXTRACTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "added": {"type": "array", "items": {"type": "object"}},
        "updated": {"type": "array", "items": {"type": "object"}},
    },
    "required": ["added", "updated"],
}

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
    client = _client()
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
            response = await client.chat.completions.create(
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
                response = await client.chat.completions.create(
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
            _safe_log(
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


async def click_to_subject(
    image_data_url: str,
    x_pct: float,
    y_pct: float,
    parent_title: str,
    parent_query: str,
    output_locale: str | None = None,
    user_hint: str | None = None,
    prior_rejected_subject: str | None = None,
    world_mode: bool = False,
    autonomy: str = "auto",
) -> ClickResolution:
    """Resolve the click region to a subject phrase AND a style descriptor.

    The image has a red crosshair at the click point (see
    `apps/web/lib/image-click.ts:annotateClickPoint`); numeric coords are a
    fallback. We also ask the VLM to summarise the illustration's visual
    style so the next page can match it — cheapest way to keep aesthetic
    continuity across hops without a second VLM round-trip.

    Also asks the VLM to self-report ``groundable`` + ``confidence`` and
    its best-estimate ``point``/``bbox`` of the resolved subject. The
    client uses these for the "we think you tapped this — yes/try again"
    UX and to suppress page-generation on empty-region taps.

    ``prior_rejected_subject`` lets the caller signal that the user just
    rejected a previous resolution near this tap, which gives the VLM a
    multi-turn conversational refer signal ("you said X — what else
    could this be?"). Inspired by SAMA / MM-Conv dialog grounding.
    """
    locale_clause = (
        f" The `subject` MUST be written in language code '{output_locale}' — "
        "the next page is being generated in that language and the subject "
        "phrase will be the page title."
        if output_locale and output_locale.lower() not in ("en", "auto", "")
        else ""
    )
    # World Mode adds a classification field so the caller can decide whether a
    # tap ENTERS a place (scene / closer sub-map) or explains a concept, and —
    # in semi autonomy — proposes a couple of short questions to ask first.
    world_clause = ""
    if world_mode:
        world_clause = (
            " (9) `enter_as` — one of \"scene\", \"submap\", or \"explainer\": "
            "\"scene\" when the crosshair is on a PLACE the user would step INTO "
            "(a building, street, district, room, landscape, ship/vehicle "
            "interior); \"submap\" when it is a sub-region of a map or area best "
            "shown as a CLOSER MAP; \"explainer\" when it is an object, "
            "mechanism, or concept best shown as a labelled diagram."
            " (10) `surroundings` — a short phrase (<=30 words) naming what sits "
            "immediately AROUND the crosshair and in which direction, read from "
            "the parent image's own layout (e.g. \"the river runs along the "
            "south, a row of timbered houses to the west, a market square to the "
            "north-east\"). This anchors the entered place so its neighbours "
            "stay where they are. Empty string if nothing is discernible."
        )
        if autonomy == "semi":
            world_clause += (
                " (11) `clarifiers` — an array of AT MOST 2 very short questions "
                "(<=8 words each) whose answers would change how this place is "
                "drawn (e.g. \"Day or night?\", \"Bustling or abandoned?\"). "
                "Return an empty array when you are confident or when `enter_as` "
                "is \"explainer\"."
            )
    system = (
        "You examine a generated illustration of the page titled "
        f"'{parent_title}' (user query: '{parent_query}'). A red crosshair with "
        "a white halo has been drawn on the image to mark where the user "
        "clicked. Return ONE JSON object with these fields: "
        "(1) `subject` — a 2-8 word noun phrase naming the specific thing "
        "under the crosshair (ignore the crosshair itself); should make a "
        "good next query for a visual explainer. "
        "(2) `style` — a single sentence (<=30 words) describing the "
        "illustration's visual style: art medium (e.g. flat infographic, "
        "watercolor, technical line drawing, photoreal, anime, blueprint), "
        "dominant palette, line work, level of detail, perspective. "
        "(3) `subject_context` — a single sentence (<=35 words) defining what "
        "the subject IS in this specific illustration's domain. Be concrete: "
        "name the parent system, what role the subject plays inside it, and "
        "why it's there. This is the disambiguation. If `subject` is "
        "\"Memory Bank\" inside a video-segmentation architecture, the context "
        "is \"per-object memory store the tracker uses to keep object "
        "identity across frames\" — NOT a generic definition. "
        "(4) `groundable` — boolean. true when the crosshair is on a "
        "concrete, depicted object/label/region that you can name with "
        "confidence; false when it is on empty background, decorative "
        "stippling, or otherwise non-meaningful. Be honest: it is "
        "better to return groundable=false with a best-guess subject "
        "than to confabulate. "
        "(5) `confidence` — number in [0,1]; how sure you are that the "
        "subject you named is what the user intended to tap. "
        "(6) `point` — your best-estimate centroid of the resolved "
        "subject as {\"x\": <0-1>, \"y\": <0-1>} in the image's own frame "
        "(0,0 top-left). Use the crosshair location as a strong prior. "
        "(7) `bbox` — optional axis-aligned bounding box around the "
        "subject as {\"x\": <0-1>, \"y\": <0-1>, \"w\": <0-1>, \"h\": <0-1>}. "
        "Omit if you cannot give a tight box. "
        "(8) `scale` — the subject's size relative to the page's overall focal "
        "subject: \"component\" (a part of it / smaller), \"peer\" (a separate "
        "thing of similar size), or \"container\" (a larger thing the focal "
        "subject is part of). Default to \"peer\" when unsure."
        + world_clause
        + locale_clause
    )
    hint_clause = ""
    if user_hint:
        hint_clause = (
            "\n\nUser's note for this click (treat as guidance for what they "
            f"want from the subject phrase): \"{user_hint}\". "
            "Let it shape the angle/framing of the subject if relevant, but "
            "keep the subject concrete and grounded in what's actually under "
            "the crosshair."
        )
    refer_clause = ""
    if prior_rejected_subject:
        refer_clause = (
            "\n\nMulti-turn refer: the user just rejected the previous "
            f"resolution \"{prior_rejected_subject}\" near this tap. Pick a "
            "DIFFERENT plausible subject under the crosshair — favour a "
            "neighbouring element, a sibling label, or a part-of-X if the "
            "previous reading was an X. Do NOT return the same subject again."
        )
    user_text = (
        "Look at the red crosshair marker on the image and tell me the "
        "specific subject beneath it. Also describe the visual style of "
        "the illustration so the next page can be drawn in the SAME style. "
        "If the crosshair is not visible for any reason, fall back to the "
        f"numeric position x={x_pct:.3f}, y={y_pct:.3f} "
        "(0-1 normalized, origin top-left)."
        + hint_clause
        + refer_clause
    )
    from obs import span

    async with span("vlm.click_to_subject", model=_vlm_model()) as ctx:
        parsed = await _complete_json(
            model=_vlm_model(),
            messages=[
                _system_message(system),
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_text},
                        {
                            "type": "image_url",
                            "image_url": {"url": image_data_url, "detail": "high"},
                        },
                    ],
                },
            ],
            schema=CLICK_SCHEMA,
            schema_name="click_resolution",
            temperature=0.2,
            max_tokens=400,
            span_ctx=ctx,
        )
    return _build_click_resolution(parsed, x_pct=x_pct, y_pct=y_pct, fallback_subject=parent_title)


def _coerce_unit(value: Any) -> float | None:
    """Coerce a JSON value to a clamped [0,1] float, or None if non-numeric."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    if f < 0.0:
        return 0.0
    if f > 1.0:
        return 1.0
    return f


def _parse_point(raw: Any) -> tuple[float, float] | None:
    """Accept {"x": .., "y": ..} or [x, y] or null. Out-of-range → clamped."""
    if isinstance(raw, dict):
        x = _coerce_unit(raw.get("x"))
        y = _coerce_unit(raw.get("y"))
    elif isinstance(raw, (list, tuple)) and len(raw) >= 2:
        x = _coerce_unit(raw[0])
        y = _coerce_unit(raw[1])
    else:
        return None
    if x is None or y is None:
        return None
    return (x, y)


def _parse_bbox(raw: Any) -> tuple[float, float, float, float] | None:
    """Accept {x,y,w,h} or [x,y,w,h]. Returns None if any component invalid."""
    if isinstance(raw, dict):
        x = _coerce_unit(raw.get("x"))
        y = _coerce_unit(raw.get("y"))
        w = _coerce_unit(raw.get("w") or raw.get("width"))
        h = _coerce_unit(raw.get("h") or raw.get("height"))
    elif isinstance(raw, (list, tuple)) and len(raw) >= 4:
        x = _coerce_unit(raw[0])
        y = _coerce_unit(raw[1])
        w = _coerce_unit(raw[2])
        h = _coerce_unit(raw[3])
    else:
        return None
    if x is None or y is None or w is None or h is None:
        return None
    if w == 0.0 or h == 0.0:
        return None
    return (x, y, w, h)


def _build_click_resolution(
    parsed: dict[str, Any],
    *,
    x_pct: float,
    y_pct: float,
    fallback_subject: str,
) -> ClickResolution:
    """Map the VLM's JSON payload onto a ClickResolution with safe defaults.

    Older models / out-of-distribution prompts may omit the groundability /
    point / bbox fields entirely. We fill them in with conservative
    defaults (groundable=True, confidence=1.0, point=crosshair) so the
    upstream UX never breaks; downstream code can still inspect for
    explicit ``False`` to render the low-confidence warning.
    """
    subject = str(parsed.get("subject", "")).strip()
    style = str(parsed.get("style", "")).strip()
    subject_context = str(parsed.get("subject_context", "")).strip()

    groundable_raw = parsed.get("groundable")
    if isinstance(groundable_raw, bool):
        groundable = groundable_raw
    elif isinstance(groundable_raw, str):
        groundable = groundable_raw.lower() not in ("false", "no", "0")
    else:
        groundable = True

    confidence = _coerce_unit(parsed.get("confidence"))
    if confidence is None:
        confidence = 1.0

    point = _parse_point(parsed.get("point"))
    if point is None:
        # Crosshair location is the strongest fallback — that's where the
        # user actually tapped, even if the VLM didn't echo it back.
        point = (
            _coerce_unit(x_pct) or 0.0,
            _coerce_unit(y_pct) or 0.0,
        )
    bbox = _parse_bbox(parsed.get("bbox"))
    scale = _coerce_scale(parsed.get("scale"))

    # World Mode fields — absent on classic payloads, so default to the
    # explainer framing with no questions (keeps tap=learn behaviour intact).
    enter_as = str(parsed.get("enter_as", "")).strip().lower()
    if enter_as not in ("scene", "submap", "explainer"):
        enter_as = "explainer"
    clarifiers_raw = parsed.get("clarifiers")
    clarifiers = (
        [c.strip() for c in clarifiers_raw if isinstance(c, str) and c.strip()][:2]
        if isinstance(clarifiers_raw, list)
        else []
    )
    surroundings = str(parsed.get("surroundings", "")).strip()

    return ClickResolution(
        subject=subject or fallback_subject,
        style=style,
        subject_context=subject_context,
        groundable=groundable,
        confidence=confidence,
        point=point,
        bbox=bbox,
        scale=scale,
        enter_as=enter_as,
        clarifiers=clarifiers,
        surroundings=surroundings,
    )


def _spatial_anchor_clause(render_mode: str | None, surroundings: str | None) -> str:
    """World Mode spatial anchor: keep the entered place's neighbours where the
    parent map had them. Empty unless we're entering a place AND the resolver
    reported surroundings — so classic + explainer pages are unaffected."""
    rmode = (render_mode or "explainer").lower()
    if rmode not in ("place_scene", "place_submap"):
        return ""
    if not surroundings or not surroundings.strip():
        return ""
    return (
        "SPATIAL ANCHOR (CRITICAL): you are entering this exact spot on the "
        "parent map — keep its neighbours where they are: "
        f"{surroundings.strip()}. Place these surrounding features in the same "
        "relative directions so the view continues the established map rather "
        "than inventing a new layout."
    )


def _render_base_instruction(render_mode: str | None) -> str:
    """The opening planner instruction, keyed by World Mode render mode.

    `place_scene` → an immersive scene the reader steps into (no diagram
    labels); `place_submap` → a closer cartographic map of a sub-area;
    `explainer` (default, and every classic non-world call) → today's
    labelled visual-explainer page, verbatim.
    """
    rmode = (render_mode or "explainer").lower()
    if rmode == "place_scene":
        return (
            "You design an illustrated SCENE the reader has just stepped into — "
            "a place to BE, not a diagram. Return JSON with keys: page_title "
            "(<=8 words, the place's name), prompt (<=120 words describing the "
            "view as if you just walked in — architecture, materials, light, "
            "weather, depth, and the people/creatures and goings-on, as one "
            "coherent illustrated scene with NO callout labels, annotation "
            "lines, or diagram arrows), facts (3-6 short sensory or landmark "
            "details a visitor would notice). Do not include any text outside "
            "the JSON."
        )
    if rmode == "place_submap":
        return (
            "You design a closer MAP of just this district/area — a zoom of the "
            "parent map into this region, in the same cartographic style. Return "
            "JSON with keys: page_title (<=8 words, the area's name), prompt "
            "(<=120 words describing an illustrated map of this sub-area — its "
            "streets, sub-districts and landmarks laid out and named, drawn as a "
            "map and not a scene), facts (3-6 named sub-areas or landmarks shown "
            "on the map). Do not include any text outside the JSON."
        )
    return (
        "You design a visual-explainer page for a given user query. Return "
        "JSON with keys: page_title (<=8 words, title case), prompt (<=120 "
        "words, a rich description of a single illustrated diagram suitable "
        "for a text-capable image model — include labels, annotations, "
        "callouts, and layout hints), facts (list of 3-6 short factual "
        "bullets that should be visible as labels in the illustration). Do "
        "not include any text outside the JSON."
    )


async def plan_page(
    query: str,
    web_search: bool,
    style_anchor: str | None = None,
    output_locale: str | None = None,
    parent_title: str | None = None,
    parent_query: str | None = None,
    subject_context: str | None = None,
    world_context: list[dict[str, Any]] | None = None,
    render_mode: str | None = None,
    surroundings: str | None = None,
) -> PagePlan:
    """Produce a page title, image-gen prompt, and factual snippets for the query.

    `style_anchor` (when set) is the parent illustration's visual style as
    described by the click-resolver VLM. We weave it into both the planner
    system prompt AND the final image-gen prompt so the renderer sees an
    explicit style instruction. Without this, generations drift across hops
    (a flat infographic parent can produce a photoreal child).

    `parent_title`, `parent_query`, and `subject_context` (when set) lock the
    semantic frame. Without them, an ambiguous click subject like "Memory
    Bank" defaults to the most popular web meaning (Cursor-style markdown
    docs) rather than what the user actually clicked on (e.g. SAM 2's
    per-object tracker memory). `subject_context` comes from the click VLM
    and is treated as authoritative — the planner must not contradict it.
    """
    # World Mode reframes the page from a labelled explainer into a PLACE: a
    # scene the reader has stepped into, or a closer cartographic sub-map.
    # `explainer` (the default) is today's behaviour, untouched.
    rmode = (render_mode or "explainer").lower()
    system_parts = [_render_base_instruction(rmode)]
    has_parent_frame = bool(
        (parent_title and parent_title.strip())
        or (parent_query and parent_query.strip())
        or (subject_context and subject_context.strip())
    )
    if has_parent_frame:
        anchor = subject_context.strip() if subject_context else ""
        parent = (parent_title or parent_query or "").strip()
        clause = (
            "DOMAIN LOCK (CRITICAL): the user is exploring this subject AS A "
            f"CHILD of the parent page \"{parent}\". The page you design "
            "MUST stay in the parent's domain — do NOT drift to a different "
            "field even if web search surfaces a more popular meaning of "
            "the subject phrase."
        )
        if anchor:
            clause += (
                f" Treat this as the authoritative definition of the "
                f"subject in this domain: \"{anchor}\". Every fact, label, "
                "and callout you produce MUST be consistent with that "
                "definition. If a web-search result contradicts the "
                "definition, ignore it."
            )
        system_parts.append(clause)
    if style_anchor:
        system_parts.append(
            "VISUAL STYLE LOCK (CRITICAL): the new illustration MUST be drawn "
            f"in this exact style — \"{style_anchor}\". Match the medium, "
            "palette, line work, level of stylization, and perspective. Do "
            "NOT switch to a different art style. Begin the `prompt` with a "
            "leading clause that names the style explicitly so the image "
            "model can lock onto it (e.g. \"Flat infographic illustration "
            "with bold blue accents and clean line work, ...\")."
        )
    if output_locale and output_locale.lower() not in ("en", "auto", ""):
        system_parts.append(
            "OUTPUT LANGUAGE LOCK (CRITICAL): `page_title` and every entry in "
            f"`facts` MUST be written in language code '{output_locale}'. The "
            "image-gen prompt itself stays in English (the renderer is "
            "English-trained), BUT it MUST instruct the renderer to draw all "
            "in-image labels, callouts, and on-page text in "
            f"'{output_locale}'. Include a sentence like \"All labels, "
            "callouts, and text inside the illustration are written in "
            f"{output_locale}.\" near the start of the prompt."
        )
    anchor_clause = _spatial_anchor_clause(rmode, surroundings)
    if anchor_clause:
        system_parts.append(anchor_clause)
    world_clause = _format_world_context_clause(world_context)
    if world_clause:
        system_parts.append(world_clause)
    system = " ".join(system_parts)
    # Web-search benefits hugely from a parent-anchored query. "Memory Bank"
    # alone hits Cursor docs; "Memory Bank SAM 2 video segmentation" lands
    # on the right paper. We compose a search hint here rather than mutating
    # `query` so the planner's title still reflects the user's click target.
    user_parts = [f"Query: {query}"]
    if has_parent_frame:
        parent_label = (parent_title or parent_query or "").strip()
        if parent_label:
            user_parts.append(
                f"Parent page (anchor — do NOT drift away from this domain): "
                f"\"{parent_label}\"."
            )
        if subject_context and subject_context.strip():
            user_parts.append(
                f"Authoritative definition of the subject: "
                f"{subject_context.strip()}"
            )
        if web_search and parent_label:
            # Bias the web-search hop toward the parent's domain.
            user_parts.append(
                "When using web search, search for the subject AS IT "
                f"PERTAINS TO \"{parent_label}\" — not the popular meaning "
                "of the phrase in unrelated fields."
            )
    if rmode == "place_scene":
        user_parts.append(
            "Paint the scene as if the reader just stepped into it. Keep it "
            "readable at 1280x720."
        )
    elif rmode == "place_submap":
        user_parts.append(
            "Draw the district map. Keep the labels readable at 1280x720."
        )
    else:
        user_parts.append(
            "Design the illustrated page. Keep the layout readable at 1280x720."
        )
    user = "\n\n".join(user_parts)
    if style_anchor:
        user += f"\n\nVisual style to preserve verbatim: {style_anchor}"
    from obs import span

    text_model = _text_model(online=web_search)
    response_sink: list[Any] = []
    async with span("planner.plan_page", model=text_model, web_search=web_search) as ctx:
        parsed = await _complete_json(
            model=text_model,
            messages=[
                _system_message(system),
                {"role": "user", "content": user},
            ],
            schema=PLAN_SCHEMA,
            schema_name="page_plan",
            temperature=0.7,
            max_tokens=900,
            extra_body=_web_plugin_extra(text_model, online=web_search) or None,
            span_ctx=ctx,
            response_sink=response_sink,
        )
    page_title = str(parsed.get("page_title", query)).strip() or query
    prompt = str(parsed.get("prompt", query)).strip() or query
    facts_raw = parsed.get("facts", [])
    facts: list[str] = []
    if isinstance(facts_raw, list):
        for f in facts_raw:
            if isinstance(f, str) and f.strip():
                facts.append(f.strip())
    sources = _extract_citations(response_sink[0]) if response_sink else []
    return PagePlan(page_title=page_title, prompt=prompt, facts=facts, sources=sources)


def _format_world_context_clause(
    world_context: list[dict[str, Any]] | None,
) -> str:
    """Compose the continuity-injection clause for the planner system prompt.

    Each entity contributes a single line: `[kind] Name (aka: ...) —
    appearance descriptor; state=k:v,k:v`. The planner is instructed to
    weave these descriptors into the image-gen prompt verbatim whenever
    the entity is depicted, so a recurring character stays visually
    consistent across pages without the user re-typing their look.

    Returns an empty string when world_context is empty — the planner
    behaves exactly as before in cold-start sessions.
    """
    if not world_context:
        return ""
    lines: list[str] = []
    for entry in world_context[:16]:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name", "")).strip()
        appearance = str(entry.get("appearance", "")).strip()
        if not name or not appearance:
            continue
        kind = str(entry.get("kind", "")).strip().lower() or "entity"
        aliases_raw = entry.get("aliases", []) or []
        aliases = (
            [str(a).strip() for a in aliases_raw if isinstance(a, str) and a.strip()]
            if isinstance(aliases_raw, list)
            else []
        )
        state_raw = entry.get("state", {}) or {}
        state_pairs = ""
        if isinstance(state_raw, dict) and state_raw:
            allowed_state = [
                f"{k}={v}"
                for k, v in state_raw.items()
                if isinstance(k, str)
                and isinstance(v, (str, int, float, bool))
            ][:4]
            if allowed_state:
                state_pairs = "; state=" + ", ".join(allowed_state)
        line = f"- [{kind}] {name}"
        if aliases:
            line += f" (aka: {', '.join(aliases[:3])})"
        line += f" — {appearance[:240]}{state_pairs}"
        lines.append(line)
    if not lines:
        return ""
    return (
        "WORLD CONTINUITY (CRITICAL): the session already established the "
        "following recurring entities. Whenever any of them would naturally "
        "appear in this page, render them USING THE APPEARANCE DESCRIPTOR "
        "BELOW verbatim — same outfit, build, palette, props. Do NOT "
        "re-imagine their look. Weave each used descriptor into the image "
        "prompt as a clause like \"<Name>, <appearance descriptor>, ...\". "
        "If an entity is NOT relevant to this page, simply omit it; do not "
        "force entities into the scene.\n\n"
        "CAUSALITY (CRITICAL): each entity's `state=` flags below describe "
        "the CURRENT condition of the entity from prior pages. The "
        "renderer MUST honour these — e.g. `state=door=open` means draw "
        "the door open, `state=lit=true` means the lantern is glowing, "
        "`state=wounded=true` means the character bears their wound. Do "
        "NOT reset state without an explicit narrative reason in the "
        "user's query for this page. If the query itself implies a state "
        "change (e.g. \"shut the door\"), prefer the new state.\n\n"
        + "\n".join(lines)
    )


def _extract_citations(response: Any, max_sources: int = 3) -> list[Citation]:
    """Pull URL citations out of an OpenRouter web-search response.

    OpenRouter's web plugin (and `:online` suffix) attaches `annotations` to
    the message, each shaped like:
        {"type": "url_citation",
         "url_citation": {"url": "...", "title": "...", "content": "..."}}
    The SDK round-trips these as plain dicts on `.message.annotations`.
    Different routers occasionally use the legacy `citations` key on the
    choice itself; tolerate both. Returns top `max_sources` deduped by domain.
    """
    out: list[Citation] = []
    seen: set[str] = set()

    def _push(url: str | None, title: str | None) -> None:
        if not url or not isinstance(url, str):
            return
        u = url.strip()
        if not u.startswith(("http://", "https://")):
            return
        try:
            from urllib.parse import urlparse

            domain = urlparse(u).netloc.lower()
        except Exception:
            domain = u
        if domain in seen:
            return
        seen.add(domain)
        clean_title = title.strip() if isinstance(title, str) and title.strip() else None
        out.append(Citation(url=u, title=clean_title))

    try:
        choice = response.choices[0]
        msg = getattr(choice, "message", None)
        # Newer shape: message.annotations[].url_citation
        annotations = getattr(msg, "annotations", None) if msg else None
        if isinstance(annotations, list):
            for ann in annotations:
                if not isinstance(ann, dict):
                    continue
                if ann.get("type") != "url_citation":
                    continue
                cite = ann.get("url_citation") or {}
                _push(cite.get("url"), cite.get("title"))
                if len(out) >= max_sources:
                    return out
        # Legacy shape: choice.citations = [url, ...] or [{url, title}]
        legacy = getattr(choice, "citations", None)
        if isinstance(legacy, list):
            for entry in legacy:
                if isinstance(entry, str):
                    _push(entry, None)
                elif isinstance(entry, dict):
                    _push(entry.get("url"), entry.get("title"))
                if len(out) >= max_sources:
                    return out
    except Exception:
        return out
    return out


async def rewrite_motion_prompt(
    *,
    page_title: str,
    page_prompt: str | None = None,
    image_data_url: str | None = None,
    duration_seconds: int = 5,
) -> str:
    """Rewrite a page title/prompt into a motion-rich video prompt.

    LTX/Wan/Hunyuan i2v models are extremely sensitive to prompt detail —
    feeding them a bare page title produces near-static clips. This helper
    asks a VLM (when an image is supplied) or LLM (when not) to compose a
    cinematographic prompt naming a camera move, the primary subject's
    action, and a short atmospheric beat, capped to one sentence.

    Strictly additive: failures fall back to the original page_title so
    animate never breaks if OpenRouter is misconfigured.
    """
    seed = (page_title or "").strip()
    if not seed:
        return page_prompt or ""
    if os.environ.get("ANIMATE_PROMPT_REWRITE", "true").lower() in (
        "0",
        "false",
        "no",
    ):
        return seed

    client = _client()
    system = (
        "You convert a still illustration's caption into a one-sentence "
        "image-to-video prompt for a diffusion video model (LTX, Wan, "
        "Hunyuan-class). The clip is short — about "
        f"{duration_seconds} seconds — and starts from the supplied still. "
        "Name ONE camera move (slow dolly-in, gentle pan-left, push-out, "
        "static with parallax), ONE subject action that fits the caption, "
        "and ONE atmospheric beat (lighting shift, dust motes, rising steam). "
        "Stay faithful to the caption — do not invent unrelated subjects or "
        "switch art styles. Return ONLY the rewritten sentence, 25-45 words, "
        "no preamble, no quotes."
    )
    user_text_parts = [f"Caption: {seed}"]
    if page_prompt and page_prompt.strip() and page_prompt.strip() != seed:
        user_text_parts.append(f"Scene description: {page_prompt.strip()}")
    user_text = "\n".join(user_text_parts)

    from obs import span

    try:
        async with span("llm.rewrite_motion") as ctx:
            if image_data_url:
                response = await client.chat.completions.create(
                    model=_vlm_model(),
                    messages=[
                        _system_message(system),
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": user_text},
                                {
                                    "type": "image_url",
                                    "image_url": {
                                        "url": image_data_url,
                                        "detail": "low",
                                    },
                                },
                            ],
                        },
                    ],
                    temperature=0.4,
                    max_tokens=160,
                )
            else:
                response = await client.chat.completions.create(
                    model=_text_model(online=False),
                    messages=[
                        _system_message(system),
                        {"role": "user", "content": user_text},
                    ],
                    temperature=0.4,
                    max_tokens=160,
                )
            _log_cache_usage(ctx, response)
        rewritten = (response.choices[0].message.content or "").strip()
        return rewritten or seed
    except Exception:
        return seed


async def polish_edit_instruction(
    instruction: str,
    page_title: str | None = None,
    style_anchor: str | None = None,
) -> str:
    """Expand a terse edit instruction into a model-friendly prompt.

    Skipped at the call site if the instruction is already long. Keeps the
    polish strictly additive — never invents a different operation than what
    the user asked for.
    """
    instruction = instruction.strip()
    if not instruction:
        return instruction
    if len(instruction.split()) > 20:
        return instruction
    client = _client()
    system = (
        "You rewrite a short image-edit instruction into a single sentence "
        "that is concrete enough for an image-editing model to act on. Keep "
        "the user's intent EXACTLY — never add operations they didn't ask "
        "for, never remove ones they did. Aim for 15-30 words. Mention the "
        "subject, where in the frame, and any relevant style cues. Return "
        "ONLY the rewritten instruction, no preamble."
    )
    context_parts = [f"User instruction: {instruction}"]
    if page_title:
        context_parts.append(f"Current page: {page_title}")
    if style_anchor:
        context_parts.append(f"Existing visual style to preserve: {style_anchor}")
    user = "\n".join(context_parts)
    from obs import span

    text_model = _text_model(online=False)
    try:
        async with span("llm.polish_edit") as ctx:
            response = await client.chat.completions.create(
                model=text_model,
                messages=[
                    _system_message(system),
                    {"role": "user", "content": user},
                ],
                temperature=0.3,
                max_tokens=120,
            )
            _log_cache_usage(ctx, response)
        polished = (response.choices[0].message.content or "").strip()
        return polished or instruction
    except Exception:
        return instruction


async def precompute_click_candidates(
    image_data_url: str,
    parent_title: str,
    parent_query: str,
    output_locale: str | None = None,
    max_candidates: int = 4,
) -> list[ClickCandidate]:
    """Ask the VLM for the most click-worthy regions on a fresh page.

    Returns `max_candidates` items at most, ordered by salience descending.
    Coordinates are 0..1 in the image's frame. Falls back to an empty list on
    parse failure — the click handler still works via on-demand resolution.
    """
    locale_clause = (
        f" Each `subject` MUST be written in language code '{output_locale}'."
        if output_locale and output_locale.lower() not in ("en", "auto", "")
        else ""
    )
    system = (
        "You examine an illustrated explainer page titled "
        f"'{parent_title}' (user query: '{parent_query}'). Identify the "
        f"{max_candidates} MOST clickable subjects on this page — discrete, "
        "named objects or annotated regions a curious reader would tap to "
        "drill into. Avoid background filler, overlapping picks, and the "
        "centre of empty regions. Return JSON: "
        "{\"candidates\": [{\"x_pct\": 0..1, \"y_pct\": 0..1, "
        "\"subject\": \"2-8 word noun phrase\", "
        "\"style\": \"<=30 word visual style sentence — same for every "
        "candidate, describing this illustration's medium/palette/line-work\", "
        "\"salience\": 0..1}, ...]}. Coordinates are 0..1 with origin at the "
        "top-left of the image. Sort by salience descending."
        + locale_clause
    )
    user_text = (
        "List the most click-worthy regions on this illustration. Return "
        f"at most {max_candidates}; fewer is fine if the page is sparse."
    )
    from obs import span

    async with span("vlm.precompute_candidates", model=_vlm_model()) as ctx:
        parsed = await _complete_json(
            model=_vlm_model(),
            messages=[
                _system_message(system),
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_text},
                        {
                            "type": "image_url",
                            "image_url": {"url": image_data_url, "detail": "high"},
                        },
                    ],
                },
            ],
            schema=CANDIDATES_SCHEMA,
            schema_name="click_candidates",
            temperature=0.2,
            max_tokens=600,
            span_ctx=ctx,
        )
    items = parsed.get("candidates", [])
    out: list[ClickCandidate] = []
    if not isinstance(items, list):
        return out
    for entry in items:
        if not isinstance(entry, dict):
            continue
        try:
            x = float(entry.get("x_pct", -1))
            y = float(entry.get("y_pct", -1))
            sal = float(entry.get("salience", 0.5))
        except (TypeError, ValueError):
            continue
        if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
            continue
        subject = str(entry.get("subject", "")).strip()
        style = str(entry.get("style", "")).strip()
        if not subject:
            continue
        out.append(
            ClickCandidate(
                x_pct=x,
                y_pct=y,
                subject=subject,
                style=style,
                salience=max(0.0, min(1.0, sal)),
            )
        )
        if len(out) >= max_candidates:
            break
    out.sort(key=lambda c: c.salience, reverse=True)
    return out


async def propose_neighbors(
    image_data_url: str,
    parent_title: str,
    parent_query: str,
    subject_context: str | None = None,
    output_locale: str | None = None,
    max_neighbors: int = 4,
) -> list[Neighbor]:
    """Survey the neighbourhood of a page's focal subject for "expand outward".

    Returns up to ``max_neighbors`` notable neighbouring subjects across scales
    (component / peer / container), each a good next page to bloom. Falls back
    to an empty list on parse failure — the caller just blooms nothing.
    """
    locale_clause = (
        f" Each `subject` MUST be written in language code '{output_locale}'."
        if output_locale and output_locale.lower() not in ("en", "auto", "")
        else ""
    )
    context_clause = (
        f" The focal subject is: {subject_context.strip()}."
        if subject_context and subject_context.strip()
        else ""
    )
    system = (
        f"You examine an illustrated page titled '{parent_title}' (user query: "
        f"'{parent_query}'). The user wants to EXPAND OUTWARD — to see the "
        f"wider world this page's focal subject sits in.{context_clause} "
        f"Propose up to {max_neighbors} notable NEIGHBOURING subjects: things "
        "adjacent to it, larger things that contain it, and notable things it "
        "is composed of — each of which would make a good next page to explore. "
        "Favour variety across scales and do NOT repeat the focal subject "
        "itself. Return JSON: {\"neighbors\": [{\"subject\": \"2-8 word noun "
        "phrase\", \"scale\": \"component|peer|container\", \"note\": \"<=15 "
        "word reason it neighbours the focal subject\"}]}. `scale` is the "
        "neighbour's size relative to the focal subject: \"component\" (a part "
        "of it / smaller), \"peer\" (beside it / similar size), \"container\" "
        "(a larger thing it is part of)."
        + locale_clause
    )
    user_text = (
        "List the most interesting neighbouring subjects to explore around "
        f"this page. Return at most {max_neighbors}; fewer is fine."
    )
    from obs import span

    async with span("vlm.propose_neighbors", model=_vlm_model()) as ctx:
        parsed = await _complete_json(
            model=_vlm_model(),
            messages=[
                _system_message(system),
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_text},
                        {
                            "type": "image_url",
                            "image_url": {"url": image_data_url, "detail": "high"},
                        },
                    ],
                },
            ],
            schema=NEIGHBORS_SCHEMA,
            schema_name="neighbors",
            temperature=0.4,
            max_tokens=700,
            span_ctx=ctx,
        )
    return _build_neighbors(parsed, max_neighbors)


def _build_neighbors(parsed: dict[str, Any], max_neighbors: int) -> list[Neighbor]:
    """Coerce the planner's JSON into typed Neighbors. Drops empty/duplicate
    subjects, defaults bad scales to "peer", caps at ``max_neighbors``."""
    items = parsed.get("neighbors", [])
    out: list[Neighbor] = []
    if not isinstance(items, list):
        return out
    seen: set[str] = set()
    for entry in items:
        if not isinstance(entry, dict):
            continue
        subject = str(entry.get("subject", "")).strip()[:120]
        if not subject:
            continue
        key = subject.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(
            Neighbor(
                subject=subject,
                scale=_coerce_scale(entry.get("scale")),
                note=str(entry.get("note", "")).strip()[:200],
            )
        )
        if len(out) >= max_neighbors:
            break
    return out


async def extract_entities(
    image_data_url: str,
    caption: str,
    scene_description: str | None = None,
    prior_entities: list[dict[str, Any]] | None = None,
) -> EntityExtractionResult:
    """Catalogue entities visible/named in a freshly-generated page.

    `prior_entities` is the web layer's pre-filtered slice of the world
    registry — typically the N most-recent + any whose name overlaps the
    caption. The VLM uses it to decide whether a depicted character is "the
    same Mira from earlier" (emit as `updated`) or someone new (`added`).
    Sending the full registry on every page would balloon prompt cost.

    The extractor is opinionated about what counts as an entity: only named
    or narratively significant figures/places/items/creatures. "Tree",
    "table", "wall" alone are not entities. A specific named "lighthouse"
    or "the obsidian dagger" is. This filtering happens in the prompt
    rather than post-hoc because the VLM has the whole scene in view.
    """
    prior_blob = ""
    if prior_entities:
        # Compact rendering — the VLM only needs name/kind/appearance to
        # decide identity. Aliases included to catch rename overlaps.
        lines: list[str] = []
        for e in prior_entities[:40]:  # hard cap to bound prompt length
            name = str(e.get("name", "")).strip()
            kind = str(e.get("kind", "")).strip()
            appearance = str(e.get("appearance", "")).strip()
            aliases_raw = e.get("aliases", [])
            aliases = (
                ", ".join(a for a in aliases_raw if isinstance(a, str))
                if isinstance(aliases_raw, list)
                else ""
            )
            if not name or kind not in ENTITY_KINDS:
                continue
            line = f"- [{kind}] {name}"
            if aliases:
                line += f" (aka: {aliases})"
            if appearance:
                line += f" — {appearance[:140]}"
            lines.append(line)
        if lines:
            prior_blob = (
                "\n\nPrior entities in this world (match against these "
                "before adding a new one — if the same character / place / "
                "item is depicted, emit an `updated` entry keyed on the "
                "name shown here):\n" + "\n".join(lines)
            )

    system = (
        "You catalogue the named or narratively significant entities in an "
        "illustrated explainer / story page. Categorize each as one of: "
        f"{', '.join(ENTITY_KINDS)}.\n\n"
        "STRICT RELEVANCE FILTER: only emit entities that are either (a) "
        "given a proper name in the caption, (b) the visual focal point of "
        "the page, or (c) carry obvious narrative weight (a quest item, a "
        "doorway leading somewhere new, a named location). Generic scenery "
        "— trees, tables, walls, generic crowds — must NOT be emitted. "
        "When in doubt, leave it out.\n\n"
        "For each emitted entity provide:\n"
        "- `name`: short proper noun phrase (\"Mira the Keeper\", \"Lantern "
        "Room\", \"Obsidian Dagger\"). Use the in-page name when given; "
        "otherwise a concrete descriptive label (\"the masked herald\").\n"
        "- `kind`: one of " + ", ".join(ENTITY_KINDS) + ".\n"
        "- `appearance`: ONE sentence (<=35 words) describing what the "
        "entity LOOKS LIKE — clothing, build, materials, colours, posture. "
        "This sentence will be injected verbatim into future image-gen "
        "prompts to keep continuity, so be concrete and visual.\n"
        "- `aliases`: list of alternate names mentioned in the caption "
        "(empty list if none).\n"
        "- `facts`: up to 3 short factual statements about the entity "
        "from this page's caption / labels. Empty list if nothing notable.\n"
        "- `state`: an OBJECT of key/value flags describing the entity's "
        "CURRENT state on THIS page (causality). Use these CANONICAL "
        "keys whenever they apply: open, closed, locked, broken, lit, "
        "extinguished, burning, wounded, defeated, asleep, awake, alive, "
        "dead, present, absent, hidden, posture, held_by, location, "
        "time, weather. Examples: {\"open\": true}, {\"lit\": true}, "
        "{\"wounded\": true}, {\"posture\": \"kneeling\"}, "
        "{\"held_by\": \"Mira\"}, {\"time\": \"night\"}. Non-canonical "
        "keys are silently dropped by the merge layer, so prefer the "
        "canonical set even when paraphrasing fits better. Causality "
        "cues to look for: doors opened/closed, sources lit/extinguished, "
        "items picked up / dropped or transferred between characters, "
        "creatures awake/asleep/defeated, a character changed posture, "
        "an entity exiting a space or moving to a new room, scene-wide "
        "environmental shifts (time of day, weather, lighting). ONLY "
        "include a key when the page makes the state visually explicit; "
        "do NOT speculate. Empty object if nothing changed and no "
        "explicit state is depicted — but this empty-state rule governs "
        "the `state` key ONLY: still emit the surrounding `updated` "
        "entry as a presence ping. The merge layer threads this state "
        "forward, so a value emitted here will be the starting condition "
        "for future pages until contradicted.\n"
        "- `confidence`: 0..1 self-rating. Use <0.5 for guesses.\n"
        "- `bbox` (optional): {x_pct, y_pct, w_pct, h_pct} 0..1 normalized "
        "bounding box of the entity in the image, top-left origin. Omit "
        "or set null when the entity is mentioned only in caption text or "
        "you cannot localize it.\n\n"
        "RETURN JSON of the shape: "
        "{\"added\": [<new entities>], "
        "\"updated\": [{\"match_name\": \"<name from prior list>\", "
        "\"changes\": {<any of: name, appearance, facts, state, aliases>}, "
        "\"confidence\": 0..1}]}. "
        "Use `updated` for EVERY prior entity that appears on THIS page — "
        "even if NOTHING new is observable about them this turn. In that "
        "case emit `\"changes\": {}` and a confidence reflecting how sure "
        "you are the same entity is depicted. Presence-pings are how the "
        "registry knows the entity is still around; without them the entity "
        "would silently fall off the recency window and get re-added as a "
        "duplicate next time. Only include changed fields when there is "
        "actually something new (new fact, new state, an updated alias). "
        "Use `added` only for entities not in the prior list. "
        "CRITICAL NEGATIVE: do NOT emit an `updated` entry for a prior "
        "entity that is NOT depicted on this page and NOT mentioned by "
        "name in the caption / scene description. Phantom pings inflate "
        "the registry's `appears_on` counts and cause downstream "
        "continuity to inject the wrong character into future prompts. "
        "If unsure whether a prior entity is depicted, omit it."
    )
    caption_clean = (caption or "").strip()[:800]
    scene_clean = (scene_description or "").strip()[:1400]
    user_parts = [
        "Catalogue the named / narratively significant entities visible in "
        "this illustration. Match against the prior-entity list (if any) "
        "when the same one reappears; emit empty-change presence pings for "
        "prior entities that appear but have nothing new to record."
    ]
    if caption_clean:
        user_parts.append(f"Page title: \"{caption_clean}\"")
    if scene_clean:
        # Planner's `final_prompt` — the full paragraph the image model
        # rendered from. Names, props, locations are most reliably picked
        # up from this text rather than the short title alone.
        user_parts.append(f"Scene description: {scene_clean}")
    # Prior entities go in the USER turn, not the system turn. The system
    # block carries `cache_control: ephemeral` so OpenRouter can serve a
    # cached prefix on repeated extractions; per-call data in the system
    # block would invalidate every cache. The user turn varies anyway.
    if prior_blob:
        user_parts.append(prior_blob.strip())
    user_text = "\n\n".join(user_parts)
    from obs import span

    async with span("vlm.extract_entities", model=_vlm_model()) as ctx:
        # max_tokens is generous: a busy scene with ~30 prior entities easily
        # crosses 1.5k tokens (appearance + facts + state + bbox each). A
        # tighter cap truncates mid-JSON and the parse collapses to empty.
        # `_complete_json` stamps finish_reason into the span and returns {}
        # on the empty-choices stub OpenRouter sometimes relays as HTTP 200,
        # so the merge layer just sees an empty diff and keeps moving.
        parsed = await _complete_json(
            model=_vlm_model(),
            messages=[
                _system_message(system),
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_text},
                        {
                            "type": "image_url",
                            "image_url": {"url": image_data_url, "detail": "high"},
                        },
                    ],
                },
            ],
            schema=EXTRACTION_SCHEMA,
            schema_name="entity_extraction",
            temperature=0.2,
            max_tokens=2200,
            span_ctx=ctx,
        )
    return _build_extraction(parsed)


def _parse_extraction(raw: str) -> EntityExtractionResult:
    """Tolerantly parse the extraction VLM's raw JSON text into typed records."""
    return _build_extraction(_safe_json(raw))


def _build_extraction(parsed: dict[str, Any]) -> EntityExtractionResult:
    """Map an already-parsed extraction payload onto typed records.

    Garbage entries are dropped, not raised — the extractor is permitted to
    miss things; the worst case is a thinner codex this turn.
    """
    added_raw = parsed.get("added", [])
    updated_raw = parsed.get("updated", [])
    added: list[ExtractedEntity] = []
    if isinstance(added_raw, list):
        for entry in added_raw:
            entity = _coerce_extracted_entity(entry)
            if entity is not None:
                added.append(entity)
    updated: list[EntityUpdate] = []
    if isinstance(updated_raw, list):
        for entry in updated_raw:
            update = _coerce_entity_update(entry)
            if update is not None:
                updated.append(update)
    return EntityExtractionResult(added=added, updated=updated)


def _coerce_extracted_entity(entry: Any) -> ExtractedEntity | None:
    if not isinstance(entry, dict):
        return None
    kind = str(entry.get("kind", "")).strip().lower()
    name = str(entry.get("name", "")).strip()[:120]
    # `appearance` is the descriptor injected into image-gen prompts. Cap it
    # so a runaway VLM doesn't blow up the planner's ~120-word prompt budget
    # when multiple entities are stacked into the same composed_prompt.
    appearance = str(entry.get("appearance", "")).strip()[:280]
    if kind not in ENTITY_KINDS or not name or not appearance:
        return None
    aliases_raw = entry.get("aliases", []) or []
    aliases = (
        [str(a).strip() for a in aliases_raw if isinstance(a, str) and a.strip()]
        if isinstance(aliases_raw, list)
        else []
    )
    facts_raw = entry.get("facts", []) or []
    facts = (
        [str(f).strip() for f in facts_raw if isinstance(f, str) and f.strip()][:6]
        if isinstance(facts_raw, list)
        else []
    )
    state_raw = entry.get("state", {}) or {}
    state: dict[str, str | int | float | bool] = {}
    if isinstance(state_raw, dict):
        for k, v in state_raw.items():
            if not isinstance(k, str):
                continue
            if isinstance(v, (str, int, float, bool)):
                state[k] = v
    try:
        confidence = float(entry.get("confidence", 0.5))
    except (TypeError, ValueError):
        confidence = 0.5
    confidence = max(0.0, min(1.0, confidence))
    bbox = _coerce_bbox(entry.get("bbox"))
    return ExtractedEntity(
        kind=kind,
        name=name,
        appearance=appearance,
        aliases=aliases,
        facts=facts,
        state=state,
        confidence=confidence,
        bbox=bbox,
    )


def _coerce_entity_update(entry: Any) -> EntityUpdate | None:
    """Parse an `updated` entry from the extraction VLM.

    Empty `changes` is INTENTIONALLY kept as a presence ping: when a prior
    entity reappears on a page without any new facts/state/appearance to
    record, the VLM is still asked to emit an `updated` entry so the
    merge layer can bump `last_seen_node_id`, append to `appears_on_node_ids`,
    and keep the entity inside the recency-based prior slice on the next
    extraction. Dropping these empty pings makes recurring entities fall off
    the slice and get re-added as duplicates.
    """
    if not isinstance(entry, dict):
        return None
    match_name = str(entry.get("match_name", "")).strip()
    if not match_name:
        return None
    changes_raw = entry.get("changes", {}) or {}
    if not isinstance(changes_raw, dict):
        changes_raw = {}
    # Only allow whitelisted keys so the VLM can't sneak fields the
    # downstream merge layer doesn't know how to apply.
    allowed = {"name", "appearance", "facts", "state", "aliases"}
    changes: dict[str, Any] = {}
    for k, v in changes_raw.items():
        if k not in allowed:
            continue
        if k == "name" and isinstance(v, str) and v.strip():
            changes[k] = v.strip()[:120]
        elif k == "appearance" and isinstance(v, str) and v.strip():
            changes[k] = v.strip()[:280]
        elif k == "facts" and isinstance(v, list):
            changes[k] = [
                str(f).strip() for f in v if isinstance(f, str) and f.strip()
            ][:6]
        elif k == "aliases" and isinstance(v, list):
            changes[k] = [
                str(a).strip() for a in v if isinstance(a, str) and a.strip()
            ]
        elif k == "state" and isinstance(v, dict):
            # EntityState sub-bag (primitive-only), mirroring packages/config.
            state: dict[str, str | int | float | bool] = {}
            for sk, sv in v.items():
                if isinstance(sk, str) and isinstance(sv, (str, int, float, bool)):
                    state[sk] = sv
            if state:
                changes[k] = state
    try:
        confidence = float(entry.get("confidence", 0.5))
    except (TypeError, ValueError):
        confidence = 0.5
    confidence = max(0.0, min(1.0, confidence))
    return EntityUpdate(match_name=match_name, changes=changes, confidence=confidence)


def _coerce_bbox(raw: Any) -> dict[str, float] | None:
    if not isinstance(raw, dict):
        return None
    try:
        x = float(raw.get("x_pct", -1))
        y = float(raw.get("y_pct", -1))
        w = float(raw.get("w_pct", -1))
        h = float(raw.get("h_pct", -1))
    except (TypeError, ValueError):
        return None
    if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
        return None
    if not (0.0 < w <= 1.0 and 0.0 < h <= 1.0):
        return None
    # Clip box so it stays inside the frame.
    w = min(w, 1.0 - x)
    h = min(h, 1.0 - y)
    return {"x_pct": x, "y_pct": y, "w_pct": w, "h_pct": h}


def _safe_json(raw: str) -> dict[str, Any]:
    try:
        return cast(dict[str, Any], json.loads(raw))
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}")
        if start >= 0 and end > start:
            try:
                return cast(dict[str, Any], json.loads(raw[start : end + 1]))
            except json.JSONDecodeError:
                return {}
    return {}


# ── Natural-language editing of the geometric world map ───────────────────────
# Turn an instruction ("move the lighthouse north", "make the tower taller") into
# validated structured edits to WorldEntityGeo entities, plus the blast-radius
# (which saved scenes now reference an edited entity → re-stage candidates). The
# parse + blast are pure + tolerant (garbage drops, never raises); the LLM call is
# mocked in tests. Edit shapes mirror EntityGeoEdit in packages/config.

ENTITY_EDIT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"edits": {"type": "array", "items": {"type": "object"}}},
    "required": ["edits"],
}

ENTITY_EDIT_SYSTEM = (
    "You translate a natural-language instruction into structured edits to a 2D "
    "world map. World coords: origin top-left, +x EAST, +y SOUTH (so NORTH is "
    "-y and WEST is -x). Distances are in world units — match the rough scale of "
    'the positions you are given. Output JSON {"edits":[...]} where each edit is '
    "exactly one of:\n"
    '- {"op":"move","target":<id>,"dx":<number>,"dy":<number>}  (relative shift)\n'
    '- {"op":"set_height","target":<id>,"height":<number>}\n'
    '- {"op":"set_appearance","target":<id>,"visual":<short visual phrase>}\n'
    '- {"op":"remove","target":<id>}\n'
    '- {"op":"add","label":<name>,"pos":{"x":<number>,"y":<number>},"height":<number?>}\n'
    "RULES: `target` MUST be one of the listed entity ids — never invent an id. "
    "Only emit edits the instruction actually asks for; if nothing applies, emit "
    'an empty list {"edits":[]}. No prose, no markdown.'
)


@dataclass(frozen=True)
class EditPlan:
    edits: list[dict[str, Any]]
    blast_radius: list[str]


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_vec2(v: Any) -> TypeGuard[dict[str, Any]]:
    return isinstance(v, dict) and _is_number(v.get("x")) and _is_number(v.get("y"))


def parse_entity_edits(payload: Any, valid_ids: set[str]) -> list[dict[str, Any]]:
    """Coerce an NL-edit reply into validated EntityGeoEdit dicts. Tolerant: an
    edit with an unknown op, a `target` not in `valid_ids`, or a missing/ill-typed
    field is dropped — never raises (mirrors detector.parse_detections)."""
    if isinstance(payload, dict):
        payload = payload.get("edits", [])
    if not isinstance(payload, list):
        return []
    out: list[dict[str, Any]] = []
    for d in payload:
        if not isinstance(d, dict):
            continue
        op = str(d.get("op", "")).strip()
        if op == "add":
            label = str(d.get("label", "")).strip()
            pos = d.get("pos")
            if not label or not _is_vec2(pos):
                continue
            edit: dict[str, Any] = {
                "op": "add",
                "label": label,
                "pos": {"x": float(pos["x"]), "y": float(pos["y"])},
            }
            if _is_number(d.get("height")):
                edit["height"] = float(d["height"])
            fp = d.get("footprint")
            if isinstance(fp, dict) and _is_number(fp.get("w")) and _is_number(fp.get("d")):
                edit["footprint"] = {"w": float(fp["w"]), "d": float(fp["d"])}
            out.append(edit)
            continue
        target = str(d.get("target", "")).strip()
        if op not in ("move", "set_height", "set_appearance", "remove"):
            continue
        if target not in valid_ids:
            continue
        if op == "move":
            if not (_is_number(d.get("dx")) and _is_number(d.get("dy"))):
                continue
            out.append({"op": "move", "target": target,
                        "dx": float(d["dx"]), "dy": float(d["dy"])})
        elif op == "set_height":
            if not _is_number(d.get("height")):
                continue
            out.append({"op": "set_height", "target": target, "height": float(d["height"])})
        elif op == "set_appearance":
            visual = str(d.get("visual", "")).strip()
            if not visual:
                continue
            out.append({"op": "set_appearance", "target": target, "visual": visual})
        else:  # remove
            out.append({"op": "remove", "target": target})
    return out


def compute_blast_radius(
    edits: list[dict[str, Any]], references: dict[str, list[str]]
) -> list[str]:
    """Node ids whose saved render references an edited entity → the re-stage
    candidates. Union of `references[target]` over edits that carry a target (an
    `add` introduces a new entity, so it stales nothing)."""
    nodes: set[str] = set()
    for e in edits:
        target = e.get("target")
        if isinstance(target, str):
            for n in references.get(target, []):
                if isinstance(n, str):
                    nodes.add(n)
    return sorted(nodes)


def _edit_roster(entities: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for e in entities[:60]:  # bound the prompt
        eid = str(e.get("id", "")).strip()
        if not eid:
            continue
        label = str(e.get("label", "")).strip() or eid
        pos = e.get("pos") or {}
        lines.append(
            f'- id="{eid}" label="{label}" at (x={pos.get("x")}, y={pos.get("y")}) '
            f'height={e.get("height")}'
        )
    return "\n".join(lines)


async def edit_entities_nl(
    instruction: str,
    entities: list[dict[str, Any]],
    references: dict[str, list[str]] | None = None,
    scene_view: dict[str, Any] | None = None,
) -> EditPlan:
    """Turn a natural-language instruction into validated structured geo edits +
    a blast-radius. The model only sees the entities it may target (id + label +
    current geo); ids it invents are dropped by parse_entity_edits, so a bad
    completion degrades to a thinner/empty plan rather than a wrong mutation."""
    from obs import span

    references = references or {}
    valid_ids = {str(e["id"]) for e in entities if e.get("id")}
    roster = _edit_roster(entities)
    user = f'Instruction: "{instruction.strip()}"\n\nEntities you may edit:\n{roster}'
    async with span("llm.edit_entities", model=_text_model(online=False)) as ctx:
        parsed = await _complete_json(
            model=_text_model(online=False),
            messages=[
                _system_message(ENTITY_EDIT_SYSTEM),
                {"role": "user", "content": user},
            ],
            schema=ENTITY_EDIT_SCHEMA,
            schema_name="entity_edits",
            temperature=0.0,
            max_tokens=900,
            span_ctx=ctx,
        )
    edits = parse_entity_edits(parsed, valid_ids)
    return EditPlan(edits=edits, blast_radius=compute_blast_radius(edits, references))
