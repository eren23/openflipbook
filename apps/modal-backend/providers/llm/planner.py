"""Page planning (plan_page + its prompt clauses/citations) and the
prompt-polish helpers (motion rewrite, edit/fill polish). Moved verbatim from
the old providers/llm.py.

`_client` / `_complete_json` are called through the package namespace
(`_llm.*`) so tests that monkeypatch them on `providers.llm` still intercept.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

from providers import llm as _llm

from .client import (
    _log_cache_usage,
    _system_message,
    _text_model,
    _vlm_model,
    _web_plugin_extra,
)


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


PLAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "page_title": {"type": "string"},
        "prompt": {"type": "string"},
        "facts": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["page_title", "prompt"],
}


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


def _render_base_instruction(
    render_mode: str | None, *, label_free: bool = False
) -> str:
    """The opening planner instruction, keyed by World Mode render mode.

    `place_scene` → an immersive scene the reader steps into (no diagram
    labels); `place_submap` → a closer cartographic map of a sub-area;
    `explainer` (default, and every classic non-world call) → today's
    labelled visual-explainer page, verbatim. `label_free` (DOM-labels mode,
    suppress_map_labels) asks for the same page with NO baked text — names
    ride a client overlay; default off keeps every prompt byte-identical.
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
        named = (
            "laid out clearly but NOT named in the image — no lettering, no "
            "text, no cartouches; the interface overlays names separately"
            if label_free
            else "laid out and named"
        )
        return (
            "You design a closer MAP of just this district/area — a zoom of the "
            "parent map into this region, in the same cartographic style. Return "
            "JSON with keys: page_title (<=8 words, the area's name), prompt "
            "(<=120 words describing an illustrated map of this sub-area — its "
            f"streets, sub-districts and landmarks {named}, drawn as a "
            "map and not a scene), facts (3-6 named sub-areas or landmarks shown "
            "on the map). Do not include any text outside the JSON."
        )
    if rmode == "scale_parent":
        return (
            "You design the WIDER VIEW that CONTAINS this place — one scale step "
            "OUT (a city as one district of its region; a planet as one dot in its "
            "star system). Return JSON with keys: page_title (<=8 words, the "
            "container's name), prompt (<=120 words describing the containing "
            "frame, with the SOURCE placed as a small but recognizable sub-region "
            "near its centre — the EXACT same palette, art medium and style, a "
            "wider view of the SAME world and NOT a new invention), facts (3-6 "
            "named sibling areas or landmarks that share this container). Do not "
            "include any text outside the JSON."
        )
    if label_free:
        return (
            "You design a visual-explainer page for a given user query. Return "
            "JSON with keys: page_title (<=8 words, title case), prompt (<=120 "
            "words, a rich description of a single illustrated image suitable "
            "for an image model — include layout hints but NO text in the "
            "image: no labels, lettering, annotations or callouts; the "
            "interface overlays names separately), facts (list of 3-6 short "
            "factual details the illustration should depict). Do not include "
            "any text outside the JSON."
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
    label_free: bool = False,
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
    system_parts = [_render_base_instruction(rmode, label_free=label_free)]
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
            "VISUAL STYLE / MEDIUM LOCK (CRITICAL): the new illustration MUST be "
            f"drawn in this exact style — \"{style_anchor}\". Match the art "
            "MEDIUM above all (engraving, woodcut, ink line-work, watercolour, "
            "flat infographic, blueprint, etc.), plus its palette, line work, "
            "level of stylization and perspective. Do NOT switch to a different "
            "medium — never photorealism, a 3D render, or isometric line-art — "
            "however much the subject (a building interior, a portrait) might "
            "invite it. Begin the `prompt` with a leading clause that NAMES the "
            "medium explicitly (e.g. \"Hand-drawn engraving with cross-hatching "
            "and sepia ink, ...\"), and END the prompt with a one-line lock like "
            "\"Rendered strictly as <medium> — not photoreal, not 3D, not "
            "isometric line-art.\" so the image model cannot drift."
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
    elif rmode == "scale_parent":
        user_parts.append(
            "Draw the containing frame with the source as a small central "
            "sub-region. Keep the same art medium; readable at 1280x720."
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
        parsed = await _llm._complete_json(
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


def _world_size_hint(entry: dict[str, Any]) -> str:
    """A compact size clause for a world-context entity, when its geometry is
    known (footprint/height in world units, carried from its WorldEntityGeo).
    Keeps recurring entities at a consistent relative scale across pages.
    Returns '' when no size is carried — today's behaviour."""
    fp = entry.get("footprint")
    w = d = None
    if isinstance(fp, dict):
        w, d = fp.get("w"), fp.get("d")
    h = entry.get("height")
    parts: list[str] = []
    if isinstance(w, (int, float)) and isinstance(d, (int, float)):
        parts.append(f"footprint ~{round(float(w))}x{round(float(d))} ground units")
    if isinstance(h, (int, float)):
        parts.append(f"~{round(float(h))} units tall")
    return "; size " + ", ".join(parts) if parts else ""


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
        # Carry geometric size so recurring entities keep a consistent relative
        # scale across pages (a place rendered large once shouldn't come back
        # tiny). Best-effort; absent → no hint.
        line += _world_size_hint(entry)
        # The spatial half of continuity: where the world map pins this entity
        # ("the north-west of the map"). Without it the model relocates
        # landmarks to fit the composition — the palace-on-the-riverbank drift.
        location = str(entry.get("location_hint", "") or "").strip()
        if location:
            line += f"; fixed position: {location}"
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
        "Keep each entity at a CONSISTENT RELATIVE SCALE across pages — where a "
        "size is given below (footprint/height in world units), respect those "
        "proportions so a place drawn large once is not shrunk later. "
        + (
            # Additive: the position rule only enters the prompt when at least
            # one entity actually carries a hint (no hints -> byte-identical).
            "Where a `fixed position` is given, the entity LIVES at that "
            "position of the established world — keep it there relative to "
            "the other landmarks; do NOT relocate it to suit this page's "
            "composition. "
            if any("fixed position:" in line for line in lines)
            else ""
        )
        + "If an entity is NOT relevant to this page, simply omit it; do not "
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

    client = _llm._client()
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
        # Already detailed enough to skip the LLM polish — but still pin the
        # medium so a long edit (especially on Kontext, which takes no style
        # ref image) can't drift the art style.
        if style_anchor:
            return f"{instruction} Keep the existing art medium: {style_anchor}."
        return instruction
    client = _llm._client()
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


async def polish_fill_description(
    instruction: str,
    page_title: str | None = None,
    style_anchor: str | None = None,
) -> str:
    """Rewrite an edit COMMAND as a DESCRIPTION of the masked region's final
    content — inpaint fills (flux-pro/v1/fill, the primary since the mask
    smoke) paint what you describe, they don't follow commands. "add a red
    balloon here" -> "a single bright red hot-air balloon floating over the
    sea". Removals describe the background that should remain. The medium
    lock AND a scale anchor are appended deterministically (fill takes no
    style ref image, and it paints the WHOLE mask — without the anchor a
    "small ferry" comes out region-sized, the Ankh-Morpork lesson).

    Unlike polish_edit_instruction there is no long-instruction skip: a
    command stays a command however long it is — the register conversion IS
    the point. LLM failure degrades to the raw instruction + the locks.
    """
    instruction = instruction.strip()
    if not instruction:
        return instruction

    def _locked(text: str) -> str:
        # Fill's mask IS its canvas: anchor size to the surroundings or the
        # subject inflates to fill the selection edge-to-edge.
        anchored = (
            f"{text} Drawn to scale with the surrounding scene — nearby "
            "buildings, figures and objects set the size reference; the "
            "subject does not fill the region edge-to-edge."
        )
        if style_anchor:
            return f"{anchored} In the existing art medium: {style_anchor}."
        return anchored

    client = _llm._client()
    system = (
        "You convert an image-edit request into a description of what the "
        "edited region should look like AFTER the edit, for an inpainting "
        "model that repaints only that region. Describe the region's final "
        "content — subjects, their look, how they sit in their surroundings "
        "— never the operation: no imperative verbs like add, remove or "
        "replace, and never mention what was there before. For removals, "
        "describe the background that should remain. Aim for 10-30 words. "
        "Return ONLY the description, no preamble."
    )
    context_parts = [f"Edit request: {instruction}"]
    if page_title:
        context_parts.append(f"Current page: {page_title}")
    if style_anchor:
        context_parts.append(f"Existing visual style to preserve: {style_anchor}")
    user = "\n".join(context_parts)
    from obs import span

    text_model = _text_model(online=False)
    try:
        async with span("llm.polish_fill") as ctx:
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
        described = (response.choices[0].message.content or "").strip()
        return _locked(described or instruction)
    except Exception:
        return _locked(instruction)
