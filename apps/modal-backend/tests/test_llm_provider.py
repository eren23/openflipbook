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
