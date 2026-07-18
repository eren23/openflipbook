"""MOCK_PROVIDERS=1 — the zero-key stack, proven end-to-end.

NOTHING is monkeypatched here: the stream runs through the real generate.py
pipeline, the real provider modules, the real parsers — only the two mock
seams (the fake LLM client + the PIL image cards) stand in for the network.
If these pass with no keys in the environment, a contributor's first clone
works.
"""
from __future__ import annotations

import base64
import io
import json
import sys
from typing import Any
from unittest.mock import MagicMock

import pytest
from PIL import Image

sys.modules.setdefault("modal", MagicMock())

from generate import GenerateBody, _event_stream  # noqa: E402
from providers import mock, spend  # noqa: E402


@pytest.fixture(autouse=True)
def _mock_mode(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    monkeypatch.delenv("FAL_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("PROGRESSIVE_DRAFT", "false")
    spend.reset_for_tests()
    yield
    spend.reset_for_tests()


async def _collect(agen: Any) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    async for chunk in agen:
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        for block in text.strip().split("\n\n"):
            block = block.strip()
            if block.startswith("data:"):
                events.append(json.loads(block[len("data:") :].strip()))
    return events


def _decodable_jpeg(data_url: str) -> bool:
    assert data_url.startswith("data:image/jpeg;base64,")
    raw = base64.b64decode(data_url.split(",", 1)[1])
    Image.open(io.BytesIO(raw)).verify()
    return True


async def test_query_stream_end_to_end_with_zero_keys() -> None:
    events = await _collect(
        _event_stream(
            GenerateBody(query="a small harbor town", session_id="s1", web_search=False),
            "t1",
        )
    )
    final = next(e for e in events if e["type"] == "final")
    assert _decodable_jpeg(final["image_data_url"])
    assert final["image_model"] == "mock/fresh"
    assert final["page_title"].startswith("Mock page:")
    assert final["session_spend_estimate"] > 0  # the meter runs on mocks too


async def test_tap_stream_resolves_and_renders() -> None:
    seed = await _collect(
        _event_stream(
            GenerateBody(query="a small harbor town", session_id="s2", web_search=False),
            "t1",
        )
    )
    parent = next(e for e in seed if e["type"] == "final")
    events = await _collect(
        _event_stream(
            GenerateBody(
                query="a small harbor town",
                session_id="s2",
                mode="tap",
                web_search=False,
                image=parent["image_data_url"],
                click={"x_pct": 0.5, "y_pct": 0.5},
            ),
            "t2",
        )
    )
    resolved = next(e for e in events if e.get("stage") == "click_resolved")
    assert resolved["subject"]  # the mock client routed the click prompt
    final = next(e for e in events if e["type"] == "final")
    assert _decodable_jpeg(final["image_data_url"])


async def test_mock_determinism() -> None:
    a = mock.mock_image("the same prompt", op="fresh")
    b = mock.mock_image("the same prompt", op="fresh")
    c = mock.mock_image("a different prompt", op="fresh")
    assert a.jpeg_bytes == b.jpeg_bytes
    assert a.jpeg_bytes != c.jpeg_bytes


# ── World/interior routes: the candidates + neighbors prompts through the
# REAL provider functions (parsers and validators run for real; only the model
# reply is canned), steered via the query the prompts embed. ────────────────

_IMG = "data:image/jpeg;base64,AAAA"  # never decoded — the mock ignores images


async def test_candidates_route_validates_and_steers() -> None:
    from providers.llm.click import precompute_click_candidates

    tower = await precompute_click_candidates(_IMG, "A Tall Tower", "a tall stone tower")
    assert 3 <= len(tower) <= 4
    assert all(0.0 <= c.x_pct <= 1.0 and 0.0 <= c.y_pct <= 1.0 for c in tower)
    saliences = [c.salience for c in tower]
    assert saliences == sorted(saliences, reverse=True)
    assert all(c.subject and c.style for c in tower)
    assert tower[0].enter_as == "scene"
    assert tower[0].place_form == "interior"

    district = await precompute_click_candidates(
        _IMG, "The Merchant District", "the merchant district"
    )
    assert district[0].enter_as == "submap"
    assert district[0].place_form == "complex"


async def test_neighbors_route_via_real_propose() -> None:
    from providers.llm.world import propose_neighbors

    out = await propose_neighbors(_IMG, "The Old Keep", "the old keep")
    assert len(out) == 4
    assert all(n.subject for n in out)
    assert len({n.subject.lower() for n in out}) == 4  # _build_neighbors dedupes
    assert all(n.scale in ("component", "peer", "container") for n in out)


async def test_world_routes_deterministic() -> None:
    from providers.llm.click import precompute_click_candidates
    from providers.llm.world import propose_neighbors

    a = await precompute_click_candidates(_IMG, "A Tall Tower", "a tall stone tower")
    b = await precompute_click_candidates(_IMG, "A Tall Tower", "a tall stone tower")
    assert a == b
    n1 = await propose_neighbors(_IMG, "The Old Keep", "the old keep")
    n2 = await propose_neighbors(_IMG, "The Old Keep", "the old keep")
    assert n1 == n2


def test_classifier_matrix() -> None:
    assert mock._classify("The Clock Tower") == ("scene", "interior")
    assert mock._classify("a smoky tavern by the docks") == ("scene", "interior")
    assert mock._classify("a market district") == ("submap", "complex")
    assert mock._classify("the harbor gate") == ("submap", "complex")
    assert mock._classify("a wooded valley") == ("scene", "landscape")
    assert mock._classify("the palace garden") == ("scene", "landscape")
    assert mock._classify("photosynthesis") == ("explainer", "")
    # Embedded-quote narrowing: the real prompts' STATIC text names tower /
    # harbor / forest as examples — only the quoted title/query may steer.
    assert mock._classify(
        "page titled 'Photosynthesis' (user query: 'how leaves work'). "
        "Examples: a tower, a harbor, a forest."
    ) == ("explainer", "")


def test_click_route_default_stays_byte_identical() -> None:
    system = (
        "You examine a generated illustration of the page titled 'Photosynthesis' "
        "(user query: 'how leaves work'). A red crosshair marks the click."
    )
    user = "Look at the red crosshair marker on the image."
    subject = mock._SUBJECTS[mock._h(system[:120], user[:200]) % len(mock._SUBJECTS)]
    # The exact pre-world reply: enter_as explainer, NO place_form key.
    assert mock._route(system, user) == json.dumps(
        {
            "subject": subject,
            "style": "hand-inked map, sepia, fine linework",
            "subject_context": f"{subject}, a notable place in this scene",
            "groundable": True,
            "confidence": 0.9,
            "enter_as": "explainer",
        }
    )


async def test_click_route_steers_enter_as_and_place_form() -> None:
    from providers.llm.click import click_to_subject

    res = await click_to_subject(
        _IMG, 0.5, 0.5, parent_title="A Tall Tower", parent_query="a tall stone tower"
    )
    assert res.enter_as == "scene"
    assert res.place_form == "interior"


async def test_mock_error_lever_raises() -> None:
    with pytest.raises(RuntimeError, match="MOCK_ERROR"):
        await mock.mock_llm_client().chat.completions.create(
            messages=[{"role": "user", "content": "please mock_error now"}]
        )


async def test_mock_error_reaches_sse_error_frame() -> None:
    """The lever's whole point: the forced failure propagates through
    _complete_json into generate.py's except-handler and comes out as the
    REAL friendly SSE error frame (#153)."""
    events = await _collect(
        _event_stream(
            GenerateBody(query="mock_error town", session_id="s-err", web_search=False),
            "t-err",
        )
    )
    err = next(e for e in events if e["type"] == "error")
    assert "MOCK_ERROR" in err.get("detail", "")
