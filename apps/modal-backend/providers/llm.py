"""OpenRouter-backed LLM/VLM client.

Uses the openai SDK pointed at https://openrouter.ai/api/v1. Models are
configurable via env; defaults are Qwen 2.5 VL/text (cheap, strong).
Web search uses OpenRouter's `:online` suffix (Exa-backed) — no extra key.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

from openai import AsyncOpenAI

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_VLM_MODEL = "qwen/qwen-2.5-vl-72b-instruct"
DEFAULT_TEXT_MODEL = "qwen/qwen-2.5-72b-instruct"


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


def _text_model(online: bool) -> str:
    base = os.environ.get("OPENROUTER_TEXT_MODEL", DEFAULT_TEXT_MODEL)
    if online and os.environ.get("OPENROUTER_ENABLE_WEB_SEARCH", "true").lower() in (
        "1",
        "true",
        "yes",
    ):
        return f"{base}:online"
    return base


async def click_to_subject(
    image_data_url: str,
    x_pct: float,
    y_pct: float,
    parent_title: str,
    parent_query: str,
) -> ClickResolution:
    """Resolve the click region to a subject phrase AND a style descriptor.

    The image has a red crosshair at the click point (see
    `apps/web/lib/image-click.ts:annotateClickPoint`); numeric coords are a
    fallback. We also ask the VLM to summarise the illustration's visual
    style so the next page can match it — cheapest way to keep aesthetic
    continuity across hops without a second VLM round-trip.
    """
    client = _client()
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
    system = " ".join(system_parts)
    user = (
        f"Query: {query}\n\n"
        "Design the illustrated page. Keep the layout readable at 1280x720."
    )
    if style_anchor:
        user += f"\n\nVisual style to preserve verbatim: {style_anchor}"
    response = await client.chat.completions.create(
        model=_text_model(online=web_search),
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        response_format={"type": "json_object"},
        temperature=0.7,
        max_tokens=900,
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
