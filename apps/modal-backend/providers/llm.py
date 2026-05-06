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
from dataclasses import dataclass
from typing import Any

from openai import AsyncOpenAI

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_VLM_MODEL = "google/gemini-3-flash-preview"
DEFAULT_TEXT_MODEL = "google/gemini-3-flash-preview"


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


_OPENAI_CLIENT: AsyncOpenAI | None = None


def _client() -> AsyncOpenAI:
    """Module-level singleton AsyncOpenAI client.

    Constructing AsyncOpenAI is cheap individually (~5 ms) but happens up to 4
    times per /sse/generate today; the underlying httpx pool also restarts
    each time, so warm keepalives never benefit. Reuse one instance.
    """
    global _OPENAI_CLIENT
    if _OPENAI_CLIENT is None:
        api_key = os.environ.get("OPENROUTER_API_KEY")
        if not api_key:
            raise RuntimeError("OPENROUTER_API_KEY is not set")
        _OPENAI_CLIENT = AsyncOpenAI(
            api_key=api_key,
            base_url=OPENROUTER_BASE_URL,
            default_headers={
                "HTTP-Referer": os.environ.get(
                    "OPENROUTER_REFERER", "https://github.com/eren23/openflipbook"
                ),
                "X-Title": "Endless Canvas",
            },
        )
    return _OPENAI_CLIENT


def _cache_enabled() -> bool:
    return os.environ.get("OPENROUTER_CACHE", "true").lower() in ("1", "true", "yes")


def _system_message(text: str) -> dict[str, Any]:
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
    except Exception:  # noqa: BLE001
        pass


def _vlm_model() -> str:
    return os.environ.get("OPENROUTER_VLM_MODEL", DEFAULT_VLM_MODEL)


def _web_search_enabled(online: bool) -> bool:
    if not online:
        return False
    return os.environ.get("OPENROUTER_ENABLE_WEB_SEARCH", "true").lower() in (
        "1",
        "true",
        "yes",
    )


def _supports_online_suffix(model: str) -> bool:
    # Gemini-family on OpenRouter requires the web plugin path; other models
    # accept the `:online` suffix shorthand.
    lowered = model.lower()
    if "gemini" in lowered:
        return False
    return True


def _text_model(online: bool) -> str:
    base = os.environ.get("OPENROUTER_TEXT_MODEL", DEFAULT_TEXT_MODEL)
    if _web_search_enabled(online) and _supports_online_suffix(base):
        return f"{base}:online"
    return base


def _web_plugin_extra(model: str, online: bool) -> dict[str, Any]:
    if _web_search_enabled(online) and not _supports_online_suffix(model):
        return {"plugins": [{"id": "web"}]}
    return {}


