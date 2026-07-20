"""FIX 1b — view/camera estimator parse is exact + tolerant (pure; no VLM)."""
from __future__ import annotations

from providers.view_estimator import DEFAULT_VIEW, parse_view


def test_parse_valid_oblique() -> None:
    # scale_tier absent in the reply → falls back off the level (map → city).
    assert parse_view(
        {"level": "map", "projection": "oblique", "pitch_deg": -45}
    ) == {
        "level": "map",
        "projection": "oblique",
        "pitch_deg": -45.0,
        "scale_tier": "city",
        "confidence": 0.5,  # absent in the reply -> below the C12 trust gate
    }


def test_parse_unknown_values_fall_back() -> None:
    out = parse_view({"level": "satellite", "projection": "weird", "pitch_deg": "x"})
    assert out == {
        "level": "map",
        "projection": "top_down",
        "pitch_deg": -90.0,
        "scale_tier": "city",
        "confidence": 0.5,
    }


def test_parse_scale_tier_explicit_and_fallback() -> None:
    # An explicit valid rung passes through unchanged.
    assert parse_view(
        {"level": "map", "projection": "top_down", "pitch_deg": -90, "scale_tier": "region"}
    )["scale_tier"] == "region"
    # An unknown rung falls back deterministically off the level (eye → room).
    assert parse_view(
        {"level": "eye", "projection": "perspective", "pitch_deg": 0, "scale_tier": "bogus"}
    )["scale_tier"] == "room"
    # An absent rung also falls back off the level (building → place).
    assert parse_view(
        {"level": "building", "projection": "oblique", "pitch_deg": -30}
    )["scale_tier"] == "place"


def test_parse_clamps_pitch() -> None:
    assert parse_view({"level": "street", "projection": "perspective", "pitch_deg": 200})["pitch_deg"] == 90.0
    assert parse_view({"level": "eye", "projection": "perspective", "pitch_deg": -200})["pitch_deg"] == -90.0


def test_parse_non_dict_is_default_top_down() -> None:
    assert parse_view(None) == DEFAULT_VIEW
    assert parse_view("nope") == DEFAULT_VIEW
    assert parse_view([1, 2]) == DEFAULT_VIEW


def test_parse_view_confidence_coercion() -> None:
    # C12: the trust gate needs an honest confidence — clamped, defaulted BELOW
    # the 0.7 gate when absent/invalid, 0.0 on the full fallback.
    from providers.view_estimator import DEFAULT_VIEW, parse_view

    assert parse_view({"level": "map", "projection": "top_down",
                       "pitch_deg": -90, "confidence": 0.95})["confidence"] == 0.95
    assert parse_view({"level": "map", "projection": "top_down",
                       "pitch_deg": -90, "confidence": 7})["confidence"] == 1.0
    assert parse_view({"level": "map", "projection": "top_down",
                       "pitch_deg": -90})["confidence"] == 0.5
    assert parse_view({"level": "map", "projection": "top_down",
                       "pitch_deg": -90, "confidence": "junk"})["confidence"] == 0.5
    assert DEFAULT_VIEW["confidence"] == 0.0


# ── estimate_view (the one-VLM-call path; mocked create, no live calls) ───────


def _fake_reply(content: str, finish_reason: str = "stop"):
    from types import SimpleNamespace

    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(content=content), finish_reason=finish_reason
            )
        ]
    )


async def test_estimate_view_success_parses_and_sends_the_image(monkeypatch) -> None:
    from providers import llm
    from providers.view_estimator import estimate_view

    captured: dict = {}

    async def fake_create(client, **kwargs):
        captured.update(kwargs)
        return _fake_reply(
            '{"level":"street","projection":"perspective","pitch_deg":-10,'
            '"scale_tier":"district","confidence":0.9}'
        )

    monkeypatch.setattr(llm, "_create_with_retry", fake_create)
    monkeypatch.setattr(llm, "_client", lambda: object())
    out = await estimate_view(b"img-bytes", caption="a cobbled lane")
    assert out == {
        "level": "street",
        "projection": "perspective",
        "pitch_deg": -10.0,
        "scale_tier": "district",
        "confidence": 0.9,
    }
    user_parts = captured["messages"][1]["content"]
    assert 'Caption: "a cobbled lane"' in user_parts[0]["text"]
    assert user_parts[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert captured["temperature"] == 0.0


async def test_estimate_view_omits_the_caption_clause_when_absent(monkeypatch) -> None:
    from providers import llm
    from providers.view_estimator import estimate_view

    captured: dict = {}

    async def fake_create(client, **kwargs):
        captured.update(kwargs)
        return _fake_reply('{"level":"map","projection":"top_down","pitch_deg":-90}')

    monkeypatch.setattr(llm, "_create_with_retry", fake_create)
    monkeypatch.setattr(llm, "_client", lambda: object())
    out = await estimate_view(b"img")
    assert out["level"] == "map"
    assert captured["messages"][1]["content"][0]["text"] == "Classify this image's camera."


async def test_estimate_view_unparseable_reply_degrades_to_default_and_warns(
    monkeypatch,
) -> None:
    import obs
    from providers import llm
    from providers.view_estimator import DEFAULT_VIEW, estimate_view

    events: list[tuple[str, str]] = []

    async def fake_create(client, **kwargs):
        return _fake_reply("I cannot classify that image.", finish_reason="stop")

    monkeypatch.setattr(llm, "_create_with_retry", fake_create)
    monkeypatch.setattr(llm, "_client", lambda: object())
    monkeypatch.setattr(obs, "log", lambda level, event, **kw: events.append((level, event)))
    assert await estimate_view(b"img") == DEFAULT_VIEW
    assert ("warn", "view.parse_failed") in events


async def test_estimate_view_upstream_failure_degrades_to_default_and_warns(
    monkeypatch,
) -> None:
    import obs
    from providers import llm
    from providers.view_estimator import DEFAULT_VIEW, estimate_view

    events: list[tuple[str, str]] = []

    async def boom(client, **kwargs):
        raise RuntimeError("upstream 502")

    monkeypatch.setattr(llm, "_create_with_retry", boom)
    monkeypatch.setattr(llm, "_client", lambda: object())
    monkeypatch.setattr(obs, "log", lambda level, event, **kw: events.append((level, event)))
    assert await estimate_view(b"img") == DEFAULT_VIEW
    assert ("warn", "view.estimate_failed") in events


def test_model_env_override(monkeypatch) -> None:
    from providers.view_estimator import _model

    monkeypatch.delenv("WORLD_BENCH_JUDGE_MODEL", raising=False)
    monkeypatch.delenv("OPENROUTER_VLM_MODEL", raising=False)
    assert _model() == "google/gemini-3-flash-preview"
    monkeypatch.setenv("OPENROUTER_VLM_MODEL", "qwen/qwen-vl")
    assert _model() == "qwen/qwen-vl"
    monkeypatch.setenv("WORLD_BENCH_JUDGE_MODEL", "judge/x")
    assert _model() == "judge/x"
