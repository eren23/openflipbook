"""Unit tests for providers.llm.

Covers cache-header construction, web-search routing per model family,
suffix-vs-plugin routing, and citation extraction. The actual OpenAI client
is never invoked.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from providers import llm

# ---------- World Mode: render-mode base instruction ----------------------


def test_render_base_explainer_is_default() -> None:
    assert "visual-explainer page" in llm._render_base_instruction(None)
    assert "visual-explainer page" in llm._render_base_instruction("explainer")
    assert "visual-explainer page" in llm._render_base_instruction("bogus")


def test_render_base_place_scene_is_immersive_without_labels() -> None:
    text = llm._render_base_instruction("place_scene")
    assert "stepped into" in text
    assert "NO callout labels" in text
    assert "visual-explainer page" not in text


def test_render_base_place_submap_is_cartographic() -> None:
    text = llm._render_base_instruction("place_submap")
    assert "closer MAP" in text
    assert "visual-explainer page" not in text


def test_spatial_anchor_clause_only_for_places_with_surroundings() -> None:
    s = "river to the south, market square NE"
    assert "SPATIAL ANCHOR" in llm._spatial_anchor_clause("place_scene", s)
    assert s in llm._spatial_anchor_clause("place_submap", s)
    # No surroundings, or an explainer/classic page → no anchor clause.
    assert llm._spatial_anchor_clause("place_scene", "") == ""
    assert llm._spatial_anchor_clause("place_scene", None) == ""
    assert llm._spatial_anchor_clause("explainer", s) == ""
    assert llm._spatial_anchor_clause(None, s) == ""


# ---------- _system_message + caching ------------------------------------


def test_system_message_uses_cache_block_by_default() -> None:
    out = llm._system_message("hello")
    assert out["role"] == "system"
    assert isinstance(out["content"], list)
    block = out["content"][0]
    assert block["type"] == "text"
    assert block["text"] == "hello"
    assert block["cache_control"] == {"type": "ephemeral"}


def test_system_message_plain_string_when_cache_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENROUTER_CACHE", "false")
    out = llm._system_message("hello")
    assert out == {"role": "system", "content": "hello"}


@pytest.mark.parametrize("flag", ["1", "true", "yes", "TRUE", "Yes"])
def test_cache_enabled_truthy_flags(monkeypatch: pytest.MonkeyPatch, flag: str) -> None:
    monkeypatch.setenv("OPENROUTER_CACHE", flag)
    assert llm._cache_enabled() is True


@pytest.mark.parametrize("flag", ["0", "false", "no", "off"])
def test_cache_disabled_falsy_flags(monkeypatch: pytest.MonkeyPatch, flag: str) -> None:
    monkeypatch.setenv("OPENROUTER_CACHE", flag)
    assert llm._cache_enabled() is False


# ---------- web search routing -------------------------------------------


def test_web_search_disabled_when_online_false() -> None:
    assert llm._web_search_enabled(False) is False


def test_web_search_disabled_via_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENROUTER_ENABLE_WEB_SEARCH", "false")
    assert llm._web_search_enabled(True) is False


def test_web_search_default_on_when_online() -> None:
    assert llm._web_search_enabled(True) is True


def test_supports_online_suffix_blocks_gemini() -> None:
    assert llm._supports_online_suffix("google/gemini-3-flash-preview") is False


def test_supports_online_suffix_allows_qwen() -> None:
    assert llm._supports_online_suffix("qwen/qwen-2.5-72b-instruct") is True


def test_text_model_appends_online_suffix_for_supported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENROUTER_TEXT_MODEL", "qwen/qwen-2.5-72b-instruct")
    assert llm._text_model(online=True) == "qwen/qwen-2.5-72b-instruct:online"


def test_text_model_no_suffix_when_offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENROUTER_TEXT_MODEL", "qwen/qwen-2.5-72b-instruct")
    assert llm._text_model(online=False) == "qwen/qwen-2.5-72b-instruct"


def test_text_model_no_suffix_for_gemini_even_when_online(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENROUTER_TEXT_MODEL", "google/gemini-3-flash-preview")
    out = llm._text_model(online=True)
    # No `:online` suffix — Gemini routes via the web plugin path instead.
    assert out == "google/gemini-3-flash-preview"


def test_web_plugin_extra_for_gemini_online() -> None:
    out = llm._web_plugin_extra("google/gemini-3-pro-preview", online=True)
    assert out == {"plugins": [{"id": "web"}]}


def test_web_plugin_extra_empty_for_qwen_online() -> None:
    # Qwen uses the suffix path, not the plugin path.
    out = llm._web_plugin_extra("qwen/qwen-2.5-72b-instruct", online=True)
    assert out == {}


def test_web_plugin_extra_empty_when_offline() -> None:
    out = llm._web_plugin_extra("google/gemini-3-flash-preview", online=False)
    assert out == {}


def test_vlm_model_default() -> None:
    assert llm._vlm_model() == llm.DEFAULT_VLM_MODEL


def test_vlm_model_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENROUTER_VLM_MODEL", "openrouter/some-vlm")
    assert llm._vlm_model() == "openrouter/some-vlm"


# ---------- _safe_json ---------------------------------------------------


def test_safe_json_strict() -> None:
    out = llm._safe_json('{"a": 1}')
    assert out == {"a": 1}


def test_safe_json_strips_fence() -> None:
    out = llm._safe_json('```json\n{"a": 2}\n```')
    assert out == {"a": 2}


def test_safe_json_returns_empty_on_garbage() -> None:
    # Non-JSON should not raise — caller treats it as "no structured output".
    assert llm._safe_json("not json at all") == {}


# ---------- entity-extraction parser -------------------------------------


def test_extraction_parses_minimal_added_entity() -> None:
    raw = (
        "{\"added\": [{\"kind\": \"person\", \"name\": \"Mira\", "
        "\"appearance\": \"tall keeper in navy coat\", \"confidence\": 0.9}], "
        "\"updated\": []}"
    )
    out = llm._parse_extraction(raw)
    assert len(out.added) == 1
    assert len(out.updated) == 0
    e = out.added[0]
    assert e.kind == "person"
    assert e.name == "Mira"
    assert e.appearance == "tall keeper in navy coat"
    assert e.confidence == 0.9
    # Defaults for omitted fields.
    assert e.aliases == []
    assert e.facts == []
    assert e.state == {}
    assert e.bbox is None


def test_extraction_drops_unknown_kind() -> None:
    raw = (
        "{\"added\": [{\"kind\": \"vehicle\", \"name\": \"Cart\", "
        "\"appearance\": \"wooden\"}], \"updated\": []}"
    )
    out = llm._parse_extraction(raw)
    assert out.added == []


def test_extraction_drops_missing_required_fields() -> None:
    # Missing appearance.
    raw = "{\"added\": [{\"kind\": \"person\", \"name\": \"X\"}], \"updated\": []}"
    out = llm._parse_extraction(raw)
    assert out.added == []


def test_extraction_clamps_confidence_to_unit_range() -> None:
    raw = (
        "{\"added\": [{\"kind\": \"place\", \"name\": \"Lantern Room\", "
        "\"appearance\": \"glass-walled chamber atop the tower\", "
        "\"confidence\": 1.7}], \"updated\": []}"
    )
    out = llm._parse_extraction(raw)
    assert out.added[0].confidence == 1.0


def test_extraction_caps_facts_at_six() -> None:
    import json as _json

    facts = ["a", "b", "c", "d", "e", "f", "g", "h"]
    raw = _json.dumps(
        {
            "added": [
                {
                    "kind": "creature",
                    "name": "Wisp",
                    "appearance": "floating pale light",
                    "facts": facts,
                }
            ],
            "updated": [],
        }
    )
    out = llm._parse_extraction(raw)
    assert len(out.added[0].facts) == 6


def test_extraction_state_filters_non_primitive_values() -> None:
    raw = (
        "{\"added\": [{\"kind\": \"item\", \"name\": \"Lantern\", "
        "\"appearance\": \"brass with glass panes\", "
        "\"state\": {\"lit\": true, \"weight\": 2, \"junk\": [1,2,3]}}], "
        "\"updated\": []}"
    )
    out = llm._parse_extraction(raw)
    e = out.added[0]
    assert e.state == {"lit": True, "weight": 2}


def test_extraction_bbox_rejects_out_of_range() -> None:
    raw = (
        "{\"added\": [{\"kind\": \"person\", \"name\": \"Mira\", "
        "\"appearance\": \"keeper\", \"bbox\": "
        "{\"x_pct\": 1.4, \"y_pct\": 0.2, \"w_pct\": 0.1, \"h_pct\": 0.1}}], "
        "\"updated\": []}"
    )
    out = llm._parse_extraction(raw)
    assert out.added[0].bbox is None


def test_extraction_bbox_clips_to_frame() -> None:
    raw = (
        "{\"added\": [{\"kind\": \"person\", \"name\": \"Mira\", "
        "\"appearance\": \"keeper\", \"bbox\": "
        "{\"x_pct\": 0.8, \"y_pct\": 0.7, \"w_pct\": 0.5, \"h_pct\": 0.5}}], "
        "\"updated\": []}"
    )
    out = llm._parse_extraction(raw)
    bbox = out.added[0].bbox
    assert bbox is not None
    # Width and height clipped so the box stays in [0,1].
    assert bbox["w_pct"] == pytest.approx(0.2)
    assert bbox["h_pct"] == pytest.approx(0.3)


def test_extraction_update_whitelists_change_keys() -> None:
    raw = (
        "{\"added\": [], \"updated\": [{\"match_name\": \"Mira\", "
        "\"changes\": {\"facts\": [\"opened the door\"], "
        "\"secret_admin_flag\": true, \"state\": {\"door\": \"open\"}}, "
        "\"confidence\": 0.85}]}"
    )
    out = llm._parse_extraction(raw)
    assert len(out.updated) == 1
    u = out.updated[0]
    assert u.match_name == "Mira"
    assert "facts" in u.changes
    assert "state" in u.changes
    assert "secret_admin_flag" not in u.changes


def test_extraction_update_kept_as_presence_ping_when_no_valid_changes() -> None:
    # Empty `changes` (after sanitisation) is INTENTIONALLY kept — it's a
    # presence ping that the merge layer uses to bump last_seen +
    # appears_on so recurring entities stay inside the recency-based prior
    # slice on the next extraction.
    raw = (
        "{\"added\": [], \"updated\": [{\"match_name\": \"Mira\", "
        "\"changes\": {\"only_junk\": 1}, \"confidence\": 0.5}]}"
    )
    out = llm._parse_extraction(raw)
    assert len(out.updated) == 1
    u = out.updated[0]
    assert u.match_name == "Mira"
    assert u.changes == {}
    assert u.confidence == 0.5


def test_extraction_update_kept_with_empty_changes_object() -> None:
    raw = (
        "{\"added\": [], \"updated\": [{\"match_name\": \"Mira\", "
        "\"changes\": {}, \"confidence\": 0.9}]}"
    )
    out = llm._parse_extraction(raw)
    assert len(out.updated) == 1
    assert out.updated[0].changes == {}


def test_extraction_update_dropped_when_match_name_blank() -> None:
    raw = (
        "{\"added\": [], \"updated\": [{\"match_name\": \"\", "
        "\"changes\": {\"facts\": [\"x\"]}, \"confidence\": 0.5}]}"
    )
    out = llm._parse_extraction(raw)
    assert out.updated == []


def test_extraction_tolerates_garbage_json() -> None:
    out = llm._parse_extraction("this is not json")
    assert out.added == []
    assert out.updated == []


# ---------- continuity-injection clause (Phase 3) ------------------------


def test_world_context_clause_empty_when_no_entities() -> None:
    assert llm._format_world_context_clause(None) == ""
    assert llm._format_world_context_clause([]) == ""


def test_world_context_clause_renders_named_entities() -> None:
    out = llm._format_world_context_clause(
        [
            {
                "id": "e1",
                "kind": "person",
                "name": "Mira",
                "aliases": ["the Keeper"],
                "appearance": "tall lighthouse keeper in navy peacoat",
                "state": {"lantern": "lit"},
            },
            {
                "id": "e2",
                "kind": "place",
                "name": "Lantern Room",
                "aliases": [],
                "appearance": "glass-walled chamber atop the tower",
            },
        ]
    )
    assert "WORLD CONTINUITY" in out
    assert "Mira" in out
    assert "tall lighthouse keeper" in out
    assert "the Keeper" in out
    assert "Lantern Room" in out
    assert "lantern=lit" in out


def test_world_context_clause_drops_entries_missing_appearance() -> None:
    out = llm._format_world_context_clause(
        [
            {"kind": "person", "name": "Mira", "appearance": ""},
            {"kind": "person", "name": "", "appearance": "tall"},
        ]
    )
    assert out == ""


def test_world_context_clause_caps_appearance_length() -> None:
    long_descriptor = "x" * 500
    out = llm._format_world_context_clause(
        [
            {
                "kind": "person",
                "name": "Mira",
                "appearance": long_descriptor,
                "aliases": [],
            }
        ]
    )
    # Capped at 240 chars in the formatter so a runaway entry doesn't
    # blow up the planner's prompt budget when several entities stack.
    assert long_descriptor[:240] in out
    assert long_descriptor not in out


def test_world_context_clause_caps_aliases_at_three() -> None:
    out = llm._format_world_context_clause(
        [
            {
                "kind": "person",
                "name": "Mira",
                "appearance": "tall keeper",
                "aliases": ["a", "b", "c", "d", "e"],
            }
        ]
    )
    # Aliases truncated to three so the clause stays short.
    assert "aka: a, b, c" in out
    assert ", d," not in out


def test_world_context_clause_caps_at_sixteen_entities() -> None:
    entities = [
        {"kind": "item", "name": f"Item-{i}", "appearance": "x"} for i in range(40)
    ]
    out = llm._format_world_context_clause(entities)
    assert "Item-15" in out
    assert "Item-16" not in out


def test_world_context_clause_includes_causality_instruction() -> None:
    # Phase 6 — the planner must be told to honour entity state from
    # prior pages. Without this, even though state pairs are rendered
    # into the clause, the renderer treats them as flavour rather than
    # a hard constraint.
    out = llm._format_world_context_clause(
        [
            {
                "kind": "place",
                "name": "Door",
                "appearance": "iron-bound oak door",
                "state": {"door": "open"},
            }
        ]
    )
    assert "CAUSALITY" in out
    assert "honour" in out or "honor" in out
    assert "door=open" in out


def test_supports_structured_output_routing() -> None:
    # Phase 7d — capability routing must accept the four known-good
    # families and reject everything else so a model swap doesn't
    # silently strip response_format.
    assert llm._supports_structured_output("google/gemini-3-flash-preview")
    assert llm._supports_structured_output("openai/gpt-4o-mini")
    assert llm._supports_structured_output("anthropic/claude-3.5-sonnet")
    assert llm._supports_structured_output("qwen/qwen-2.5-72b-instruct")
    assert not llm._supports_structured_output("mistralai/mistral-large")
    assert not llm._supports_structured_output("x-ai/grok-3")
    assert not llm._supports_structured_output("meta-llama/llama-3.1-70b")


def test_maybe_response_format_included_for_supported_model() -> None:
    out = llm._maybe_response_format("google/gemini-3-flash-preview")
    assert out == {"response_format": {"type": "json_object"}}


def test_maybe_response_format_omitted_for_unsupported_model() -> None:
    # Unsupported models would 400 or silently strip on OpenRouter; we
    # skip the kwarg entirely so the call goes through as freeform.
    out = llm._maybe_response_format("mistralai/mistral-large")
    assert out == {}


def test_extraction_prompt_lists_canonical_state_keys() -> None:
    # Phase 7a/7c — the prompt nudges the VLM toward canonical keys so the
    # web-side allow-list doesn't have to silently drop everything.
    raw_prompt = llm.extract_entities.__doc__ or ""
    # The actual prompt is built at call time; the easiest check is to
    # peek at the system-string assembly. Read the source of the function
    # so a future refactor that moves the prompt elsewhere still gets
    # flagged.
    import inspect

    source = inspect.getsource(llm.extract_entities)
    assert "open, closed" in source or "CANONICAL keys" in source
    # Empty-state clarifier must remain so the model still emits presence
    # pings for unchanged recurrences.
    assert "presence ping" in source.lower() or "empty-state rule" in source.lower()
    # New causality cues from 7c — at least the inventory and time
    # transitions should be referenced now.
    assert "transferred between characters" in source
    assert "exiting a space" in source
    _ = raw_prompt  # silence pyflakes if doc is empty


def test_world_context_clause_state_survives_for_multiple_entities() -> None:
    out = llm._format_world_context_clause(
        [
            {
                "kind": "person",
                "name": "Mira",
                "appearance": "tall keeper",
                "state": {"wounded": True, "lantern": "lit"},
            },
            {
                "kind": "creature",
                "name": "Wisp",
                "appearance": "pale floating light",
                "state": {"defeated": True},
            },
        ]
    )
    assert "wounded=True" in out
    assert "lantern=lit" in out
    assert "defeated=True" in out


# ---------- provider resolution (multi-provider, PR1) --------------------


def test_resolve_provider_defaults_to_openrouter(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
    provider, base_url, api_key, headers = llm._resolve_provider()
    assert provider == "openrouter"
    assert base_url == llm.OPENROUTER_BASE_URL
    assert api_key == "or-key"
    # OpenRouter attribution headers preserved exactly as today.
    assert headers["HTTP-Referer"]
    assert headers["X-Title"] == "Endless Canvas"


def test_resolve_provider_openrouter_missing_key_raises() -> None:
    # OPENROUTER_API_KEY scrubbed by conftest; the default path must raise
    # rather than build a keyless client.
    with pytest.raises(RuntimeError):
        llm._resolve_provider()


def test_resolve_provider_openai(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.setenv("LLM_API_KEY", "sk-openai")
    provider, base_url, api_key, headers = llm._resolve_provider()
    assert provider == "openai"
    assert base_url == "https://api.openai.com/v1"
    assert api_key == "sk-openai"
    # No OpenRouter-specific headers leak onto direct providers.
    assert "HTTP-Referer" not in headers


def test_resolve_provider_anthropic_compat_base(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("LLM_API_KEY", "sk-ant")
    _, base_url, _, _ = llm._resolve_provider()
    assert base_url == "https://api.anthropic.com/v1"


def test_resolve_provider_google_compat_base(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "google")
    monkeypatch.setenv("LLM_API_KEY", "g-key")
    _, base_url, _, _ = llm._resolve_provider()
    assert base_url == "https://generativelanguage.googleapis.com/v1beta/openai/"


def test_resolve_provider_custom_requires_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "custom")
    monkeypatch.setenv("LLM_API_KEY", "x")
    with pytest.raises(RuntimeError):
        llm._resolve_provider()


def test_resolve_provider_custom_local_defaults_noauth_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "custom")
    monkeypatch.setenv("LLM_BASE_URL", "http://localhost:11434/v1")
    # No LLM_API_KEY — local servers (Ollama/LM Studio) usually need none, but
    # the OpenAI SDK requires a non-empty string, so we default it.
    provider, base_url, api_key, _ = llm._resolve_provider()
    assert provider == "custom"
    assert base_url == "http://localhost:11434/v1"
    assert api_key == "sk-noauth"


def test_resolve_provider_base_url_override_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.setenv("LLM_API_KEY", "k")
    monkeypatch.setenv("LLM_BASE_URL", "http://proxy.local/v1")
    _, base_url, _, _ = llm._resolve_provider()
    assert base_url == "http://proxy.local/v1"


def test_resolve_provider_direct_missing_key_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    with pytest.raises(RuntimeError):
        llm._resolve_provider()


# ---------- model resolution: LLM_* overrides, OPENROUTER_* back-compat ----


def test_vlm_model_prefers_llm_vlm_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENROUTER_VLM_MODEL", "or/vlm")
    monkeypatch.setenv("LLM_VLM_MODEL", "direct/vlm")
    assert llm._vlm_model() == "direct/vlm"


def test_vlm_model_falls_back_to_openrouter_var(monkeypatch: pytest.MonkeyPatch) -> None:
    # Back-compat: when LLM_VLM_MODEL is unset the old var still drives it.
    monkeypatch.setenv("OPENROUTER_VLM_MODEL", "or/vlm")
    assert llm._vlm_model() == "or/vlm"


def test_text_model_prefers_llm_text_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENROUTER_TEXT_MODEL", "or/text")
    monkeypatch.setenv("LLM_TEXT_MODEL", "direct/text")
    assert llm._text_model(online=False) == "direct/text"


def test_web_search_disabled_on_direct_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    # OpenRouter brokers web search via :online / the web plugin; that only
    # exists on the openrouter provider, so direct providers report disabled.
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    assert llm._web_search_enabled(True) is False


def test_text_model_no_online_suffix_on_direct_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "custom")
    monkeypatch.setenv("LLM_BASE_URL", "http://localhost:11434/v1")
    monkeypatch.setenv("LLM_TEXT_MODEL", "qwen2.5")
    # qwen takes the :online suffix on openrouter, but we're not on openrouter.
    assert llm._text_model(online=True) == "qwen2.5"


# ---------- structured-output capability ladder: tier resolver -----------


def test_tier_openrouter_supported_family_is_json_object() -> None:
    # Back-compat: the default OpenRouter path keeps today's json_object call.
    assert (
        llm._resolve_structured_tier("openrouter", "google/gemini-3-flash-preview")
        == "json_object"
    )
    assert llm._resolve_structured_tier("openrouter", "qwen/qwen-2.5-72b") == "json_object"


def test_tier_openrouter_unsupported_family_is_prompt() -> None:
    # Today these silently strip response_format; the prompt rung recovers
    # best-effort instead of returning empty.
    assert llm._resolve_structured_tier("openrouter", "mistralai/mistral-large") == "prompt"
    assert llm._resolve_structured_tier("openrouter", "x-ai/grok-3") == "prompt"


def test_tier_cloud_direct_providers_are_json_object() -> None:
    assert llm._resolve_structured_tier("openai", "gpt-4o") == "json_object"
    assert llm._resolve_structured_tier("google", "gemini-2.5-flash") == "json_object"
    assert llm._resolve_structured_tier("anthropic", "claude-3.5-sonnet") == "json_object"


def test_tier_custom_tool_family_is_tool() -> None:
    assert llm._resolve_structured_tier("custom", "llama-3.1-8b-instruct") == "tool"
    assert llm._resolve_structured_tier("custom", "mistral-7b-instruct") == "tool"


def test_tier_custom_json_family_is_json_object() -> None:
    assert llm._resolve_structured_tier("custom", "qwen2.5vl") == "json_object"


def test_tier_custom_unknown_small_model_is_prompt() -> None:
    assert llm._resolve_structured_tier("custom", "phi-3-mini") == "prompt"


def test_tier_override_forces_tier(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_STRUCTURED_OUTPUT", "tool")
    # Operator override beats the auto table, even for a gemini default.
    assert (
        llm._resolve_structured_tier("openrouter", "google/gemini-3-flash-preview") == "tool"
    )


def test_tier_override_auto_uses_table(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_STRUCTURED_OUTPUT", "auto")
    assert llm._resolve_structured_tier("openai", "gpt-4o") == "json_object"


# ---------- _complete_json capability ladder (mock client, no network) ----


def _fake_response(content: str | None = None, tool_args: str | None = None) -> Any:
    msg = SimpleNamespace(content=content, tool_calls=None)
    if tool_args is not None:
        msg.tool_calls = [SimpleNamespace(function=SimpleNamespace(arguments=tool_args))]
    choice = SimpleNamespace(message=msg, finish_reason="stop")
    return SimpleNamespace(choices=[choice], usage=None)


class _FakeCompletions:
    def __init__(self, script: list[Any]) -> None:
        self.script = list(script)
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        action = self.script.pop(0)
        if isinstance(action, Exception):
            raise action
        return action


class _FakeClient:
    def __init__(self, script: list[Any]) -> None:
        self.chat = SimpleNamespace(completions=_FakeCompletions(script))


def _bad_request() -> Exception:
    import httpx
    from openai import BadRequestError

    req = httpx.Request("POST", "http://test/v1/chat/completions")
    return BadRequestError("bad", response=httpx.Response(400, request=req), body=None)


async def test_complete_json_json_object_rung_parses(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeClient([_fake_response(content='{"subject": "Boiler"}')])
    monkeypatch.setattr(llm, "_client", lambda: fake)
    parsed = await llm._complete_json(
        model="google/gemini-3-flash-preview",
        messages=[{"role": "user", "content": "x"}],
        max_tokens=100,
        temperature=0.2,
        schema=llm.CLICK_SCHEMA,
        schema_name="click",
    )
    assert parsed == {"subject": "Boiler"}
    call = fake.chat.completions.calls[0]
    assert call["response_format"] == {"type": "json_object"}


async def test_complete_json_tool_rung_reads_arguments(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "custom")
    monkeypatch.setenv("LLM_BASE_URL", "http://localhost:11434/v1")
    fake = _FakeClient([_fake_response(tool_args='{"subject": "Valve"}')])
    monkeypatch.setattr(llm, "_client", lambda: fake)
    parsed = await llm._complete_json(
        model="llama-3.1-8b-instruct",
        messages=[{"role": "user", "content": "x"}],
        max_tokens=100,
        temperature=0.2,
        schema=llm.CLICK_SCHEMA,
        schema_name="click",
    )
    assert parsed == {"subject": "Valve"}
    call = fake.chat.completions.calls[0]
    assert call["tool_choice"]["function"]["name"] == "click"
    assert "response_format" not in call


async def test_complete_json_prompt_rung_recovers_fenced_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "custom")
    monkeypatch.setenv("LLM_BASE_URL", "http://x/v1")
    fake = _FakeClient([_fake_response(content='Sure!\n```json\n{"subject": "Sky"}\n```')])
    monkeypatch.setattr(llm, "_client", lambda: fake)
    parsed = await llm._complete_json(
        model="phi-3-mini",
        messages=[{"role": "user", "content": "x"}],
        max_tokens=100,
        temperature=0.2,
        schema=llm.CLICK_SCHEMA,
    )
    assert parsed == {"subject": "Sky"}
    call = fake.chat.completions.calls[0]
    assert "response_format" not in call
    assert "tools" not in call


async def test_complete_json_prompt_rung_repair_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "custom")
    monkeypatch.setenv("LLM_BASE_URL", "http://x/v1")
    fake = _FakeClient(
        [
            _fake_response(content="I cannot comply."),
            _fake_response(content='{"subject": "Door"}'),
        ]
    )
    monkeypatch.setattr(llm, "_client", lambda: fake)
    parsed = await llm._complete_json(
        model="phi-3-mini",
        messages=[{"role": "user", "content": "x"}],
        max_tokens=100,
        temperature=0.2,
        schema=llm.CLICK_SCHEMA,
    )
    assert parsed == {"subject": "Door"}
    # The repair pass fires exactly once when the first reply isn't JSON.
    assert len(fake.chat.completions.calls) == 2


async def test_complete_json_prompt_rung_no_retry_when_valid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "custom")
    monkeypatch.setenv("LLM_BASE_URL", "http://x/v1")
    fake = _FakeClient([_fake_response(content='{"subject": "X"}')])
    monkeypatch.setattr(llm, "_client", lambda: fake)
    parsed = await llm._complete_json(
        model="phi-3-mini",
        messages=[{"role": "user", "content": "x"}],
        max_tokens=100,
        temperature=0.2,
        schema=llm.CLICK_SCHEMA,
    )
    assert parsed == {"subject": "X"}
    assert len(fake.chat.completions.calls) == 1


async def test_complete_json_downgrades_on_bad_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(
        llm, "_safe_log", lambda level, event, **kv: events.append((event, kv))
    )
    # gemini on openrouter starts at json_object; a 400 must drop a rung and the
    # next rung (tool) succeeds within the same call.
    fake = _FakeClient([_bad_request(), _fake_response(tool_args='{"subject": "Y"}')])
    monkeypatch.setattr(llm, "_client", lambda: fake)
    parsed = await llm._complete_json(
        model="google/gemini-3-flash-preview",
        messages=[{"role": "user", "content": "x"}],
        max_tokens=100,
        temperature=0.2,
        schema=llm.CLICK_SCHEMA,
        schema_name="click",
    )
    assert parsed == {"subject": "Y"}
    assert len(fake.chat.completions.calls) == 2
    assert any(name == "llm.tier_downgrade" for name, _ in events)


async def test_complete_json_empty_choices_returns_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _FakeClient([SimpleNamespace(choices=[], usage=None)])
    monkeypatch.setattr(llm, "_client", lambda: fake)
    parsed = await llm._complete_json(
        model="google/gemini-3-flash-preview",
        messages=[{"role": "user", "content": "x"}],
        max_tokens=100,
        temperature=0.2,
        schema=llm.CLICK_SCHEMA,
    )
    assert parsed == {}


# ---------- _with_json_hint + multi-step downgrade -----------------------


def test_with_json_hint_appends_to_string_user_turn() -> None:
    msgs = [{"role": "system", "content": "sys"}, {"role": "user", "content": "hello"}]
    out = llm._with_json_hint(msgs, "HINTX")
    assert out[-1]["content"].endswith("HINTX")
    # The caller's original message is not mutated.
    assert msgs[1]["content"] == "hello"


def test_with_json_hint_appends_text_block_to_multimodal_user_turn() -> None:
    # The click/extract/candidates hot path: content is [text, image_url]. The
    # hint must ride as a trailing text block, preserve the image block, and not
    # mutate the caller's list.
    img_block = {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,abc"}}
    msgs = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": [{"type": "text", "text": "q"}, img_block]},
    ]
    out = llm._with_json_hint(msgs, "HINTX")
    last = out[-1]["content"]
    assert isinstance(last, list)
    assert last[-1] == {"type": "text", "text": "HINTX"}
    assert img_block in last
    assert len(msgs[1]["content"]) == 2


async def test_complete_json_two_step_downgrade(monkeypatch: pytest.MonkeyPatch) -> None:
    # gemini starts at json_object; json_object 400 -> tool 400 -> prompt succeeds.
    fake = _FakeClient(
        [_bad_request(), _bad_request(), _fake_response(content='{"subject": "Z"}')]
    )
    monkeypatch.setattr(llm, "_client", lambda: fake)
    parsed = await llm._complete_json(
        model="google/gemini-3-flash-preview",
        messages=[{"role": "user", "content": "x"}],
        max_tokens=100,
        temperature=0.2,
        schema=llm.CLICK_SCHEMA,
    )
    assert parsed == {"subject": "Z"}
    assert len(fake.chat.completions.calls) == 3


async def test_complete_json_reraises_when_all_rungs_400(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from openai import BadRequestError

    fake = _FakeClient([_bad_request(), _bad_request(), _bad_request()])
    monkeypatch.setattr(llm, "_client", lambda: fake)
    with pytest.raises(BadRequestError):
        await llm._complete_json(
            model="google/gemini-3-flash-preview",
            messages=[{"role": "user", "content": "x"}],
            max_tokens=100,
            temperature=0.2,
            schema=llm.CLICK_SCHEMA,
        )


# ---------- contract-function integration (fake client end-to-end) --------


async def test_click_to_subject_builds_resolution(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeClient(
        [
            _fake_response(
                content=(
                    '{"subject": "Boiler", "style": "flat infographic", '
                    '"groundable": true, "confidence": 0.9, '
                    '"point": {"x": 0.5, "y": 0.4}}'
                )
            )
        ]
    )
    monkeypatch.setattr(llm, "_client", lambda: fake)
    res = await llm.click_to_subject(
        "data:image/jpeg;base64,abc",
        0.5,
        0.4,
        "Steam Engine",
        "how does a steam engine work",
    )
    assert isinstance(res, llm.ClickResolution)
    assert res.subject == "Boiler"
    assert res.groundable is True
    assert res.confidence == 0.9
    assert res.point == (0.5, 0.4)


async def test_click_to_subject_falls_back_to_parent_on_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # An empty/garbage model reply must not crash — subject falls back to the
    # parent title and the crosshair becomes the point.
    fake = _FakeClient([_fake_response(content="no json here")])
    monkeypatch.setattr(llm, "_client", lambda: fake)
    res = await llm.click_to_subject(
        "data:image/jpeg;base64,abc", 0.25, 0.75, "Steam Engine", "q"
    )
    assert res.subject == "Steam Engine"
    assert res.point == (0.25, 0.75)


async def test_extract_entities_returns_added(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeClient(
        [
            _fake_response(
                content=(
                    '{"added": [{"kind": "person", "name": "Mira", '
                    '"appearance": "tall keeper in navy coat"}], "updated": []}'
                )
            )
        ]
    )
    monkeypatch.setattr(llm, "_client", lambda: fake)
    res = await llm.extract_entities("data:image/jpeg;base64,abc", "The Lighthouse")
    assert len(res.added) == 1
    assert res.added[0].name == "Mira"


async def test_plan_page_builds_plan(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeClient(
        [
            _fake_response(
                content=(
                    '{"page_title": "How Boilers Work", '
                    '"prompt": "A flat infographic of a boiler", '
                    '"facts": ["Water boils", "Steam rises"]}'
                )
            )
        ]
    )
    monkeypatch.setattr(llm, "_client", lambda: fake)
    plan = await llm.plan_page("how do boilers work", web_search=False)
    assert plan.page_title == "How Boilers Work"
    assert "boiler" in plan.prompt.lower()
    assert plan.facts == ["Water boils", "Steam rises"]


async def test_precompute_candidates_parses(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeClient(
        [
            _fake_response(
                content=(
                    '{"candidates": [{"x_pct": 0.3, "y_pct": 0.4, '
                    '"subject": "Valve", "style": "flat", "salience": 0.8}]}'
                )
            )
        ]
    )
    monkeypatch.setattr(llm, "_client", lambda: fake)
    out = await llm.precompute_click_candidates("data:image/jpeg;base64,abc", "Engine", "q")
    assert len(out) == 1
    assert out[0].subject == "Valve"


# ---------- scale tag on click resolution (M3) ---------------------------


def test_build_click_resolution_parses_scale() -> None:
    res = llm._build_click_resolution(
        {"subject": "Factory", "scale": "container"},
        x_pct=0.5,
        y_pct=0.5,
        fallback_subject="x",
    )
    assert res.scale == "container"


def test_build_click_resolution_defaults_scale_to_peer() -> None:
    res = llm._build_click_resolution(
        {"subject": "X"}, x_pct=0.5, y_pct=0.5, fallback_subject="x"
    )
    assert res.scale == "peer"


def test_build_click_resolution_rejects_unknown_scale() -> None:
    res = llm._build_click_resolution(
        {"subject": "X", "scale": "ginormous"},
        x_pct=0.5,
        y_pct=0.5,
        fallback_subject="x",
    )
    assert res.scale == "peer"


def test_build_click_resolution_scale_is_case_insensitive() -> None:
    res = llm._build_click_resolution(
        {"subject": "X", "scale": "Component"},
        x_pct=0.5,
        y_pct=0.5,
        fallback_subject="x",
    )
    assert res.scale == "component"


# ---------- propose_neighbors (M3 expand bloom) --------------------------


def test_build_neighbors_parses_and_tags_scale() -> None:
    parsed = {
        "neighbors": [
            {"subject": "The Factory", "scale": "container", "note": "houses the boiler"},
            {"subject": "Piston", "scale": "peer"},
            {"subject": "Valve", "scale": "component"},
        ]
    }
    out = llm._build_neighbors(parsed, max_neighbors=4)
    assert [n.subject for n in out] == ["The Factory", "Piston", "Valve"]
    assert [n.scale for n in out] == ["container", "peer", "component"]
    assert out[0].note == "houses the boiler"


def test_build_neighbors_defaults_bad_scale_to_peer() -> None:
    out = llm._build_neighbors(
        {"neighbors": [{"subject": "X", "scale": "weird"}]}, max_neighbors=4
    )
    assert out[0].scale == "peer"


def test_build_neighbors_drops_empty_subject() -> None:
    out = llm._build_neighbors(
        {"neighbors": [{"subject": "  "}, {"subject": "Real"}]}, max_neighbors=4
    )
    assert [n.subject for n in out] == ["Real"]


def test_build_neighbors_caps_at_max() -> None:
    parsed = {"neighbors": [{"subject": f"N{i}"} for i in range(10)]}
    out = llm._build_neighbors(parsed, max_neighbors=4)
    assert len(out) == 4


def test_build_neighbors_dedupes_by_normalized_subject() -> None:
    parsed = {
        "neighbors": [
            {"subject": "The Boiler"},
            {"subject": "the boiler"},
            {"subject": "Coal"},
        ]
    }
    out = llm._build_neighbors(parsed, max_neighbors=4)
    assert [n.subject for n in out] == ["The Boiler", "Coal"]


def test_build_neighbors_tolerates_garbage() -> None:
    assert llm._build_neighbors({}, max_neighbors=4) == []
    assert llm._build_neighbors({"neighbors": "nope"}, max_neighbors=4) == []


async def test_propose_neighbors_end_to_end(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeClient(
        [
            _fake_response(
                content='{"neighbors": [{"subject": "Factory", "scale": "container"}]}'
            )
        ]
    )
    monkeypatch.setattr(llm, "_client", lambda: fake)
    out = await llm.propose_neighbors(
        "data:image/jpeg;base64,abc", "Boiler", "how a boiler works"
    )
    assert len(out) == 1
    assert out[0].subject == "Factory"
    assert out[0].scale == "container"


# --- the fill register (mask-scoped edits, E1/F3) ------------------------------


async def test_polish_fill_appends_scale_anchor_and_medium_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Fill paints the WHOLE mask — the deterministic scale anchor is what
    # keeps a "small ferry" from coming out region-sized (the Ankh-Morpork
    # lesson), and the medium lock rides after it.
    fake = _FakeClient([_fake_response(content="a small wooden ferry on the river")])
    monkeypatch.setattr(llm, "_client", lambda: fake)
    out = await llm.polish_fill_description(
        "add a small ferry", style_anchor="aged parchment"
    )
    assert out.startswith("a small wooden ferry on the river")
    assert "Drawn to scale with the surrounding scene" in out
    assert out.index("Drawn to scale") < out.index("aged parchment")
    assert out.endswith("In the existing art medium: aged parchment.")


async def test_polish_fill_degrades_with_both_locks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _FakeClient([RuntimeError("llm down")])
    monkeypatch.setattr(llm, "_client", lambda: fake)
    out = await llm.polish_fill_description(
        "add a small ferry", style_anchor="aged parchment"
    )
    assert out.startswith("add a small ferry")
    assert "Drawn to scale with the surrounding scene" in out
    assert "aged parchment" in out


async def test_polish_fill_scale_anchor_without_style(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _FakeClient([_fake_response(content="a quiet pond")])
    monkeypatch.setattr(llm, "_client", lambda: fake)
    out = await llm.polish_fill_description("add a pond")
    assert "Drawn to scale with the surrounding scene" in out
    assert "art medium" not in out
