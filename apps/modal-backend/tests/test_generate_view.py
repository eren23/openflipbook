"""Integration tests for the VIEW_GRAMMAR wiring in generate.py.

The deliberate camera resolves user-pin > policy > None and reaches:
the enter instruction (replacing the hardcoded "ground level"), the
composed prompt of fresh map renders (the camera clause, subsuming the
WORLD_TOPDOWN_MAPS lever), and never the classic path. VIEW_GRAMMAR=false is
a STRICT kill-switch: byte-identical to the pre-grammar render.

Uses the test_generate_enter.py harness (stubbed modal + AsyncMock providers).
"""

from __future__ import annotations

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
    base: dict[str, Any] = {
        "query": "a walled harbor city",
        "session_id": "s1",
        "mode": "tap",
        "image": "data:image/jpeg;base64,parent",
        "click": {"x_pct": 0.6, "y_pct": 0.4},
        "web_search": False,
        "render_mode": "place_scene",
        "prefetched_subject": "The Stone Castle",
        "prefetched_subject_context": "a stone fortress with concentric walls",
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
            return_value=PagePlan("The Stone Castle", "an immersive scene", ["The Bailey"], [])
        ),
    )


def _mock_edit(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    edit = AsyncMock(
        return_value=GeneratedImage(b"jpeg", "image/jpeg", "fal-ai/nano-banana-pro/edit", "r1")
    )
    monkeypatch.setattr(image_edit_mod, "edit_image", edit)
    return edit


def _mock_fresh(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    gen = AsyncMock(
        return_value=GeneratedImage(b"jpeg", "image/jpeg", "fal-ai/nano-banana-pro", "r2")
    )
    monkeypatch.setattr(image_mod, "generate_image", gen)
    return gen


async def test_policy_castle_enters_oblique_establishing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # "a castle would go in 2.5" — the word table fires, the instruction names
    # the oblique register and the hardcoded "ground level" is gone.
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)

    await _collect(_event_stream(_tap_body(), "t1"))

    instruction = edit.await_args.args[1]
    assert "high-angle oblique aerial view" in instruction
    assert "rooftops AND the front faces" in instruction
    assert "ground level within it" not in instruction
    assert "(map bearings, not view directions)" in instruction


async def test_kill_switch_is_byte_identical(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # VIEW_GRAMMAR=false must reproduce the EXACT pre-grammar instruction.
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)
    monkeypatch.setenv("VIEW_GRAMMAR", "false")

    await _collect(_event_stream(_tap_body(), "t1"))
    off_instruction = edit.await_args.args[1]

    assert "draw the view from ground level within it" in off_instruction
    assert "oblique" not in off_instruction
    # And it equals the library's legacy builder output verbatim.
    from providers.prompt_library.instructions import _legacy_enter_instruction

    assert off_instruction == _legacy_enter_instruction(
        "The Stone Castle",
        ["The Bailey"],
        style_anchor="hand-drawn engraving, sepia ink",
        subject_context="a stone fortress with concentric walls",
        surroundings="to the north, the striped lighthouse.",
        layout_clause="",
    )


async def test_user_pinned_view_beats_policy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A pinned isometric (the 2.5D pill) wins over the castle policy cell.
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)

    body = _tap_body(
        scene_view={
            "node_id": "n1",
            "level": "building",
            "observer": None,
            "map_crop": None,
            "view": {"projection": "isometric", "pitch_deg": -35.0, "source": "user"},
        }
    )
    await _collect(_event_stream(body, "t1"))

    instruction = edit.await_args.args[1]
    assert "isometric illustration" in instruction
    assert "parallel edges" in instruction
    assert "oblique" not in instruction


async def test_root_map_gets_deliberate_top_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The describe-a-place ROOT arrives as place_submap with NO region crop
    # (V1 blocker 1): the composed prompt must state the flat top-down camera.
    monkeypatch.setenv("WORLD_MODE", "1")
    monkeypatch.setenv("PROGRESSIVE_DRAFT", "false")
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    gen = _mock_fresh(monkeypatch)

    body = GenerateBody(
        query="a walled harbor city",
        session_id="s1",
        mode="query",
        web_search=False,
        world_mode=True,
        render_mode="place_submap",
        session_style_anchor="woodcut",
    )
    await _collect(_event_stream(body, "t1"))

    prompt = gen.await_args.kwargs["prompt"]
    assert "flat top-down plan view" in prompt
    assert "North is at the top of the map." in prompt
    assert "woodcut map" in prompt  # the medium rider names the session medium


async def test_classic_query_untouched(monkeypatch: pytest.MonkeyPatch) -> None:
    # No world mode, no render_mode: zero camera language, legacy bytes.
    monkeypatch.setenv("PROGRESSIVE_DRAFT", "false")
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    gen = _mock_fresh(monkeypatch)

    body = GenerateBody(
        query="how do boilers work", session_id="s1", web_search=False
    )
    await _collect(_event_stream(body, "t1"))

    prompt = gen.await_args.kwargs["prompt"]
    assert "top-down" not in prompt
    assert "camera" not in prompt.lower()


