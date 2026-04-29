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
class PagePlan:
    page_title: str
    prompt: str
    facts: list[str]


@dataclass
class ClickResolution:
    subject: str
    style: str


def _client() -> AsyncOpenAI:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is not set")
    return AsyncOpenAI(
        api_key=api_key,
        base_url=OPENROUTER_BASE_URL,
        default_headers={
            "HTTP-Referer": os.environ.get(
                "OPENROUTER_REFERER", "https://github.com/eren23/openflipbook"
            ),
            "X-Title": "Endless Canvas",
        },
    )


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
        "clicked. Do TWO things and return them as JSON: "
        "(1) `subject` — a 2-8 word noun phrase naming the specific thing "
        "under the crosshair (ignore the crosshair itself); should make a "
        "good next query for a visual explainer. "
        "(2) `style` — a single sentence (<=30 words) describing the "
        "illustration's visual style: art medium (e.g. flat infographic, "
        "watercolor, technical line drawing, photoreal, anime, blueprint), "
        "dominant palette, line work, level of detail, perspective. "
        "Return JSON: {\"subject\": \"...\", \"style\": \"...\"}."
        + locale_clause
    )
    user_text = (
        "Look at the red crosshair marker on the image and tell me the "
        "specific subject beneath it. Also describe the visual style of "
        "the illustration so the next page can be drawn in the SAME style. "
        "If the crosshair is not visible for any reason, fall back to the "
        f"numeric position x={x_pct:.3f}, y={y_pct:.3f} "
        "(0-1 normalized, origin top-left)."
    )
    response = await client.chat.completions.create(
        model=_vlm_model(),
        messages=[
            {"role": "system", "content": system},
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
    raw = (response.choices[0].message.content or "{}").strip()
    parsed = _safe_json(raw)
    subject = str(parsed.get("subject", "")).strip()
    style = str(parsed.get("style", "")).strip()
    return ClickResolution(
        subject=subject or parent_title,
        style=style,
    )


async def plan_page(
    query: str,
    web_search: bool,
    style_anchor: str | None = None,
    output_locale: str | None = None,
) -> PagePlan:
    """Produce a page title, image-gen prompt, and factual snippets for the query.

    `style_anchor` (when set) is the parent illustration's visual style as
    described by the click-resolver VLM. We weave it into both the planner
    system prompt AND the final image-gen prompt so the renderer sees an
    explicit style instruction. Without this, generations drift across hops
    (a flat infographic parent can produce a photoreal child).
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
    user = (
        f"Query: {query}\n\n"
        "Design the illustrated page. Keep the layout readable at 1280x720."
    )
    if style_anchor:
        user += f"\n\nVisual style to preserve verbatim: {style_anchor}"
    text_model = _text_model(online=web_search)
    response = await client.chat.completions.create(
        model=text_model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        response_format={"type": "json_object"},
        temperature=0.7,
        max_tokens=900,
        extra_body=_web_plugin_extra(text_model, online=web_search) or None,
    )
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
    return PagePlan(page_title=page_title, prompt=prompt, facts=facts)


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

    try:
        if image_data_url:
            response = await client.chat.completions.create(
                model=_vlm_model(),
                messages=[
                    {"role": "system", "content": system},
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
                    {"role": "system", "content": system},
                    {"role": "user", "content": user_text},
                ],
                temperature=0.4,
                max_tokens=160,
            )
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
    text_model = _text_model(online=False)
    try:
        response = await client.chat.completions.create(
            model=text_model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.3,
            max_tokens=120,
        )
        polished = (response.choices[0].message.content or "").strip()
        return polished or instruction
    except Exception:  # noqa: BLE001
        return instruction


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
