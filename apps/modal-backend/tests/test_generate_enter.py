"""Integration tests for enter-via-edit: place_scene taps route through the
EDIT endpoint (where the region-crop ref actually bites) instead of the no-op
text-to-image ref path that reinvented every entered place (research/01).

ENTER_EDIT_REF is a default-ON kill-switch: off must be byte-identical to the
old fresh path. The conftest scrubs the flag so host config can't flip these.

generate.py imports `modal` at module level (deploy-only); stub it before import.
"""

from __future__ import annotations

import base64 as _b64
import json
import sys
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.modules.setdefault("modal", MagicMock())

import providers.image as image_mod  # noqa: E402
import providers.image_edit as image_edit_mod  # noqa: E402
import providers.llm as llm_mod  # noqa: E402
from generate import GenerateBody, _event_stream  # noqa: E402
from providers import model_router  # noqa: E402
from providers.image import GeneratedImage  # noqa: E402
from providers.llm import PagePlan  # noqa: E402


async def _collect(agen: Any) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    async for chunk in agen:
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        for block in text.strip().split("\n\n"):
            block = block.strip()
            if block.startswith("data:"):
                events.append(json.loads(block[len("data:") :].strip()))
    return events


def _tap_body(**over: Any) -> GenerateBody:
    """A world-mode tap entering a place, exactly as the geo-tap client sends
    it: explicit place_scene framing, prefetched hints, and the condition
    stack with the clean region crop first."""
    base: dict[str, Any] = {
        "query": "a walled harbor city",
        "session_id": "s1",
        "mode": "tap",
        "image": "data:image/jpeg;base64,annotated-parent",
        "click": {"x_pct": 0.6, "y_pct": 0.4},
        "web_search": False,
        "render_mode": "place_scene",
        "prefetched_subject": "The Stone Castle",
        "prefetched_subject_context": "a stone castle with concentric walls",
        "prefetched_surroundings": "to the north, the striped lighthouse.",
        "session_style_anchor": "hand-drawn engraving, sepia ink",
        "condition_image_urls": ["data:r", "data:p", "data:s"],
        "condition_roles": ["region", "parent", "style"],
    }
    base.update(over)
    return GenerateBody(**base)


def _mock_plan(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        llm_mod,
        "plan_page",
        AsyncMock(
            return_value=PagePlan(
                "The Stone Castle", "an interior scene", ["The Inner Bailey"], []
            )
        ),
    )