async def test_place_scene_composed_prompt_has_no_camera_clause(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # V1 should-fix 11: on the kill-switch FRESH enter path the composed
    # prompt keeps the legacy exterior→interior preamble uncontradicted — the
    # camera clause never lands on place_scene composed prompts.
    monkeypatch.setenv("ENTER_EDIT_REF", "false")
    monkeypatch.setenv("PROGRESSIVE_DRAFT", "false")
    _mock_plan(monkeypatch)
    _mock_edit(monkeypatch)
    gen = _mock_fresh(monkeypatch)

    await _collect(_event_stream(_tap_body(), "t1"))

    prompt = gen.await_args.kwargs["prompt"]
    assert "Drawn as a high-angle oblique aerial view" not in prompt


async def test_register_mismatch_suppresses_layout_clause(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # expected_layout projected by an eye-level observer + a policy OBLIQUE
    # view: the bins are wrong-camera noise — the instruction must NOT carry
    # the SCENE LAYOUT clause (V1 must-fix 5).
    monkeypatch.setenv("WORLD_GEOMETRY_GEN", "1")
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)

    body = _tap_body(
        scene_view={
            "node_id": "n1",
            "level": "building",
            "observer": {
                "pos": {"x": 0, "y": 0},
                "eye_height": 1.7,
                "gaze": 0,
                "pitch": 0,
                "fov": 1.2,
            },
            "map_crop": None,
        },
        expected_layout=[
            {
                "id": "g1", "label": "The Gate", "x_pct": 0.5, "y_pct": 0.5,
                "w_pct": 0.2, "h_pct": 0.2, "depth": 10,
                "h_pos": "center", "v_pos": "mid", "size": "medium",
            }
        ],
    )
    await _collect(_event_stream(body, "t1"))

    instruction = edit.await_args.args[1]
    assert "high-angle oblique" in instruction  # castle policy still fires
    assert "SCENE LAYOUT" not in instruction  # wrong-camera bins suppressed


async def test_eye_level_enter_keeps_layout_clause(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Same observer-projected bins + an EYE-LEVEL view: registers match, the
    # clause stays (and rides the view-aware instruction).
    monkeypatch.setenv("WORLD_GEOMETRY_GEN", "1")
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)

    body = _tap_body(
        prefetched_subject="The Dusty Tavern",
        prefetched_subject_context="a low-beamed tavern interior",
        scene_view={
            "node_id": "n1",
            "level": "street",
            "observer": {
                "pos": {"x": 0, "y": 0},
                "eye_height": 1.7,
                "gaze": 0,
                "pitch": 0,
                "fov": 1.2,
            },
            "map_crop": None,
        },
        expected_layout=[
            {
                "id": "g1", "label": "The Bar", "x_pct": 0.5, "y_pct": 0.5,
                "w_pct": 0.2, "h_pct": 0.2, "depth": 10,
                "h_pos": "center", "v_pos": "mid", "size": "medium",
            }
        ],
    )
    await _collect(_event_stream(body, "t1"))

    instruction = edit.await_args.args[1]
    assert "eye level" in instruction  # tavern -> interior -> eye_level
    assert "SCENE LAYOUT" in instruction  # matching register: clause kept


async def test_steep_enter_routes_to_steep_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # An interior (eye_level policy) enter must dispatch on the STEEP default
    # (nano-banana-pro/edit since the 2026-07-14 re-bench: 9.0 vs gpt 8.33
    # same-place, no aerial drift, 4x faster; VIEW_LOOP guards every enter)
    # AND speak that family's grammar; an establishing (oblique) enter keeps
    # the enter_scene slot.
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)

    await _collect(
        _event_stream(
            _tap_body(
                prefetched_subject="The Dusty Tavern",
                prefetched_subject_context="a low-beamed tavern interior",
            ),
            "t1",
        )
    )
    assert edit.await_args.kwargs["model_override"] == "fal-ai/nano-banana-pro/edit"
    # The instruction family follows the model: nano grammar anchors on the
    # reference map, not gpt's change-first sentence.
    assert "the overhead map of" in edit.await_args.args[1]

    edit.reset_mock()
    await _collect(_event_stream(_tap_body(), "t1"))  # the castle -> oblique
    from providers import model_router

    assert edit.await_args.kwargs["model_override"] == model_router.resolve_model(
        "enter_scene"
    )


