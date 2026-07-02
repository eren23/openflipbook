"""P4 detector-parse gate (free): the VLM detection reply is coerced tolerantly."""
from __future__ import annotations

from providers.detector import parse_detections


def test_parses_valid_boxes() -> None:
    out = parse_detections(
        {"detections": [{"label": "tower", "x": 0.5, "y": 0.3, "w": 0.2, "h": 0.6, "score": 0.9}]}
    )
    assert out == [
        {"label": "tower", "x_pct": 0.5, "y_pct": 0.3, "w_pct": 0.2, "h_pct": 0.6, "score": 0.9}
    ]


def test_accepts_bare_list_and_entities_key() -> None:
    assert parse_detections([{"label": "a", "x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1}])[0]["label"] == "a"
    assert parse_detections({"entities": [{"label": "b", "x": 0.2, "y": 0.2, "w": 0.1, "h": 0.1}]})[0]["label"] == "b"


def test_drops_incomplete_or_blank_label() -> None:
    out = parse_detections(
        {
            "detections": [
                {"label": "", "x": 0.5, "y": 0.5, "w": 0.1, "h": 0.1},
                {"label": "no_h", "x": 0.5, "y": 0.5, "w": 0.1},
                {"label": "good", "x": 0.5, "y": 0.5, "w": 0.1, "h": 0.1},
            ]
        }
    )
    assert [d["label"] for d in out] == ["good"]


def test_clamps_out_of_range() -> None:
    out = parse_detections(
        {"detections": [{"label": "a", "x": 1.5, "y": -0.2, "w": 2.0, "h": 0.5, "score": 9}]}
    )
    assert out[0]["x_pct"] == 1.0
    assert out[0]["y_pct"] == 0.0
    assert out[0]["w_pct"] == 1.0
    assert out[0]["score"] == 1.0


def test_garbage_is_empty() -> None:
    assert parse_detections("nope") == []
    assert parse_detections({}) == []
    assert parse_detections({"detections": "x"}) == []
    assert parse_detections([1, 2, "x"]) == []


async def test_truncated_reply_salvages_leading_detections_and_warns(monkeypatch) -> None:
    # A max_tokens-truncated reply (finish_reason=length) cuts the JSON
    # mid-array — the complete leading elements are SALVAGED (partial
    # detections beat none) and the truncation is logged LOUDLY, not the
    # silent located=0 of old (which let the extractor's mis-anchored
    # fallback bboxes win every time).
    from types import SimpleNamespace

    import obs
    from providers import detector, llm

    truncated = '{\n  "detections": [\n    {"label": "a", "x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1, "score": 0.9},\n    {"label": "b", "x": 0.2'

    async def fake_create(_client, **_kw):
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=truncated), finish_reason="length")]
        )

    events: list[tuple[str, str]] = []
    monkeypatch.setattr(llm, "_create_with_retry", fake_create)
    monkeypatch.setattr(llm, "_client", lambda: object())
    monkeypatch.setattr(obs, "log", lambda level, event, **kw: events.append((level, event)))
    out = await detector.detect(b"jpegbytes", ["a", "b"])
    assert [d["label"] for d in out] == ["a"]  # the complete element survives
    assert ("warn", "detector.parse_failed") in events


async def test_unparseable_reply_returns_empty_and_warns(monkeypatch) -> None:
    from types import SimpleNamespace

    import obs
    from providers import detector, llm

    async def fake_create(_client, **_kw):
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="I cannot help with that."), finish_reason="stop")]
        )

    events: list[tuple[str, str]] = []
    monkeypatch.setattr(llm, "_create_with_retry", fake_create)
    monkeypatch.setattr(llm, "_client", lambda: object())
    monkeypatch.setattr(obs, "log", lambda level, event, **kw: events.append((level, event)))
    out = await detector.detect(b"jpegbytes", ["a"])
    assert out == []
    assert ("warn", "detector.parse_failed") in events
