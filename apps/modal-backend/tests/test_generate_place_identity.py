"""Strict world SSE contract: no rejected candidate may become a final frame."""
import io
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from generate import _event_stream
from providers import image_edit, judge
from providers.image import GeneratedImage, encode_data_url
from providers.judge import JudgeResult
from tests.test_generate_ascend import _ascend_body, _enable, _mock_fresh
from tests.test_generate_enter import _collect, _mock_plan, _tap_body


@pytest.fixture
def strict(monkeypatch):
    monkeypatch.setenv("WORLD_IDENTITY_STRICT", "true")
    _mock_plan(monkeypatch)
    data = io.BytesIO()
    Image.new("RGB", (32, 32), "white").save(data, "PNG")
    raw = data.getvalue()
    url = encode_data_url(raw, "image/png")
    for name in ("score_style_pair", "score_view_conformance", "score_entity_consistency", "score_interior", "score_feature_articulation", "score_map_legibility", "score_step_in", "score_outward_place"):
        monkeypatch.setattr(judge, name, AsyncMock(return_value=JudgeResult(9, "pass", "")))

    async def render(*args, **kwargs):
        kwargs["budget"].reserve("fal-ai/nano-banana-pro")
        return GeneratedImage(raw, "image/png", "fal-ai/nano-banana-pro", None)

    edit = AsyncMock(side_effect=render)
    monkeypatch.setattr(image_edit, "edit_image", edit)
    body = _tap_body(world_mode=True, strict_world=True, target_geo_id="castle", image=url,
        place_reference={"geo_id": "castle", "label": "The Stone Castle", "visual": "concentric granite walls", "image_data_url": url, "bbox": {"x_pct": 0, "y_pct": 0, "w_pct": .5, "h_pct": 1}},
        scene_view={"node_id": "root", "level": "building", "focus_id": "castle", "observer": None, "view": {"projection": "oblique", "source": "user"}}, max_attempts=1)
    return body, edit


async def test_verified_enter_echoes_server_focus_without_preview(strict):
    body, edit = strict
    events = await _collect(_event_stream(body, "strict-enter"))
    final = next(e for e in events if e["type"] == "final")
    assert final["view_verdict"]["accepted"]
    assert final["scene_view"]["focus_id"] == "castle"
    assert final["scene_view"]["view"]["projection"] == "oblique"
    assert not any(e["type"] == "progress" for e in events)
    assert edit.await_args.args[0] == body.image
    assert edit.await_args.kwargs["identity_ref_url"] != body.image
    assert edit.await_count == 1


@pytest.mark.parametrize("score", [None, 4])
async def test_rejected_enter_never_emits_final_or_preview(strict, score):
    body, edit = strict
    judge.score_entity_consistency.return_value = None if score is None else JudgeResult(score, "wrong castle", "")
    events = await _collect(_event_stream(body, "strict-reject"))
    assert not any(e["type"] in ("final", "progress", "ascend_ready") for e in events)
    rejected = next(e for e in events if e["type"] == "error")
    assert rejected["candidate_image_data_url"]
    assert not rejected["view_verdict"]["accepted"]
    assert edit.await_count == 1


async def test_strict_requires_server_flag_and_matching_reference(strict, monkeypatch):
    body, edit = strict
    monkeypatch.setenv("WORLD_IDENTITY_STRICT", "false")
    assert (await _collect(_event_stream(body, "off")))[-1]["type"] == "error"
    monkeypatch.setenv("WORLD_IDENTITY_STRICT", "true")
    body.target_geo_id = "foreign"
    assert (await _collect(_event_stream(body, "mismatch")))[-1]["type"] == "error"
    edit.assert_not_called()


async def test_strict_zoom_is_judged_and_keeps_server_crop(strict):
    body, edit = strict
    body.render_mode = "place_submap"
    body.scene_view.level = "map"
    body.scene_view.closeup = True
    body.scene_view.view.projection = "top_down"
    events = await _collect(_event_stream(body, "zoom"))
    final = next(e for e in events if e["type"] == "final")
    assert final["scene_view"]["closeup"]
    assert final["view_verdict"]["accepted"]
    judge.score_step_in.assert_awaited_once()
    edit.assert_awaited_once()


@pytest.mark.parametrize("accepted", [True, False])
async def test_strict_outward_only_emits_ready_after_containment_passes(strict, monkeypatch, accepted):
    tap, edit = strict
    _enable(monkeypatch)
    _mock_fresh(monkeypatch)
    judge.score_outward_place.return_value = JudgeResult(9 if accepted else 3, "containment", "")
    body = _ascend_body(world_mode=True, strict_world=True, image=tap.image, max_attempts=1)
    events = await _collect(_event_stream(body, "outward"))
    assert any(e["type"] == "ascend_ready" for e in events) == accepted
    if not accepted:
        assert events[-1]["candidate_image_data_url"]
    edit.assert_awaited_once()
