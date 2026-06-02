"""Integration tests for the expand-outward bloom in generate.py.

Drives the real `_event_stream` async generator end to end with the LLM/image
providers mocked — zero API cost — and asserts the SSE event stream: the
`neighbor` events (shape + scale + count), the terminal `expand_done`,
per-neighbour failure isolation, and that the additive expand branch left the
tap/query `final` path intact.

generate.py imports `modal` at module level (deploy-only, not a test dep), so
we inject a stub before importing it; `_event_stream` itself never touches it.
"""

from __future__ import annotations

import json
import sys
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.modules.setdefault("modal", MagicMock())

import providers.image as image_mod  # noqa: E402
import providers.llm as llm_mod  # noqa: E402
from generate import GenerateBody, _event_stream  # noqa: E402
from providers.image import GeneratedImage  # noqa: E402
from providers.llm import Neighbor, PagePlan  # noqa: E402


async def _collect(agen: Any) -> list[dict[str, Any]]:
    """Drain the SSE async generator into parsed event dicts."""
    events: list[dict[str, Any]] = []
    async for chunk in agen:
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        for block in text.strip().split("\n\n"):
            block = block.strip()
            if block.startswith("data:"):
                events.append(json.loads(block[len("data:") :].strip()))
    return events


def _expand_body(**over: Any) -> GenerateBody:
    base: dict[str, Any] = {
        "query": "how a steam engine works",
        "session_id": "s1",
        "current_node_id": "n0",
        "mode": "expand",
        "image": "data:image/jpeg;base64,abc",
        "parent_title": "Steam Engine",
        "parent_query": "how a steam engine works",
        "web_search": False,
    }
    base.update(over)
    return GenerateBody(**base)


def _mock_providers(
    monkeypatch: pytest.MonkeyPatch,
    *,
    neighbours: list[Neighbor],
    generate_side_effect: Any = None,
) -> None:
    monkeypatch.setattr(
        llm_mod, "propose_neighbors", AsyncMock(return_value=neighbours)
    )
    monkeypatch.setattr(
        llm_mod,
        "plan_page",
        AsyncMock(return_value=PagePlan("A Page", "an illustrated page", [], [])),
    )
    img = GeneratedImage(b"jpegbytes", "image/jpeg", "fal-model", "req-1")
    if generate_side_effect is not None:
        monkeypatch.setattr(
            image_mod, "generate_image", AsyncMock(side_effect=generate_side_effect)
        )
    else:
        monkeypatch.setattr(image_mod, "generate_image", AsyncMock(return_value=img))


async def test_expand_blooms_all_neighbours(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_providers(
        monkeypatch,
        neighbours=[
            Neighbor("The Factory", "container", "houses the boiler"),
            Neighbor("Piston", "peer"),
            Neighbor("Pressure Valve", "component"),
        ],
    )
    events = await _collect(_event_stream(_expand_body(), "trace1"))
    types = [e["type"] for e in events]
    assert types[0] == "status"  # planning
    neighbours = [e for e in events if e["type"] == "neighbor"]
    assert len(neighbours) == 3
    assert {n["subject"] for n in neighbours} == {"The Factory", "Piston", "Pressure Valve"}
    assert {n["scale"] for n in neighbours} == {"container", "peer", "component"}
    assert {n["total"] for n in neighbours} == {3}
    assert events[-1]["type"] == "expand_done"
    assert events[-1]["count"] == 3


async def test_expand_neighbor_event_matches_wire_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The frontend GenerateNeighborEvent type + persistNode depend on exactly
    # these keys — lock them so a backend rename can't silently break the tray.
    _mock_providers(monkeypatch, neighbours=[Neighbor("The Factory", "container")])
    events = await _collect(_event_stream(_expand_body(), "trace1"))
    neighbour = next(e for e in events if e["type"] == "neighbor")
    assert set(neighbour) == {
        "type",
        "subject",
        "scale",
        "page_title",
        "image_data_url",
        "image_model",
        "prompt_author_model",
        "final_prompt",
        "session_id",
        "index",
        "total",
        "trace_id",
    }
    assert neighbour["image_data_url"].startswith("data:image/jpeg;base64,")
    assert neighbour["prompt_author_model"]  # non-empty


async def test_expand_zero_neighbours_emits_done(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_providers(monkeypatch, neighbours=[])
    events = await _collect(_event_stream(_expand_body(), "trace1"))
    assert not [e for e in events if e["type"] == "neighbor"]
    assert events[-1] == {"type": "expand_done", "count": 0, "trace_id": "trace1"}


async def test_expand_isolates_one_neighbour_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Two neighbours; one image-gen throws. The bloom must still emit the other
    # and report the true count — not sink the whole stream.
    good = GeneratedImage(b"jpegbytes", "image/jpeg", "fal-model", "req-1")
    _mock_providers(
        monkeypatch,
        neighbours=[Neighbor("The Factory", "container"), Neighbor("Piston", "peer")],
        generate_side_effect=[RuntimeError("fal boom"), good],
    )
    events = await _collect(_event_stream(_expand_body(), "trace1"))
    neighbours = [e for e in events if e["type"] == "neighbor"]
    assert len(neighbours) == 1
    assert events[-1]["type"] == "expand_done"
    assert events[-1]["count"] == 1


async def test_expand_requires_an_image(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_providers(monkeypatch, neighbours=[Neighbor("X", "peer")])
    events = await _collect(_event_stream(_expand_body(image=None), "trace1"))
    assert events == [
        {"type": "error", "message": "expand mode requires an image", "trace_id": "trace1"}
    ]
    llm_mod.propose_neighbors.assert_not_called()  # type: ignore[attr-defined]


async def test_query_mode_still_emits_final(monkeypatch: pytest.MonkeyPatch) -> None:
    # Regression: the additive expand branch must not disturb the shared
    # tap/query path — a plain query still streams a single `final`.
    monkeypatch.setenv("PROGRESSIVE_DRAFT", "false")
    monkeypatch.setattr(
        llm_mod,
        "plan_page",
        AsyncMock(return_value=PagePlan("Boilers", "a boiler diagram", ["water boils"], [])),
    )
    monkeypatch.setattr(
        image_mod,
        "generate_image",
        AsyncMock(return_value=GeneratedImage(b"jpeg", "image/jpeg", "fal-model", "r")),
    )
    body = GenerateBody(query="how do boilers work", session_id="s1")
    events = await _collect(_event_stream(body, "trace1"))
    finals = [e for e in events if e["type"] == "final"]
    assert len(finals) == 1
    assert finals[0]["page_title"] == "Boilers"
    assert not [e for e in events if e["type"] in ("neighbor", "expand_done")]