async def click_to_subject(
    image_data_url: str,
    x_pct: float,
    y_pct: float,
    parent_title: str,
    parent_query: str,
    output_locale: str | None = None,
    user_hint: str | None = None,
) -> ClickResolution:
    """Resolve the click region to a subject phrase AND a style descriptor.

    The image has a red crosshair at the click point (see
    `apps/web/lib/image-click.ts:annotateClickPoint`); numeric coords are a
    fallback. We also ask the VLM to summarise the illustration's visual
    style so the next page can match it — cheapest way to keep aesthetic
    continuity across hops without a second VLM round-trip.
    """
    client = _client()
    locale_clause = (
        f" The `subject` MUST be written in language code '{output_locale}' — "
        "the next page is being generated in that language and the subject "
        "phrase will be the page title."
        if output_locale and output_locale.lower() not in ("en", "auto", "")
        else ""
    )
    system = (
        "You examine a generated illustration of the page titled "
        f"'{parent_title}' (user query: '{parent_query}'). A red crosshair with "
        "a white halo has been drawn on the image to mark where the user "
        "clicked. Do THREE things and return them as JSON: "
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
        "identity across frames\" — NOT a generic definition. If the click "
        "is on something purely decorative, give the most specific concrete "
        "reading you can. "
        "Return JSON: {\"subject\": \"...\", \"style\": \"...\", "
        "\"subject_context\": \"...\"}."
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
    user_text = (
        "Look at the red crosshair marker on the image and tell me the "
        "specific subject beneath it. Also describe the visual style of "
        "the illustration so the next page can be drawn in the SAME style. "
        "If the crosshair is not visible for any reason, fall back to the "
        f"numeric position x={x_pct:.3f}, y={y_pct:.3f} "
        "(0-1 normalized, origin top-left)."
        + hint_clause
    )
    from obs import span

    async with span("vlm.click_to_subject", model=_vlm_model()) as ctx:
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
                            "image_url": {"url": image_data_url, "detail": "high"},
                        },
                    ],
                },
            ],
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=300,
        )
        _log_cache_usage(ctx, response)
    raw = (response.choices[0].message.content or "{}").strip()
    parsed = _safe_json(raw)
    subject = str(parsed.get("subject", "")).strip()
    style = str(parsed.get("style", "")).strip()
    subject_context = str(parsed.get("subject_context", "")).strip()
    return ClickResolution(
        subject=subject or parent_title,
        style=style,
        subject_context=subject_context,
    )


async def plan_page(
    query: str,
    web_search: bool,
    style_anchor: str | None = None,
    output_locale: str | None = None,
    parent_title: str | None = None,
    parent_query: str | None = None,
    subject_context: str | None = None,
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
    client = _client()
    system_parts = [
        "You design a visual-explainer page for a given user query. Return JSON "
        "with keys: page_title (<=8 words, title case), prompt (<=120 words, a "
        "rich description of a single illustrated diagram suitable for a "
        "text-capable image model — include labels, annotations, callouts, and "
        "layout hints), facts (list of 3-6 short factual bullets that should be "
        "visible as labels in the illustration). Do not include any text "
        "outside the JSON."
    ]
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
    user_parts.append(
        "Design the illustrated page. Keep the layout readable at 1280x720."
    )
    user = "\n\n".join(user_parts)
    if style_anchor:
        user += f"\n\nVisual style to preserve verbatim: {style_anchor}"
    from obs import span

    text_model = _text_model(online=web_search)
    async with span("planner.plan_page", model=text_model, web_search=web_search) as ctx:
        response = await client.chat.completions.create(
            model=text_model,
            messages=[
                _system_message(system),
                {"role": "user", "content": user},
            ],
            response_format={"type": "json_object"},
            temperature=0.7,
            max_tokens=900,
            extra_body=_web_plugin_extra(text_model, online=web_search) or None,
        )
        _log_cache_usage(ctx, response)
    raw = (response.choices[0].message.content or "{}").strip()
    parsed = _safe_json(raw)
    page_title = str(parsed.get("page_title", query)).strip() or query
    prompt = str(parsed.get("prompt", query)).strip() or query
    facts_raw = parsed.get("facts", [])
    facts: list[str] = []
    if isinstance(facts_raw, list):
        for f in facts_raw:
            if isinstance(f, str) and f.strip():
                facts.append(f.strip())
    sources = _extract_citations(response)
    return PagePlan(page_title=page_title, prompt=prompt, facts=facts, sources=sources)


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
        except Exception:  # noqa: BLE001
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
    except Exception:  # noqa: BLE001
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
    except Exception:  # noqa: BLE001
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
    except Exception:  # noqa: BLE001
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
    client = _client()
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
                            "image_url": {"url": image_data_url, "detail": "high"},
                        },
                    ],
                },
            ],
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=600,
        )
        _log_cache_usage(ctx, response)
    raw = (response.choices[0].message.content or "{}").strip()
    parsed = _safe_json(raw)
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


def _safe_json(raw: str) -> dict[str, Any]:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(raw[start : end + 1])
            except json.JSONDecodeError:
                return {}
    return {}
