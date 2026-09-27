import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from generate import GenerateBody, _event_stream
from providers import arrival, arrival_reference, image_edit, judge, llm
from providers.image import GeneratedImage
from providers.place_identity import verify_and_render
from providers.render_budget import RenderBudget
from tests.test_generate_enter import _collect
from tests.test_generate_place_identity import strict as strict_fixture

strict = strict_fixture


def result(**overrides):
    return arrival.parse_arrival({"checks": {**dict.fromkeys(arrival.AXES, "pass"), **overrides}, "rationale": "checked"})


@pytest.mark.parametrize("axis", arrival.AXES)
@pytest.mark.parametrize("state", ["fail", "unknown", None, True, 9])
def test_every_axis_is_required_and_only_explicit_pass_counts(axis, state):
    verdict = result(**{axis: state})
    assert verdict["status"] != "pass"
    assert arrival.parse_arrival({"status": "pass"})["status"] == "unknown"


@pytest.mark.parametrize("raw", ["", "not json", '{"checks":', "[]", '{"status":"pass"}'])
async def test_malformed_judge_reply_is_unknown(monkeypatch, raw):
    monkeypatch.setattr(llm, "_client", lambda: None)
    call = AsyncMock(return_value=SimpleNamespace(choices=[SimpleNamespace(finish_reason="stop", message=SimpleNamespace(content=raw))]))
    monkeypatch.setattr(llm, "_create_with_retry", call)
    assert (await arrival.check_exterior(b"ref", b"candidate", "Tower"))["status"] == "unknown"
    assert call.await_args.kwargs["max_tokens"] == 800


async def test_complete_structured_judge_reply_and_truncation(monkeypatch):
    monkeypatch.setattr(llm, "_client", lambda: None)
    choice = SimpleNamespace(finish_reason="stop", message=SimpleNamespace(content=json.dumps(result())))
    monkeypatch.setattr(llm, "_create_with_retry", AsyncMock(return_value=SimpleNamespace(choices=[choice])))
    assert (await arrival.check_exterior(b"ref", b"output", "Tower"))["status"] == "pass"
    choice.finish_reason = "length"
    assert (await arrival.check_exterior(b"ref", b"output", "Tower"))["status"] == "unknown"


@pytest.mark.parametrize("fence", ["json", "JSON", ""])
def test_complete_fenced_arrival_json_is_not_an_unknown(fence):
    assert arrival.parse_arrival_reply(f"```{fence}\n{json.dumps(result())}\n```")["status"] == "pass"


@pytest.mark.parametrize("raw", ['```json\n{"checks":\n```', '```json\n{}', 'text\n```json\n{}\n```', '```json\n{}\n```\nextra'])
def test_fence_support_does_not_salvage_incomplete_or_mixed_responses(raw):
    assert arrival.parse_arrival_reply(raw)["status"] == "unknown"


async def test_exterior_intent_reaches_planner_and_overrules_indoor_classifier(strict, monkeypatch):
    body, edit = strict
    body.arrival_intent = "exterior"
    body.prefetched_place_form = "interior"
    check = AsyncMock(return_value=result())
    monkeypatch.setattr(arrival, "check_exterior", check)
    events = await _collect(_event_stream(body, "exterior"))
    final = next(e for e in events if e["type"] == "final")
    assert "Arrive OUTSIDE" in llm.plan_page.await_args.kwargs["query"]
    assert "Arrive OUTSIDE" in edit.await_args.args[1]
    assert final["final_prompt"] == edit.await_args.args[1]
    assert final["scene_view"]["place_form"] != "interior"
    assert final["scene_view"]["level"] == "eye"
    assert final["scene_view"]["view"]["projection"] == "eye_level"
    assert judge.score_view_conformance.await_args.args[1] == "eye_level"
    assert edit.await_args.kwargs["aspect_ratio"] == body.aspect_ratio
    assert final["view_verdict"]["arrival"]["status"] == "pass"
    check.assert_awaited_once()


