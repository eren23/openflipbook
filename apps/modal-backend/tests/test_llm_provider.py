"""Unit tests for providers.llm.

Covers cache-header construction, web-search routing per model family,
suffix-vs-plugin routing, and citation extraction. The actual OpenAI client
is never invoked.
"""

from __future__ import annotations

import pytest

from providers import llm

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
