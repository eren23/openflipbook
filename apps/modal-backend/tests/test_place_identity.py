from __future__ import annotations

import io
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from providers import image as image_provider
from providers import judge, spend
from providers.image import GeneratedImage, encode_data_url
from providers.judge import JudgeResult
from providers.place_identity import floor, reference_crop, verify_and_render
from providers.render_budget import RenderBudget, RenderLimitReached


@pytest.fixture(autouse=True)
def setup(monkeypatch):
    spend.reset_for_tests()
    monkeypatch.delenv("MAX_DAILY_SPEND", raising=False)
    monkeypatch.delenv("MAX_SESSION_SPEND", raising=False)
    for name in ("score_style_pair", "score_view_conformance", "score_entity_consistency", "score_interior", "score_feature_articulation", "score_map_legibility", "score_step_in", "score_outward_place"):
        monkeypatch.setattr(judge, name, AsyncMock(return_value=JudgeResult(8, "verified", "")))


async def run(monkeypatch, *, limit=2, **kwargs):
    budget = RenderBudget("test", limit, time.monotonic() + 300)

    async def render(suffix, index):
        budget.reserve("fal-ai/nano-banana-pro")
        return GeneratedImage(f"image{index}".encode(), "image/png", "fal-ai/nano-banana-pro", None)

    renderer = AsyncMock(side_effect=render)
    result = await verify_and_render(renderer, budget=budget, reference=b"reference", label="North Tower", visual="granite", projection="oblique", facts=["gate"], abort=AsyncMock(), **kwargs)
    return result, renderer, budget


@pytest.mark.parametrize("bad", [None, float("nan"), float("inf"), -1, 6, 11])
async def test_missing_nonfinite_or_low_required_score_rejects(monkeypatch, bad):
    judge.score_style_pair.return_value = None if bad is None else JudgeResult(bad, "style failed", "")
    result, render, budget = await run(monkeypatch)
    assert not result.verdict["accepted"]
    assert render.await_count == budget.attempts == 2
    assert result.rejection()["type"] == "error"
    assert "candidate_image_data_url" in result.rejection()
    assert "image_data_url" not in result.rejection()
    assert spend.session_total("test") == pytest.approx(.32)


async def test_a_retry_is_rejudged_on_all_axes_and_honors_user_limit(monkeypatch):
    judge.score_entity_consistency.side_effect = [JudgeResult(5, "wrong tower", ""), JudgeResult(9, "same tower", "")]
    result, render, _ = await run(monkeypatch)
    assert result.verdict["accepted"]
    assert result.image.jpeg_bytes == b"image1"
    assert "wrong tower" in render.await_args_list[1].args[0]
    assert judge.score_style_pair.await_count == 2
    judge.score_style_pair.return_value = JudgeResult(5, "failed", "")
    judge.score_entity_consistency.side_effect = None
    _, render, budget = await run(monkeypatch, limit=1)
    assert render.await_count == budget.attempts == 1


async def test_judge_exception_is_not_a_pass(monkeypatch):
    judge.score_view_conformance.side_effect = RuntimeError("unavailable")
    result, _, _ = await run(monkeypatch)
    assert result.verdict["conformance"] is None
    assert not result.verdict["accepted"]


async def test_interior_uses_indoor_identity_axis(monkeypatch):
    result, _, _ = await run(monkeypatch, interior=True)
    assert result.verdict["accepted"] and result.verdict["interior"] == 8
    assert result.verdict["same_place"] is None
    judge.score_entity_consistency.assert_not_called()


async def test_outward_rejects_same_style_different_city(monkeypatch):
    judge.score_outward_place.return_value = JudgeResult(4, "different city", "")
    result, _, _ = await run(monkeypatch, outward=True)
    assert not result.verdict["accepted"]
    judge.score_feature_articulation.assert_not_called()


async def test_zoom_checks_direction_and_detail(monkeypatch):
    judge.score_step_in.return_value = JudgeResult(2, "zoomed out", "")
    result, _, _ = await run(monkeypatch, zoom=True, map_zoom=True)
    assert not result.verdict["accepted"] and result.verdict["conformance"] == 2
    assert judge.score_map_legibility.await_count == 2


@pytest.mark.parametrize("report", [None, {"score": float("nan")}, {"score": .9, "missing": ["gate"]}, {"score": .4}])
async def test_spatial_verification_is_required_when_layout_is_known(monkeypatch, report):
    result, _, _ = await run(monkeypatch, grounding=AsyncMock(return_value=report))
    assert not result.verdict["accepted"]


def test_reference_crop_is_exact_and_bounded():
    out = io.BytesIO()
    Image.new("RGB", (100, 60), "red").save(out, "PNG")
    url = encode_data_url(out.getvalue(), "image/png")
    crop = reference_crop(url, SimpleNamespace(x_pct=.1, y_pct=.2, w_pct=.5, h_pct=.5))
    with Image.open(io.BytesIO(crop)) as img:
        assert img.size == (50, 30) and img.getpixel((0, 0)) == (255, 0, 0)
    with pytest.raises(ValueError):
        reference_crop(url, SimpleNamespace(x_pct=.9, y_pct=0, w_pct=.5, h_pct=1))


@pytest.mark.parametrize("value", ["nan", "inf", "", "bad", "0", "-1", "11"])
def test_floor_is_finite_and_positive(monkeypatch, value):
    monkeypatch.setenv("TEST_FLOOR", value)
    assert floor("TEST_FLOOR", 7) == 7


async def test_provider_transport_retries_share_budget_and_record_failed_submissions(monkeypatch):
    subscribe = AsyncMock(return_value={"images": []})
    monkeypatch.setattr(image_provider.fal_client, "subscribe_async", subscribe)
    budget = RenderBudget("transport", 2)
    with pytest.raises(RenderLimitReached):
        await image_provider._fal_subscribe("fal-ai/nano-banana-pro", {}, require_images=True, budget=budget)
    assert subscribe.await_count == budget.attempts == 2
    assert spend.session_total("transport") == pytest.approx(.32)


def test_spend_cap_and_deadline_stop_before_submission(monkeypatch):
    monkeypatch.setenv("MAX_SESSION_SPEND", ".2")
    budget = RenderBudget("cap", 2)
    budget.reserve("fal-ai/nano-banana-pro")
    with pytest.raises(RuntimeError, match="cap"):
        budget.reserve("fal-ai/nano-banana-pro")
    assert budget.attempts == 1
    with pytest.raises(RenderLimitReached):
        RenderBudget("late", 2, time.monotonic() - 1).reserve("model")