@pytest.mark.parametrize("failure", [None, RuntimeError("offline"), TimeoutError()])
async def test_physical_reference_failure_stops_before_planner_and_image(strict, monkeypatch, failure):
    body, edit = strict
    body.arrival_intent = "exterior"
    monkeypatch.setenv("WORLD_ARRIVAL_PHYSICAL_REFERENCE", "true")
    resolver = AsyncMock(side_effect=failure) if failure else AsyncMock(return_value=arrival_reference.PhysicalReference(None, {"status": "unknown"}))
    monkeypatch.setattr(arrival_reference, "resolve_physical_reference", resolver)
    events = await _collect(_event_stream(body, "bad-reference"))
    assert events[-1]["type"] == "error"
    assert events[-1]["reference_verdict"]["status"] == "unknown"
    assert not any(e["type"] in ("final", "progress") for e in events)
    edit.assert_not_awaited()
    llm.plan_page.assert_not_awaited()


@pytest.mark.parametrize("curated", [False, True])
async def test_physical_crop_reaches_both_renderer_and_identity_judge(strict, monkeypatch, curated):
    from providers.place_identity import reference_crop

    body, edit = strict
    body.arrival_intent = "exterior"
    body.place_reference.provenance = {"kind": "curated" if curated else "first_seen"}
    monkeypatch.setenv("WORLD_ARRIVAL_PHYSICAL_REFERENCE", "true")
    crop = reference_crop(body.image, arrival_reference.ReferenceBox(.1, .1, .8, .8))
    resolver = AsyncMock(return_value=arrival_reference.PhysicalReference(crop, {"status": "pass"}))
    monkeypatch.setattr(arrival_reference, "resolve_physical_reference", resolver)
    monkeypatch.setattr(arrival, "check_exterior", AsyncMock(return_value=result()))
    events = await _collect(_event_stream(body, "physical-reference"))
    assert any(e["type"] == "final" for e in events)
    from providers.image import encode_data_url
    assert edit.await_args.kwargs["identity_ref_url"] == encode_data_url(crop, "image/png")
    assert judge.score_entity_consistency.await_args.args[2] == crop
    assert resolver.await_args.kwargs["curated"] is curated


async def test_aerial_candidate_cannot_pass_using_a_client_oblique_hint(strict, monkeypatch):
    from providers.judge import JudgeResult

    body, _edit = strict
    body.arrival_intent = "exterior"
    assert body.scene_view.view.projection == "oblique"
    monkeypatch.setattr(arrival, "check_exterior", AsyncMock(return_value=result()))
    judge.score_view_conformance.side_effect = lambda _pixels, projection: JudgeResult(0 if projection == "eye_level" else 10, "aerial", "")
    events = await _collect(_event_stream(body, "aerial-camera"))
    assert not any(e["type"] == "final" for e in events)
    assert events[-1]["view_verdict"]["conformance"] == 0


@pytest.mark.parametrize("intent,enabled", [(None, "true"), ("interior", "true"), ("exterior", "false")])
async def test_preflight_is_opt_in_and_exterior_only(strict, monkeypatch, intent, enabled):
    body, _edit = strict
    body.arrival_intent = intent
    monkeypatch.setenv("WORLD_ARRIVAL_PHYSICAL_REFERENCE", enabled)
    resolver = AsyncMock()
    monkeypatch.setattr(arrival_reference, "resolve_physical_reference", resolver)
    monkeypatch.setattr(arrival, "check_exterior", AsyncMock(return_value=result()))
    await _collect(_event_stream(body, "no-preflight"))
    resolver.assert_not_awaited()


