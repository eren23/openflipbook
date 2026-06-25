"""score_place_match — the medium-AGNOSTIC place judge.

The descent bench compares a generated descent against the REAL child photo.
score_style_pair is medium-confounded: an illustrated descent of a real church
(correct place) scores LOW against a photo purely because illustration != photo.
score_place_match asks the opposite question — SAME place/structure, IGNORE the
medium — so descent recon can measure place fidelity across illustration->photo
chains. This test pins the prompt's medium-agnostic contract + image order
without spending a VLM call (the _ask_judge boundary is stubbed)."""
from __future__ import annotations

import base64
from typing import Any

import pytest

from providers import judge
from providers.judge import JudgeResult


@pytest.mark.asyncio
async def test_score_place_match_is_medium_agnostic_and_passes_both_images(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    async def fake_ask(system: str, user_text: str, image_blocks: list[dict[str, object]]):
        captured["system"] = system
        captured["user_text"] = user_text
        captured["blocks"] = image_blocks
        return JudgeResult(7.0, "same nave", "raw")

    monkeypatch.setattr(judge, "_ask_judge", fake_ask)

    result = await judge.score_place_match(b"REAL-CHILD", b"GENERATED-DESCENT")

    assert result.score == 7.0
    prompt = (captured["system"] + " " + captured["user_text"]).lower()
    # the whole point: explicitly discount medium so a correct illustrated
    # descent of a photographed place is not punished for being an illustration
    assert "ignore" in prompt
    assert any(w in prompt for w in ("medium", "photo", "illustration"))
    assert any(w in prompt for w in ("place", "structure", "layout"))

    # both images travel, real child FIRST then the candidate descent SECOND
    blocks = captured["blocks"]
    assert len(blocks) == 2
    a64 = base64.b64encode(b"REAL-CHILD").decode("ascii")
    b64 = base64.b64encode(b"GENERATED-DESCENT").decode("ascii")
    assert a64 in blocks[0]["image_url"]["url"]
    assert b64 in blocks[1]["image_url"]["url"]
