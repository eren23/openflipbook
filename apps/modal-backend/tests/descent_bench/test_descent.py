"""Descent-bench aggregation (free): the report rolls up BOTH the
medium-confounded style_lift AND the medium-agnostic place_lift, so an
illustration->photo chain is no longer judged solely on a medium gap it can
never close. Plus the seam spy: the with-arm MUST ride the edit path (refs
bite) — generate_image silently ignores reference_urls, which kept place_lift
structurally ~0 until 2026-07-29."""
from __future__ import annotations

import pytest

from providers import image as image_provider
from providers import image_edit as image_edit_provider
from providers import judge, model_router
from tests.continuity_bench import coherence_runner
from tests.descent_bench import runner
from tests.descent_bench.runner import _aggregate


def _row(style_lift: float, place_lift: float) -> dict:
    return {"child_id": "c", "style_lift": style_lift, "place_lift": place_lift}


def test_aggregate_means_both_lifts() -> None:
    report = _aggregate([_row(-7.0, 4.0), _row(1.0, 2.0)])
    assert report["mean_style_lift"] == pytest.approx(-3.0)
    assert report["mean_place_lift"] == pytest.approx(3.0)
    assert report["chains"] == [_row(-7.0, 4.0), _row(1.0, 2.0)]


def test_aggregate_empty_is_zero() -> None:
    report = _aggregate([])
    assert report["mean_style_lift"] == 0.0
    assert report["mean_place_lift"] == 0.0
    assert report["chains"] == []


class _StubImage:
    jpeg_bytes = b"\xff\xd8stub"


class _StubJudgement:
    def __init__(self, score: float) -> None:
        self.score = score
        self.rationale = "stub"


class _StubPath:
    def read_bytes(self) -> bytes:
        return b"\xff\xd8parent"


async def test_with_arm_rides_edit_seam_not_generate(monkeypatch, tmp_path) -> None:
    """The regression guard for the 2026-07-29 fix: the region-conditioned
    (with) arm MUST go through the edit seam (edit_image / continue_image) where
    reference pixels bite — NOT generate_image, which ignores reference_urls and
    kept place_lift structurally ~0. The without-arm is the only generate_image
    (via _enter with ref=None)."""
    calls: dict[str, list] = {"edit": [], "continue": [], "enter_ref": []}

    async def _fake_edit(image_data_url, instruction, **_kw):
        calls["edit"].append((image_data_url, _kw))
        return _StubImage()

    async def _fake_continue(image_data_url, instruction, **_kw):
        calls["continue"].append(image_data_url)
        return _StubImage()

    async def _fake_enter(prompt, aspect, model, ref):
        calls["enter_ref"].append(ref)
        return b"\xff\xd8without"

    async def _fake_judge(*_a, **_k):
        return _StubJudgement(5.0)

    from tests import map_corpus

    monkeypatch.setattr(map_corpus, "ROOT", tmp_path)
    monkeypatch.setattr(runner, "image_path", lambda _id: _StubPath())
    monkeypatch.setattr(coherence_runner, "_region_crop", lambda _b, _a: b"\xff\xd8region")
    monkeypatch.setattr(coherence_runner, "_enter", _fake_enter)
    monkeypatch.setattr(
        image_provider,
        "encode_data_url",
        lambda b: "data:region" if b == b"\xff\xd8region" else "data:parent",
    )
    monkeypatch.setattr(image_edit_provider, "edit_image", _fake_edit)
    monkeypatch.setattr(image_edit_provider, "continue_image", _fake_continue)
    monkeypatch.setattr(model_router, "resolve_model", lambda slot: f"model:{slot}")
    for name in ("score_style_pair", "score_place_match", "score_continuation"):
        monkeypatch.setattr(judge, name, _fake_judge)

    chain = {
        "parent_id": "p",
        "child_id": "c",
        "anchor": {},
        "label": "The Church",
        "view": "interior",
    }
    row = await runner._score_chain(chain, "16:9")

    # interior with-arm = edit_image on the region crop; without = generate (ref None).
    assert calls["edit"] == [
        ("data:region", {"model_override": "model:enter_scene"})
    ]
    assert calls["continue"] == []
    assert calls["enter_ref"] == [None]
    assert row["place_match_with"] == 5.0


async def test_exterior_with_arm_rides_zoom_continue(monkeypatch, tmp_path) -> None:
    """A view="exterior" chain routes the with-arm through the closeup rung
    (continue_image / Kontext), not edit_image."""
    calls: dict[str, list] = {"edit": [], "continue": []}

    async def _fake_edit(image_data_url, instruction, **_kw):
        calls["edit"].append(image_data_url)
        return _StubImage()

    async def _fake_continue(image_data_url, instruction, **_kw):
        calls["continue"].append(image_data_url)
        return _StubImage()

    async def _fake_enter(prompt, aspect, model, ref):
        return b"\xff\xd8without"

    async def _fake_judge(*_a, **_k):
        return _StubJudgement(5.0)

    from tests import map_corpus

    monkeypatch.setattr(map_corpus, "ROOT", tmp_path)
    monkeypatch.setattr(runner, "image_path", lambda _id: _StubPath())
    monkeypatch.setattr(coherence_runner, "_region_crop", lambda _b, _a: b"\xff\xd8region")
    monkeypatch.setattr(coherence_runner, "_enter", _fake_enter)
    monkeypatch.setattr(image_provider, "encode_data_url", lambda _b: "data:region")
    monkeypatch.setattr(image_edit_provider, "edit_image", _fake_edit)
    monkeypatch.setattr(image_edit_provider, "continue_image", _fake_continue)
    monkeypatch.setattr(model_router, "resolve_model", lambda slot: f"model:{slot}")
    for name in ("score_style_pair", "score_place_match", "score_continuation"):
        monkeypatch.setattr(judge, name, _fake_judge)

    chain = {
        "parent_id": "p",
        "child_id": "c",
        "anchor": {},
        "label": "The Lighthouse",
        "view": "exterior",
    }
    await runner._score_chain(chain, "16:9")

    assert calls["continue"] == ["data:region"]
    assert calls["edit"] == []
