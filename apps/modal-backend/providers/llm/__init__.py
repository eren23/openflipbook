# ruff: noqa: F401
"""OpenRouter-backed LLM/VLM client.

Uses the openai SDK pointed at https://openrouter.ai/api/v1. Defaults are
Gemini 3 Flash (multimodal) for both planning and click-resolution — strong
JSON adherence, large context, cheap. Override via env to use Gemini 3 Pro
or another OpenRouter slug.

Web search: Gemini-family models on OpenRouter don't accept the legacy
`:online` suffix universally, so for those we attach the OpenRouter web
plugin (`extra_body={"plugins": [{"id": "web"}]}`) instead. Other models
keep the `:online` suffix path.

This package used to be a single providers/llm.py module. The split is purely
mechanical; this __init__ re-exports the entire surface so `providers.llm`
resolves exactly as before, and tests keep monkeypatching attributes here
(submodules call the patchable seams through this namespace).
"""

from .click import (
    CANDIDATES_SCHEMA,
    CLICK_SCHEMA,
    ClickCandidate,
    ClickResolution,
    _build_click_resolution,
    _coerce_unit,
    _parse_bbox,
    _parse_point,
    click_to_subject,
    precompute_click_candidates,
)
from .client import (
    _JSON_ONLY_HINT,
    _JSON_REPAIR_HINT,
    _LLM_BASE_URLS,
    _STRUCTURED_OUTPUT_FAMILIES,
    _TIER_LADDER,
    _TOOL_CALL_FAMILIES,
    _TRANSIENT_LLM_ERRORS,
    DEFAULT_TEXT_MODEL,
    DEFAULT_VLM_MODEL,
    ENTITY_KINDS,
    OPENROUTER_BASE_URL,
    SCALE_KINDS,
    _cache_enabled,
    _choice_content,
    _client,
    _coerce_json_dict,
    _coerce_scale,
    _complete_json,
    _create_with_retry,
    _llm_provider,
    _log_cache_usage,
    _maybe_response_format,
    _parse_choice_json,
    _parse_tool_json,
    _request_timeout_s,
    _resolve_provider,
    _resolve_structured_tier,
    _rung_kwargs,
    _safe_json,
    _safe_log,
    _supports_online_suffix,
    _supports_structured_output,
    _system_message,
    _text_model,
    _tier_attempts,
    _vlm_model,
    _web_plugin_extra,
    _web_search_enabled,
    _with_json_hint,
)
from .extraction import (
    EXTRACTION_SCHEMA,
    EntityExtractionResult,
    EntityUpdate,
    ExtractedEntity,
    _build_extraction,
    _coerce_bbox,
    _coerce_entity_update,
    _coerce_extracted_entity,
    _parse_extraction,
    extract_entities,
)
from .planner import (
    PLAN_SCHEMA,
    Citation,
    PagePlan,
    _extract_citations,
    _format_world_context_clause,
    _render_base_instruction,
    _spatial_anchor_clause,
    _world_size_hint,
    plan_page,
    polish_edit_instruction,
    polish_fill_description,
    rewrite_motion_prompt,
)
from .world import (
    _PLAN_RELATIONS,
    _WALL_WORDS,
    ENTITY_EDIT_SCHEMA,
    ENTITY_EDIT_SYSTEM,
    NEIGHBORS_SCHEMA,
    PLAN_WORLD_SCHEMA,
    PLAN_WORLD_SYSTEM,
    EditPlan,
    Neighbor,
    _build_neighbors,
    _edit_roster,
    _is_number,
    _is_vec2,
    compute_blast_radius,
    edit_entities_nl,
    parse_entity_edits,
    parse_scene_graph,
    plan_world_from_description,
    propose_neighbors,
)
