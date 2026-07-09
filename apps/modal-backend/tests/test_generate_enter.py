"""Integration tests for enter-via-edit: place_scene taps route through the
EDIT endpoint (where the region-crop ref actually bites) instead of the no-op
text-to-image ref path that reinvented every entered place (research/01).

ENTER_EDIT_REF is a default-ON kill-switch: off must be byte-identical to the
old fresh path. The conftest scrubs the flag so host config can't flip these.

generate.py imports `modal` at module level (deploy-only); stub it before import.
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