def _mock_edit(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    edit = AsyncMock(
        return_value=GeneratedImage(
            b"jpeg", "image/jpeg", "fal-ai/nano-banana-pro/edit", "r1"
        )
    )
    monkeypatch.setattr(image_edit_mod, "edit_image", edit)
    return edit


def _mock_fresh(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    gen = AsyncMock(
        return_value=GeneratedImage(b"jpeg", "image/jpeg", "fal-ai/nano-banana-pro", "r2")
    )
    monkeypatch.setattr(image_mod, "generate_image", gen)
    return gen


async def test_enter_routes_through_edit_with_region_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The default path: the CLEAN region crop is the edit source, the style
    # exemplar rides as the second ref, and the router's enter model is used.
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    gen = _mock_fresh(monkeypatch)

    events = await _collect(_event_stream(_tap_body(), "t1"))

    edit.assert_awaited_once()
    gen.assert_not_awaited()  # NOT the no-op text-to-image ref path (and no draft)
    assert edit.await_args.args[0] == "data:r"  # region crop, not the annotated parent
    instruction = edit.await_args.args[1]
    assert "The Stone Castle" in instruction
    assert "engraving" in instruction  # the medium lock reaches the edit text
    assert "lighthouse" in instruction  # neighbours stay where the map put them
    assert edit.await_args.kwargs["style_ref_url"] == "data:s"
    assert edit.await_args.kwargs["model_override"] == model_router.resolve_model(
        "enter_scene"
    )
    assert any(e["type"] == "final" for e in events)


async def test_enter_kill_switch_reverts_to_fresh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # ENTER_EDIT_REF=false must be byte-identical to the old behaviour: fresh
    # text-to-image with the (inert) reference stack.
    monkeypatch.setenv("ENTER_EDIT_REF", "false")
    monkeypatch.setenv("PROGRESSIVE_DRAFT", "false")
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    gen = _mock_fresh(monkeypatch)

    events = await _collect(_event_stream(_tap_body(), "t1"))

    edit.assert_not_awaited()
    gen.assert_awaited_once()
    assert gen.await_args.kwargs["reference_urls"] == ["data:r", "data:p", "data:s"]
    final = next(e for e in events if e["type"] == "final")
    assert "image_op" not in final  # fresh path: additive key stays absent


async def test_enter_skips_progressive_draft(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A text-only nano draft can't preview a conditioned edit — it would be a
    # second unconditioned reinvention flashing before the faithful render.
    monkeypatch.setenv("PROGRESSIVE_DRAFT", "true")
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    gen = _mock_fresh(monkeypatch)

    events = await _collect(_event_stream(_tap_body(image_tier="balanced"), "t1"))

    edit.assert_awaited_once()
    gen.assert_not_awaited()  # the draft would have used generate_image
    assert not [e for e in events if e["type"] == "progress"]


async def test_enter_without_source_falls_back_to_fresh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # place_scene framing but nothing to condition on (no click image, no
    # condition stack) → the defensive fresh fallback, never a broken edit call.
    monkeypatch.setenv("PROGRESSIVE_DRAFT", "false")
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    gen = _mock_fresh(monkeypatch)

    body = _tap_body(
        mode="query",
        image=None,
        click=None,
        condition_image_urls=None,
        condition_roles=None,
        prefetched_subject=None,
    )
    await _collect(_event_stream(body, "t1"))

    edit.assert_not_awaited()
    gen.assert_awaited_once()


async def test_enter_final_event_shows_edit_route(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The final event must make the route machine-checkable: the edit model,
    # the enter instruction as final_prompt, and the additive image_op key.
    # (View grammar off: this test pins the ROUTING, not the camera wording —
    # tests/test_generate_view.py owns the view-aware instruction content.)
    monkeypatch.setenv("VIEW_GRAMMAR", "false")
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)

    events = await _collect(_event_stream(_tap_body(), "t1"))

    final = next(e for e in events if e["type"] == "final")
    assert final["image_model"] == "fal-ai/nano-banana-pro/edit"
    assert final["image_op"] == "enter_scene"
    assert "Step INSIDE" in final["final_prompt"]
    assert "ground level" in final["final_prompt"]


async def test_enter_explicit_image_model_wins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A per-request model override beats the router slot (mirrors continuation).
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)

    await _collect(
        _event_stream(_tap_body(image_model="fal-ai/flux-pro/kontext"), "t1")
    )

    assert edit.await_args.kwargs["model_override"] == "fal-ai/flux-pro/kontext"


async def test_submap_zoom_continue_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Regression lock: the place_submap path still strict-zooms via Kontext.
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    cont = AsyncMock(
        return_value=GeneratedImage(b"jpeg", "image/jpeg", "fal-ai/flux-pro/kontext", "r3")
    )
    monkeypatch.setattr(image_edit_mod, "continue_image", cont)
    gen = _mock_fresh(monkeypatch)

    await _collect(_event_stream(_tap_body(render_mode="place_submap"), "t1"))

    cont.assert_awaited_once()
    assert cont.await_args.args[0] == "data:r"
    edit.assert_not_awaited()
    gen.assert_not_awaited()


async def test_explainer_tap_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    # Regression lock: a plain explainer tap (no render_mode) keeps today's
    # fresh, reference-stack generation.
    monkeypatch.setenv("PROGRESSIVE_DRAFT", "false")
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    gen = _mock_fresh(monkeypatch)

    await _collect(_event_stream(_tap_body(render_mode=None), "t1"))

    edit.assert_not_awaited()
    gen.assert_awaited_once()
    assert gen.await_args.kwargs["reference_urls"] == ["data:r", "data:p", "data:s"]


async def test_world_off_submap_request_still_zoom_continues(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The wideRegionCut contract: a classic (world OFF) tap that the client
    # routed as place_submap rides the same Kontext cut as a world-mode submap
    # tap — the river page is a faithful crop-zoom, not a re-imagined city.
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    cont = AsyncMock(
        return_value=GeneratedImage(b"jpeg", "image/jpeg", "fal-ai/flux-pro/kontext", "r3")
    )
    monkeypatch.setattr(image_edit_mod, "continue_image", cont)
    gen = _mock_fresh(monkeypatch)

    await _collect(
        _event_stream(_tap_body(render_mode="place_submap", world_mode=False), "t1")
    )

    cont.assert_awaited_once()
    edit.assert_not_awaited()
    gen.assert_not_awaited()


def test_same_place_judge_defaults_to_step_in(monkeypatch) -> None:
    """The loop's same-place axis is zoom-aware by default — a city-wide
    redraw of a tapped courtyard must not pass as 'the same place'.
    ENTER_STEP_IN_JUDGE=false reverts to the plain continuation judge."""
    import generate
    from providers import judge

    monkeypatch.delenv("ENTER_STEP_IN_JUDGE", raising=False)
    assert generate._same_place_judge(judge) is judge.score_step_in
    monkeypatch.setenv("ENTER_STEP_IN_JUDGE", "false")
    assert generate._same_place_judge(judge) is judge.score_continuation


# ---------- classic tap-zoom (TAP_ZOOM_CONTINUE, default ON) ------------------
#
# "Zooming in just creates a new image, similar but totally different": classic
# taps rode the FRESH text-to-image path, whose fal nano endpoints IGNORE the
# region ref the client sends. These pin the fix — a tap the classifier reads
# as a concrete place/thing (enter_as scene|submap) rides the same Kontext
# zoom_continue as a world submap tap, so the arrival IS the tapped region.


def _mock_continue(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    cont = AsyncMock(
        return_value=GeneratedImage(
            b"jpeg", "image/jpeg", "fal-ai/flux-pro/kontext", "r4"
        )
    )
    monkeypatch.setattr(image_edit_mod, "continue_image", cont)
    return cont


def _classic_body(**over: Any) -> GenerateBody:
    """A classic (world OFF) warm tap: no render_mode from the client, the
    prefetch cache carried the classification."""
    defaults: dict[str, Any] = {
        "render_mode": None,
        "world_mode": False,
        "prefetched_enter_as": "submap",
    }
    defaults.update(over)
    return _tap_body(**defaults)


async def test_classic_tap_prefetched_enter_as_submap_zoom_continues(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    cont = _mock_continue(monkeypatch)
    gen = _mock_fresh(monkeypatch)

    await _collect(_event_stream(_classic_body(), "t1"))

    cont.assert_awaited_once()
    assert cont.await_args.args[0] == "data:r"  # the region crop is the source
    edit.assert_not_awaited()
    gen.assert_not_awaited()


async def test_classic_tap_prefetched_enter_as_scene_zoom_continues(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # `scene` maps to place_closeup — the VIEW register ("from the SAME
    # viewpoint the reference shows"), not the cartographic map wording, so a
    # tapped castle in a watercolor scene doesn't get map instructions.
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    cont = _mock_continue(monkeypatch)
    gen = _mock_fresh(monkeypatch)

    await _collect(_event_stream(_classic_body(prefetched_enter_as="scene"), "t1"))

    cont.assert_awaited_once()
    gen.assert_not_awaited()
    instruction = cont.await_args.args[1]
    assert "from the SAME viewpoint the reference shows" in instruction


async def test_classic_tap_prefetched_enter_as_explainer_stays_fresh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Concepts / diagram parts keep the fresh labelled explainer — the
    # product's "tap = topical depth" survives where it's the point.
    monkeypatch.setenv("PROGRESSIVE_DRAFT", "false")
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    cont = _mock_continue(monkeypatch)
    gen = _mock_fresh(monkeypatch)

    await _collect(
        _event_stream(_classic_body(prefetched_enter_as="explainer"), "t1")
    )

    gen.assert_awaited_once()
    cont.assert_not_awaited()
    edit.assert_not_awaited()


async def test_classic_tap_zoom_kill_switch_stays_fresh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TAP_ZOOM_CONTINUE", "false")
    monkeypatch.setenv("PROGRESSIVE_DRAFT", "false")
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    cont = _mock_continue(monkeypatch)
    gen = _mock_fresh(monkeypatch)

    await _collect(_event_stream(_classic_body(), "t1"))

    gen.assert_awaited_once()
    cont.assert_not_awaited()


async def test_classic_cold_tap_classified_scene_zoom_continues(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # No prefetch — the in-band resolve classifies, and the classic router
    # maps it the same way.
    from providers.llm import ClickResolution

    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    cont = _mock_continue(monkeypatch)
    gen = _mock_fresh(monkeypatch)
    monkeypatch.setattr(
        llm_mod,
        "click_to_subject",
        AsyncMock(
            return_value=ClickResolution(
                subject="The Skull Rock", style="watercolor", enter_as="scene"
            )
        ),
    )

    await _collect(
        _event_stream(
            _classic_body(prefetched_subject=None, prefetched_enter_as=None), "t1"
        )
    )

    cont.assert_awaited_once()
    gen.assert_not_awaited()


async def test_classic_zoom_without_region_stays_fresh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # No condition refs → nothing to zoom into; the router must not set a
    # zoom mode it can't honour (select_operation would fall back anyway,
    # but place_* would still flip the planner register).
    monkeypatch.setenv("PROGRESSIVE_DRAFT", "false")
    _mock_plan(monkeypatch)
    cont = _mock_continue(monkeypatch)
    gen = _mock_fresh(monkeypatch)

    await _collect(
        _event_stream(
            _classic_body(condition_image_urls=None, condition_roles=None), "t1"
        )
    )

    gen.assert_awaited_once()
    cont.assert_not_awaited()


# ---------- the zoom judge (TAP_ZOOM_JUDGE, default ON) ----------------------
#
# Every zoom-continued tap is checked by the step-in judge (the arrival must
# be the SAME region, closer) with ONE keep-best retry. Judge failures and
# stub refs (undecodable data URLs) never block the tap.


def _region_data_url(payload: bytes = b"region-crop") -> str:
    return "data:image/jpeg;base64," + _b64.b64encode(payload).decode()


def _mock_step_in(monkeypatch: pytest.MonkeyPatch, scores: list[float]) -> AsyncMock:
    from providers import judge as judge_mod
    from providers.judge import JudgeResult

    step = AsyncMock(
        side_effect=[JudgeResult(s, f"verdict {s}", "raw") for s in scores]
    )
    monkeypatch.setattr(judge_mod, "score_step_in", step)
    # The legibility axis (TAP_ZOOM_DETAIL, default ON) rides alongside on
    # map-register zooms — pin it PASSING so these tests keep exercising the
    # step-in axis alone; the detail-gate tests below own the legibility axis.
    _mock_legibility(monkeypatch, [9.0] * max(2, len(scores)))
    return step


def _mock_legibility(
    monkeypatch: pytest.MonkeyPatch, scores: list[tuple[float, str] | float]
) -> AsyncMock:
    from providers import judge as judge_mod
    from providers.judge import JudgeResult

    results = [
        JudgeResult(s, "ok", "raw")
        if isinstance(s, (int, float))
        else JudgeResult(s[0], s[1], "raw")
        for s in scores
    ]
    leg = AsyncMock(side_effect=results)
    monkeypatch.setattr(judge_mod, "score_map_legibility", leg)
    return leg


async def test_zoom_judge_pass_is_single_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    cont = _mock_continue(monkeypatch)
    _mock_fresh(monkeypatch)
    step = _mock_step_in(monkeypatch, [7.5])

    await _collect(
        _event_stream(
            _classic_body(
                condition_image_urls=[_region_data_url(), "data:p"],
                condition_roles=["region", "parent"],
            ),
            "t1",
        )
    )

    cont.assert_awaited_once()
    step.assert_awaited_once()
    assert step.await_args.args[0] == b"region-crop"  # judged vs the REGION


async def test_zoom_judge_fail_retries_with_rationale_and_keeps_best(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    first = GeneratedImage(b"jpeg-first", "image/jpeg", "fal-ai/flux-pro/kontext", "r1")
    second = GeneratedImage(b"jpeg-second", "image/jpeg", "fal-ai/flux-pro/kontext", "r2")
    cont = AsyncMock(side_effect=[first, second])
    monkeypatch.setattr(image_edit_mod, "continue_image", cont)
    _mock_fresh(monkeypatch)
    _mock_step_in(monkeypatch, [4.0, 8.0])  # fail → retry wins

    events = await _collect(
        _event_stream(
            _classic_body(
                condition_image_urls=[_region_data_url(), "data:p"],
                condition_roles=["region", "parent"],
            ),
            "t1",
        )
    )

    assert cont.await_count == 2
    retry_instruction = cont.await_args_list[1].args[1]
    assert "rejected by a reviewer" in retry_instruction
    assert "verdict 4.0" in retry_instruction  # the critic's rationale rides in
    final = next(e for e in events if e["type"] == "final")
    assert _b64.b64encode(b"jpeg-second").decode() in final["image_data_url"]


async def test_zoom_judge_keep_best_prefers_first_when_retry_worse(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    first = GeneratedImage(b"jpeg-first", "image/jpeg", "fal-ai/flux-pro/kontext", "r1")
    second = GeneratedImage(b"jpeg-second", "image/jpeg", "fal-ai/flux-pro/kontext", "r2")
    cont = AsyncMock(side_effect=[first, second])
    monkeypatch.setattr(image_edit_mod, "continue_image", cont)
    _mock_fresh(monkeypatch)
    _mock_step_in(monkeypatch, [4.0, 3.0])  # retry is WORSE → keep first

    events = await _collect(
        _event_stream(
            _classic_body(
                condition_image_urls=[_region_data_url(), "data:p"],
                condition_roles=["region", "parent"],
            ),
            "t1",
        )
    )

    assert cont.await_count == 2
    final = next(e for e in events if e["type"] == "final")
    assert _b64.b64encode(b"jpeg-first").decode() in final["image_data_url"]


async def test_zoom_judge_kill_switch_skips_judge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TAP_ZOOM_JUDGE", "false")
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    cont = _mock_continue(monkeypatch)
    _mock_fresh(monkeypatch)
    step = _mock_step_in(monkeypatch, [9.0])

    await _collect(
        _event_stream(
            _classic_body(
                condition_image_urls=[_region_data_url(), "data:p"],
                condition_roles=["region", "parent"],
            ),
            "t1",
        )
    )

    cont.assert_awaited_once()
    step.assert_not_awaited()


async def test_zoom_judge_error_never_blocks_the_tap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from providers import judge as judge_mod

    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    cont = _mock_continue(monkeypatch)
    _mock_fresh(monkeypatch)
    monkeypatch.setattr(
        judge_mod, "score_step_in", AsyncMock(side_effect=RuntimeError("judge down"))
    )
    _mock_legibility(monkeypatch, [9.0, 9.0])  # only step_in is down

    events = await _collect(
        _event_stream(
            _classic_body(
                condition_image_urls=[_region_data_url(), "data:p"],
                condition_roles=["region", "parent"],
            ),
            "t1",
        )
    )

    cont.assert_awaited_once()
    assert any(e["type"] == "final" for e in events)


# ---------- interior enters (INTERIOR_ENTERS, default ON) ---------------------
#
# A tap the classifier reads as place_form="interior" (a room OR a discrete
# roofed building) renders the INDOOR view: the enter instruction flips to the
# interior register, the loop's same-place judge is swapped for score_interior,
# and the final event stamps the arrival at the room rung. `false` is a strict
# kill-switch back to today's exterior enters.


def _interior_resolution(monkeypatch: pytest.MonkeyPatch, place_form: str) -> None:
    from providers.llm import ClickResolution

    monkeypatch.setattr(
        llm_mod,
        "click_to_subject",
        AsyncMock(
            return_value=ClickResolution(
                subject="The Tower of Art",
                style="hand-drawn engraving",
                enter_as="scene",
                place_form=place_form,
            )
        ),
    )


def _interior_body(**over: Any) -> GenerateBody:
    """A cold place_scene tap (no prefetch → the in-band resolve carries
    place_form) with a decodable region crop."""
    defaults: dict[str, Any] = {
        "prefetched_subject": None,
        "prefetched_subject_context": None,
        "prefetched_surroundings": None,
        "condition_image_urls": [_region_data_url(), "data:p", "data:s"],
        "condition_roles": ["region", "parent", "style"],
    }
    defaults.update(over)
    return _tap_body(**defaults)


def _spy_enter_instruction(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    captured: dict[str, Any] = {}
    real = image_edit_mod.build_enter_instruction

    def spy(*args: Any, **kwargs: Any) -> str:
        captured.update(kwargs)
        return real(*args, **kwargs)

    monkeypatch.setattr(image_edit_mod, "build_enter_instruction", spy)
    return captured


async def test_interior_place_form_flips_instruction_to_indoor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Default (flag unset = ON): place_form interior + place_scene → the
    # builder is called with interior=True and the matched world entity's
    # appearance.
    monkeypatch.setenv("VIEW_LOOP", "false")  # routing only, no judges
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)
    _interior_resolution(monkeypatch, "interior")
    captured = _spy_enter_instruction(monkeypatch)

    await _collect(
        _event_stream(
            _interior_body(
                world_context=[
                    {
                        "id": "e1",
                        "kind": "place",
                        "name": "The Tower of Art",
                        "appearance": "black basalt, no windows",
                    }
                ]
            ),
            "t1",
        )
    )

    assert captured["interior"] is True
    assert captured["exterior_appearance"] == "black basalt, no windows"
    instruction = edit.await_args.args[1]
    assert "INDOOR" in instruction
    assert "NOT the building's exterior" in instruction
    assert "black basalt, no windows" in instruction


async def test_interior_kill_switch_reverts_to_exterior_enter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("INTERIOR_ENTERS", "false")
    monkeypatch.setenv("VIEW_LOOP", "false")
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)
    _interior_resolution(monkeypatch, "interior")
    captured = _spy_enter_instruction(monkeypatch)

    events = await _collect(_event_stream(_interior_body(), "t1"))

    assert captured["interior"] is False
    assert "INDOOR" not in edit.await_args.args[1]
    final = next(e for e in events if e["type"] == "final")
    assert "scene_view" not in final  # no stamp when off


async def test_complex_place_form_keeps_exterior_enter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VIEW_LOOP", "false")
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)
    _interior_resolution(monkeypatch, "complex")
    captured = _spy_enter_instruction(monkeypatch)

    events = await _collect(_event_stream(_interior_body(), "t1"))

    assert captured["interior"] is False
    assert "INDOOR" not in edit.await_args.args[1]
    final = next(e for e in events if e["type"] == "final")
    assert "scene_view" not in final


def _mock_loop_judges(
    monkeypatch: pytest.MonkeyPatch, interior_scores: list[tuple[float, str]]
) -> tuple[AsyncMock, AsyncMock]:
    """Good scores on every axis except interior (per interior_scores).
    Returns (interior, step_in) mocks — step_in must stay un-awaited on
    interior enters (the swap)."""
    from providers import judge as judge_mod
    from providers.judge import JudgeResult

    ok = JudgeResult(score=9.0, rationale="", raw="")
    interior = AsyncMock(
        side_effect=[JudgeResult(s, r, "") for s, r in interior_scores]
    )
    step_in = AsyncMock(return_value=ok)
    monkeypatch.setattr(judge_mod, "score_view_conformance", AsyncMock(return_value=ok))
    monkeypatch.setattr(judge_mod, "score_feature_articulation", AsyncMock(return_value=ok))
    monkeypatch.setattr(judge_mod, "score_style_pair", AsyncMock(return_value=ok))
    monkeypatch.setattr(judge_mod, "score_interior", interior)
    monkeypatch.setattr(judge_mod, "score_step_in", step_in)
    monkeypatch.setattr(judge_mod, "score_continuation", step_in)
    return interior, step_in


async def test_interior_enter_swaps_judge_and_stamps_scene_view(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The view loop judges interior enters with score_interior INSTEAD of the
    # step-in judge, against the region crop; the final stamps the arrival.
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)
    _interior_resolution(monkeypatch, "interior")
    interior, step_in = _mock_loop_judges(monkeypatch, [(9.0, "clean interior")])

    events = await _collect(_event_stream(_interior_body(), "t1"))

    edit.assert_awaited_once()
    interior.assert_awaited_once()
    step_in.assert_not_awaited()
    assert interior.await_args.args[0] == b"region-crop"  # judged vs the crop
    final = next(e for e in events if e["type"] == "final")
    assert final["scene_view"]["scale_tier"] == "room"
    assert final["scene_view"]["place_form"] == "interior"


async def test_interior_judge_fail_retries_with_rationale(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # An exterior arrival fails the interior floor → one retry whose
    # instruction carries the judge's own diagnosis + the indoor directive.
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)
    _interior_resolution(monkeypatch, "interior")
    _, step_in = _mock_loop_judges(
        monkeypatch, [(2.0, "still shows the facade"), (9.0, "indoors now")]
    )

    events = await _collect(_event_stream(_interior_body(), "t1"))

    assert edit.await_count == 2
    retry_instruction = edit.await_args_list[1].args[1]
    assert "failed the interior check" in retry_instruction
    assert "still shows the facade" in retry_instruction
    step_in.assert_not_awaited()
    assert any(e["type"] == "final" for e in events)


async def test_interior_accept_env_floor_is_honored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # INTERIOR_ACCEPT lowers the floor: a 5.0 interior passes at 4.0.
    monkeypatch.setenv("INTERIOR_ACCEPT", "4.0")
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)
    _interior_resolution(monkeypatch, "interior")
    interior, _ = _mock_loop_judges(monkeypatch, [(5.0, "weak kinship but indoors")])

    await _collect(_event_stream(_interior_body(), "t1"))

    edit.assert_awaited_once()  # accepted on the first attempt — no retry
    interior.assert_awaited_once()


# ---------- real map zoom (SUBMAP_REDRAW, default ON) --------------------------
#
# Kontext is reference-frozen: a world-mode submap "zoom" crop-UPSCALED the
# region without re-synthesizing detail — dense city maps arrived as blurry
# illegible mush. Default ON, the zoom is a FRESH cartographic re-render
# (tier model) conditioned on the region crop; `false` is a strict kill-switch
# back to the Kontext continue, and classic (non-world) submaps keep Kontext
# regardless.


def _world_submap_body(**over: Any) -> GenerateBody:
    defaults: dict[str, Any] = {
        "render_mode": "place_submap",
        "world_mode": True,
    }
    defaults.update(over)
    return _tap_body(**defaults)


async def test_world_submap_redraw_routes_fresh_with_region_ref(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Default (flag unset = ON): the world submap zoom is a fresh tier-model
    # render — the region crop rides as the reference + conditioning preamble,
    # continue_image is never called, and the wire says map_redraw.
    monkeypatch.setenv("WORLD_MODE", "true")
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    cont = _mock_continue(monkeypatch)
    gen = _mock_fresh(monkeypatch)

    events = await _collect(_event_stream(_world_submap_body(), "t1"))

    gen.assert_awaited_once()
    cont.assert_not_awaited()
    edit.assert_not_awaited()
    assert gen.await_args.kwargs["reference_urls"] == ["data:r"]  # the region crop
    assert gen.await_args.kwargs["tier"] is None  # the fresh path's tier resolve
    assert gen.await_args.kwargs["model_override"] is None  # no hardcoded model
    prompt = gen.await_args.kwargs["prompt"]
    assert prompt.startswith("Use the reference images as visual grounding")
    assert "MORE DETAILED map" in prompt
    final = next(e for e in events if e["type"] == "final")
    assert final["image_op"] == "map_redraw"
    assert final["image_model"] == "fal-ai/nano-banana-pro"


async def test_submap_redraw_kill_switch_is_todays_kontext(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WORLD_MODE", "true")
    monkeypatch.setenv("SUBMAP_REDRAW", "false")
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    cont = _mock_continue(monkeypatch)
    gen = _mock_fresh(monkeypatch)

    events = await _collect(_event_stream(_world_submap_body(), "t1"))

    cont.assert_awaited_once()
    gen.assert_not_awaited()
    assert cont.await_args.args[0] == "data:r"
    assert cont.await_args.args[1].startswith("Zoom into")  # the legacy wording
    final = next(e for e in events if e["type"] == "final")
    assert final["image_op"] == "zoom_continue"


async def test_classic_submap_keeps_kontext_regardless_of_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # World mode NOT effective (env off) → the redraw never arms, whatever the
    # flag says. Blast-radius choice: classic submap zooms stay Kontext.
    monkeypatch.setenv("SUBMAP_REDRAW", "true")
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    cont = _mock_continue(monkeypatch)
    gen = _mock_fresh(monkeypatch)

    events = await _collect(_event_stream(_world_submap_body(), "t1"))

    cont.assert_awaited_once()
    gen.assert_not_awaited()
    final = next(e for e in events if e["type"] == "final")
    assert final["image_op"] == "zoom_continue"


async def test_redraw_prompt_carries_clauses_and_style(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The redraw instruction = closer-richer wording + medium/style lock +
    # lettering guard (+ the top-down map lever when armed), and it is also
    # the reported final_prompt.
    monkeypatch.setenv("WORLD_MODE", "true")
    monkeypatch.setenv("WORLD_TOPDOWN_MAPS", "true")
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    _mock_continue(monkeypatch)
    gen = _mock_fresh(monkeypatch)

    events = await _collect(_event_stream(_world_submap_body(), "t1"))

    prompt = gen.await_args.kwargs["prompt"]
    assert 'Draw a closer, richer, MORE DETAILED map of "The Stone Castle"' in prompt
    assert "individual buildings, lanes, courtyards" in prompt
    assert "The Inner Bailey" in prompt  # the planner's facts ride in
    assert "hand-drawn engraving, sepia ink" in prompt  # the medium lock
    assert "garbled" in prompt  # the lettering guard
    assert "FLAT TOP-DOWN" in prompt  # the map lever rides the redraw
    final = next(e for e in events if e["type"] == "final")
    assert "MORE DETAILED map" in final["final_prompt"]


# ---------- the zoom legibility gate (TAP_ZOOM_DETAIL, default ON) -------------
#
# score_step_in alone cannot catch upscale mush — a blurry magnification IS the
# same region seen closer. Map-register zooms (submap, either op) must ALSO
# pass score_map_legibility; a fail folds its rationale into the ONE existing
# keep-best retry. view-register zooms (place_closeup) are exempt.


async def test_zoom_detail_both_pass_accepts_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    cont = _mock_continue(monkeypatch)
    _mock_fresh(monkeypatch)
    _mock_step_in(monkeypatch, [8.0])
    leg = _mock_legibility(monkeypatch, [7.0])

    await _collect(
        _event_stream(
            _classic_body(
                condition_image_urls=[_region_data_url(), "data:p"],
                condition_roles=["region", "parent"],
            ),
            "t1",
        )
    )

    cont.assert_awaited_once()
    leg.assert_awaited_once()
    assert leg.await_args.args[0] == b"jpeg"  # judged on the ARRIVAL bytes


async def test_zoom_detail_fail_retries_with_legibility_rationale(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Step-in passes, legibility fails → the retry fires carrying the
    # legibility rationale ONLY (the passing axis does not pollute it), and
    # keep-best prefers the crisper second attempt.
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    first = GeneratedImage(b"jpeg-first", "image/jpeg", "fal-ai/flux-pro/kontext", "r1")
    second = GeneratedImage(b"jpeg-second", "image/jpeg", "fal-ai/flux-pro/kontext", "r2")
    cont = AsyncMock(side_effect=[first, second])
    monkeypatch.setattr(image_edit_mod, "continue_image", cont)
    _mock_fresh(monkeypatch)
    _mock_step_in(monkeypatch, [9.0, 9.0])
    _mock_legibility(monkeypatch, [(2.0, "smeared upscale mush"), (8.0, "crisp")])

    events = await _collect(
        _event_stream(
            _classic_body(
                condition_image_urls=[_region_data_url(), "data:p"],
                condition_roles=["region", "parent"],
            ),
            "t1",
        )
    )

    assert cont.await_count == 2
    retry_instruction = cont.await_args_list[1].args[1]
    assert "rejected by a reviewer" in retry_instruction
    assert "smeared upscale mush" in retry_instruction
    assert "verdict 9.0" not in retry_instruction  # the passing axis stays out
    final = next(e for e in events if e["type"] == "final")
    assert _b64.b64encode(b"jpeg-second").decode() in final["image_data_url"]


async def test_zoom_detail_both_axes_fail_folds_both_rationales(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    first = GeneratedImage(b"jpeg-first", "image/jpeg", "fal-ai/flux-pro/kontext", "r1")
    second = GeneratedImage(b"jpeg-second", "image/jpeg", "fal-ai/flux-pro/kontext", "r2")
    cont = AsyncMock(side_effect=[first, second])
    monkeypatch.setattr(image_edit_mod, "continue_image", cont)
    _mock_fresh(monkeypatch)
    _mock_step_in(monkeypatch, [4.0, 8.0])
    _mock_legibility(monkeypatch, [(2.0, "smeared mush"), (8.0, "crisp")])

    await _collect(
        _event_stream(
            _classic_body(
                condition_image_urls=[_region_data_url(), "data:p"],
                condition_roles=["region", "parent"],
            ),
            "t1",
        )
    )

    retry_instruction = cont.await_args_list[1].args[1]
    assert "verdict 4.0" in retry_instruction  # step-in's rationale
    assert "smeared mush" in retry_instruction  # + legibility's


async def test_zoom_detail_keep_best_spans_both_axes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Retry passes neither; totals decide (first 9+2=11 vs second 8+1=9) →
    # keep the first attempt.
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    first = GeneratedImage(b"jpeg-first", "image/jpeg", "fal-ai/flux-pro/kontext", "r1")
    second = GeneratedImage(b"jpeg-second", "image/jpeg", "fal-ai/flux-pro/kontext", "r2")
    cont = AsyncMock(side_effect=[first, second])
    monkeypatch.setattr(image_edit_mod, "continue_image", cont)
    _mock_fresh(monkeypatch)
    _mock_step_in(monkeypatch, [9.0, 8.0])
    _mock_legibility(monkeypatch, [(2.0, "mush"), (1.0, "worse mush")])

    events = await _collect(
        _event_stream(
            _classic_body(
                condition_image_urls=[_region_data_url(), "data:p"],
                condition_roles=["region", "parent"],
            ),
            "t1",
        )
    )

    assert cont.await_count == 2
    final = next(e for e in events if e["type"] == "final")
    assert _b64.b64encode(b"jpeg-first").decode() in final["image_data_url"]


async def test_zoom_detail_kill_switch_never_calls_legibility(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TAP_ZOOM_DETAIL", "false")
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    cont = _mock_continue(monkeypatch)
    _mock_fresh(monkeypatch)
    _mock_step_in(monkeypatch, [9.0])
    leg = _mock_legibility(monkeypatch, [9.0])  # would pass — must not be asked

    await _collect(
        _event_stream(
            _classic_body(
                condition_image_urls=[_region_data_url(), "data:p"],
                condition_roles=["region", "parent"],
            ),
            "t1",
        )
    )

    cont.assert_awaited_once()
    leg.assert_not_awaited()


async def test_zoom_detail_skips_view_register_closeups(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # place_closeup zooms ride the "view" register — no map-craft judging.
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    cont = _mock_continue(monkeypatch)
    _mock_fresh(monkeypatch)
    _mock_step_in(monkeypatch, [9.0])
    leg = _mock_legibility(monkeypatch, [9.0])

    await _collect(
        _event_stream(
            _classic_body(
                prefetched_enter_as="scene",  # → place_closeup
                condition_image_urls=[_region_data_url(), "data:p"],
                condition_roles=["region", "parent"],
            ),
            "t1",
        )
    )

    cont.assert_awaited_once()
    leg.assert_not_awaited()


async def test_zoom_detail_accept_env_floor_is_honored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # TAP_ZOOM_DETAIL_ACCEPT lowers the floor: a 5.0 passes at 4.0.
    monkeypatch.setenv("TAP_ZOOM_DETAIL_ACCEPT", "4.0")
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    cont = _mock_continue(monkeypatch)
    _mock_fresh(monkeypatch)
    _mock_step_in(monkeypatch, [9.0])
    _mock_legibility(monkeypatch, [5.0])

    await _collect(
        _event_stream(
            _classic_body(
                condition_image_urls=[_region_data_url(), "data:p"],
                condition_roles=["region", "parent"],
            ),
            "t1",
        )
    )

    cont.assert_awaited_once()  # accepted — no retry


async def test_zoom_detail_gates_the_redraw_op_too(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The legibility gate covers BOTH ops: a mushy redraw retries on the
    # FRESH path (never Kontext), rationale folded in.
    monkeypatch.setenv("WORLD_MODE", "true")
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    cont = _mock_continue(monkeypatch)
    gen = _mock_fresh(monkeypatch)
    _mock_step_in(monkeypatch, [9.0, 9.0])
    _mock_legibility(monkeypatch, [(2.0, "smeared mush"), (8.0, "crisp")])

    events = await _collect(
        _event_stream(
            _world_submap_body(
                condition_image_urls=[_region_data_url(), "data:p"],
                condition_roles=["region", "parent"],
            ),
            "t1",
        )
    )

    assert gen.await_count == 2
    cont.assert_not_awaited()
    retry_prompt = gen.await_args_list[1].kwargs["prompt"]
    assert "smeared mush" in retry_prompt
    assert "MORE DETAILED map" in retry_prompt  # still the redraw instruction
    final = next(e for e in events if e["type"] == "final")
    assert final["image_op"] == "map_redraw"