@pytest.mark.parametrize("bad", [result(near_target="fail"), result(single_target="unknown"), RuntimeError("offline")])
async def test_arrival_failure_never_publishes_even_with_high_identity_scores(strict, monkeypatch, bad):
    body, edit = strict
    body.arrival_intent = "exterior"
    monkeypatch.setattr(arrival, "check_exterior", AsyncMock(side_effect=bad) if isinstance(bad, Exception) else AsyncMock(return_value=bad))
    events = await _collect(_event_stream(body, "arrival-failure"))
    assert not any(e["type"] in ("final", "progress") for e in events)
    rejected = next(e for e in events if e["type"] == "error")
    assert rejected["candidate_image_data_url"] and not rejected["view_verdict"]["accepted"]
    edit.assert_awaited_once()


async def test_target_first_preserves_actual_reference_order(strict, monkeypatch):
    body, edit = strict
    body.arrival_intent = "exterior"
    monkeypatch.setenv("WORLD_ARRIVAL_REFERENCE_MODE", "target_first")
    monkeypatch.setattr(arrival, "check_exterior", AsyncMock(return_value=result()))
    events = await _collect(_event_stream(body, "target-first"))
    assert any(e["type"] == "final" for e in events)
    assert edit.await_args.args[0] != body.image
    assert edit.await_args.kwargs["context_ref_url"] == body.image
    assert edit.await_args.kwargs["identity_ref_url"] is None
    assert "Image 1 is the canonical" in edit.await_args.args[1]


def test_reference_mode_does_not_change_legacy_and_rejects_unknown_policy(monkeypatch):
    monkeypatch.setenv("WORLD_ARRIVAL_REFERENCE_MODE", "target_first")
    legacy = arrival.reference_inputs("source", "crop", "prompt", "Tower", "stone", exterior=False)
    assert legacy.source == "source" and legacy.identity == "crop" and legacy.context is None
    monkeypatch.setenv("WORLD_ARRIVAL_REFERENCE_MODE", "typo")
    with pytest.raises(ValueError, match="policy"):
        arrival.reference_inputs("source", "crop", "prompt", "Tower", "stone", exterior=True)
    with pytest.raises(ValueError):
        GenerateBody(query="x", session_id="x", arrival_intent="sideways")


async def test_retry_checks_final_bytes_and_reports_fixed_arrival(strict, monkeypatch):
    monkeypatch.setattr(arrival, "check_exterior", AsyncMock(side_effect=[result(near_target="fail"), result()]))
    budget = RenderBudget("arrival-test", 2, time.monotonic() + 300)
    async def render(suffix, index):
        budget.reserve("fal-ai/nano-banana-pro/edit")
        return GeneratedImage(f"output{index}".encode(), "image/png", "fal-ai/nano-banana-pro/edit", None)
    render = AsyncMock(side_effect=render)
    verified = await verify_and_render(render, budget=budget, reference=b"ref", label="Tower", visual="stone", projection="eye_level", facts=[], abort=AsyncMock(), exterior=True)
    assert verified.verdict["accepted"] and verified.image.jpeg_bytes == b"output1"
    assert "near_target" in render.await_args_list[1].args[0]
    assert arrival.check_exterior.await_args_list[1].args[1] == b"output1"


async def test_provider_payload_keeps_context_after_primary_crop(monkeypatch):
    from providers import mock
    monkeypatch.setattr(mock, "on", lambda: False)
    monkeypatch.setattr(image_edit, "_ensure_fal_key", lambda: None)
    monkeypatch.setattr(image_edit, "to_fal_url", AsyncMock(side_effect=lambda url: url))
    submit = AsyncMock(return_value={"images": [{"url": "output"}]})
    monkeypatch.setattr(image_edit, "_fal_subscribe", submit)
    monkeypatch.setattr(image_edit, "_fetch_image_bytes", AsyncMock(return_value=(b"pixels", "image/png")))
    await image_edit.edit_image("crop", "prompt", context_ref_url="source", model_override="fal-ai/nano-banana-pro")
    assert submit.await_args.args[0].endswith("/edit")
    assert submit.await_args.args[1]["image_urls"] == ["crop", "source"]
    with pytest.raises(ValueError, match="reference"):
        await image_edit.edit_image("crop", "prompt", context_ref_url="source", model_override="fal-ai/flux-pro/kontext")