def _mock_judges(
    monkeypatch: pytest.MonkeyPatch,
    conf_side: list[Any],
    same_score: float = 9.0,
) -> tuple[AsyncMock, AsyncMock]:
    import providers.judge as judge_mod
    from providers.judge import JudgeResult

    conf = AsyncMock(
        side_effect=[
            JudgeResult(score=s, rationale=r, raw="") for s, r in conf_side
        ]
    )
    same = AsyncMock(return_value=JudgeResult(score=same_score, rationale="", raw=""))
    detail = AsyncMock(return_value=JudgeResult(score=9.0, rationale="", raw=""))
    medium = AsyncMock(return_value=JudgeResult(score=9.0, rationale="", raw=""))
    monkeypatch.setattr(judge_mod, "score_view_conformance", conf)
    monkeypatch.setattr(judge_mod, "score_continuation", same)
    # Production's same-place axis defaults to the zoom-aware step-in judge
    # (ENTER_STEP_IN_JUDGE) — same mock, same axis.
    monkeypatch.setattr(judge_mod, "score_step_in", same)
    monkeypatch.setattr(judge_mod, "score_feature_articulation", detail)
    monkeypatch.setattr(judge_mod, "score_style_pair", medium)
    return conf, same


def _steep_body(**over: Any) -> GenerateBody:
    # an interior -> the eye_level policy -> the STEEP loop path. The region
    # ref must be a real data URL so the loop's same-place judge engages.
    import base64 as _b64

    region = "data:image/jpeg;base64," + _b64.b64encode(b"REGION").decode()
    return _tap_body(
        prefetched_subject="The Dusty Tavern",
        prefetched_subject_context="a low-beamed tavern interior",
        condition_image_urls=[region, "data:p", "data:s"],
        **over,
    )


async def test_view_loop_retries_with_critic_feedback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Attempt 1 fails the projection check -> exactly one progress frame, a
    # second edit call whose instruction carries the critic's rationale, and
    # the accepted attempt becomes the final image.
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)
    conf, _ = _mock_judges(
        monkeypatch, [(3.0, "looks like a bird's-eye view"), (10.0, "clean")]
    )

    events = await _collect(_event_stream(_steep_body(), "t1"))

    assert edit.await_count == 2
    second_instr = edit.await_args_list[1].args[1]
    assert "looks like a bird's-eye view" in second_instr  # the diagnosis
    assert "failed the projection check" in second_instr
    progress = [e for e in events if e["type"] == "progress"]
    assert len(progress) == 1 and progress[0]["frame_index"] == 0
    assert any(e["type"] == "final" for e in events)
    assert conf.await_count == 2


async def test_view_loop_accept_fast_no_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)
    _mock_judges(monkeypatch, [(9.0, "good")])

    events = await _collect(_event_stream(_steep_body(), "t1"))

    edit.assert_awaited_once()
    assert not [e for e in events if e["type"] == "progress"]


async def test_view_loop_kill_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VIEW_LOOP", "false")
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)
    conf, same = _mock_judges(monkeypatch, [(0.0, "never called")])

    await _collect(_event_stream(_steep_body(), "t1"))

    edit.assert_awaited_once()
    conf.assert_not_awaited()
    same.assert_not_awaited()


async def test_view_loop_judges_aerial_enters_too(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The castle -> oblique: since the Ankh-Morpork drift, EVERY deliberate
    # camera is judged — the loop used to skip aerial registers and an
    # unjudged oblique enter walked off the map. Good scores -> a single
    # attempt and no retry, but the critic DID look.
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)
    conf, _same = _mock_judges(monkeypatch, [(9.0, "a clean oblique")])

    events = await _collect(_event_stream(_tap_body(), "t1"))

    edit.assert_awaited_once()
    assert conf.await_count == 1
    assert not [e for e in events if e["type"] == "progress"]


async def test_view_loop_medium_drift_retries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The Ankh-Morpork regression, pinned: camera fine, place fine — but the
    # ART MEDIUM drifted (loose-ref models treat the style ref as
    # inspiration). The medium critic alone must force the retry, and its
    # rationale must ride the next instruction.
    import providers.judge as judge_mod
    from providers.judge import JudgeResult

    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)
    monkeypatch.setattr(
        judge_mod,
        "score_view_conformance",
        AsyncMock(return_value=JudgeResult(score=9.0, rationale="fine", raw="")),
    )
    monkeypatch.setattr(
        judge_mod,
        "score_continuation",
        AsyncMock(return_value=JudgeResult(score=9.0, rationale="", raw="")),
    )
    monkeypatch.setattr(
        judge_mod,
        "score_step_in",
        AsyncMock(return_value=JudgeResult(score=9.0, rationale="", raw="")),
    )
    monkeypatch.setattr(
        judge_mod,
        "score_feature_articulation",
        AsyncMock(return_value=JudgeResult(score=9.0, rationale="", raw="")),
    )
    monkeypatch.setattr(
        judge_mod,
        "score_style_pair",
        AsyncMock(
            side_effect=[
                JudgeResult(
                    score=2.0,
                    rationale="smoky industrial engraving, not aged parchment",
                    raw="",
                ),
                JudgeResult(score=9.0, rationale="", raw=""),
            ]
        ),
    )

    events = await _collect(_event_stream(_steep_body(), "t1"))

    assert edit.await_count == 2
    second_instr = edit.await_args_list[1].args[1]
    assert "smoky industrial engraving" in second_instr
    assert "ART MEDIUM" in second_instr
    assert any(e["type"] == "final" for e in events)


