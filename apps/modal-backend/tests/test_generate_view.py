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


async def test_steep_enter_routes_to_gpt_family(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # An interior (eye_level policy) enter must dispatch on the gpt-family
    # model AND speak its change-first grammar; an establishing (oblique)
    # enter keeps the nano slot.
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
    assert edit.await_args.kwargs["model_override"] == "openai/gpt-image-2/edit"
    assert edit.await_args.args[1].startswith("Change only the camera:")

    edit.reset_mock()
    await _collect(_event_stream(_tap_body(), "t1"))  # the castle -> oblique
    from providers import model_router

    assert edit.await_args.kwargs["model_override"] == model_router.resolve_model(
        "enter_scene"
    )