async def test_view_loop_judge_failure_degrades(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # No critic signal -> single attempt, the final still emits normally
    # (judging can never break generation).
    import providers.judge as judge_mod

    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)
    monkeypatch.setattr(
        judge_mod,
        "score_view_conformance",
        AsyncMock(side_effect=RuntimeError("no key")),
    )

    events = await _collect(_event_stream(_steep_body(), "t1"))

    edit.assert_awaited_once()
    assert any(e["type"] == "final" for e in events)


async def test_view_loop_verify_false_takes_one_shot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The Fast preset's request-level opt-out: verify:false rides the same
    # proven one-shot path as the env kill-switch — per request, no judges.
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)
    conf, same = _mock_judges(monkeypatch, [(0.0, "never called")])

    events = await _collect(_event_stream(_steep_body(verify=False), "t1"))

    edit.assert_awaited_once()
    conf.assert_not_awaited()
    same.assert_not_awaited()
    assert any(e["type"] == "final" for e in events)


def _enter_index_body(idx: int) -> GenerateBody:
    return GenerateBody(
        query="a low-beamed tavern interior",
        session_id="s1",
        render_mode="place_scene",
        world_mode=True,
        scene_view={
            "node_id": "n1",
            "level": "eye",  # → eye_level scene; rotation surfaces as "facing …"
            "observer": None,
            "map_crop": None,
            "enter_index": idx,
        },
    )


def test_azimuth_flag_on_rotates_a_revisit() -> None:
    """ENTER_AZIMUTH_ROTATE=1 + scene_view.enter_index>0 → _view_spec_for stamps
    the rotated azimuth on the scene camera (the another-angle contract)."""
    import os

    from generate import _view_spec_for

    os.environ["ENTER_AZIMUTH_ROTATE"] = "1"
    try:
        spec = _view_spec_for(
            _enter_index_body(1), "place_scene", world_mode=True, has_region=False,
            subject="a tavern", subject_context="interior", place_form="interior",
        )
    finally:
        del os.environ["ENTER_AZIMUTH_ROTATE"]
    assert spec is not None and spec.get("azimuth_deg") == 90.0


def test_azimuth_flag_off_leaves_enter_index_inert() -> None:
    """Flag OFF (default): even with enter_index set, the scene camera carries
    no azimuth — byte-identical to today."""
    from generate import _view_spec_for

    spec = _view_spec_for(
        _enter_index_body(1), "place_scene", world_mode=True, has_region=False,
        subject="a tavern", subject_context="interior", place_form="interior",
    )
    assert spec is not None and "azimuth_deg" not in spec


def test_pinned_view_beats_enter_index_rotation() -> None:
    """A user/persisted camera pin short-circuits policy — so even with the flag
    on and enter_index set, the pinned view is returned verbatim, NOT rotated."""
    import os

    from generate import _view_spec_for

    body = GenerateBody(
        query="q", session_id="s1", render_mode="place_scene", world_mode=True,
        scene_view={
            "node_id": "n1", "level": "eye", "observer": None, "map_crop": None,
            "enter_index": 2,  # would be azimuth 180 if policy ran
            "view": {"projection": "eye_level", "azimuth_deg": 45.0, "source": "user"},
        },
    )
    os.environ["ENTER_AZIMUTH_ROTATE"] = "1"
    try:
        spec = _view_spec_for(
            body, "place_scene", world_mode=True, has_region=False,
            subject="a tavern", subject_context="interior", place_form="interior",
        )
    finally:
        del os.environ["ENTER_AZIMUTH_ROTATE"]
    assert spec is not None
    assert spec["source"] == "user" and spec["azimuth_deg"] == 45.0  # pinned, not 180


async def test_view_loop_per_request_max_attempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # max_attempts:1 -> a rejected first attempt is NOT retried (the env
    # default would); keep-best still finals the rejected image.
    _mock_plan(monkeypatch)
    edit = _mock_edit(monkeypatch)
    _mock_fresh(monkeypatch)
    conf, _ = _mock_judges(monkeypatch, [(3.0, "looks wrong")])

    events = await _collect(_event_stream(_steep_body(max_attempts=1), "t1"))

    edit.assert_awaited_once()
    assert conf.await_count == 1
    assert any(e["type"] == "final" for e in events)
