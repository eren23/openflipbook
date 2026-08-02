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
import io
from typing import Any

import pytest

from providers import judge
from providers.judge import JudgeResult


def _striped_jpeg(width: int, height: int, *, quality: int = 95) -> bytes:
    Image = pytest.importorskip("PIL.Image")
    ImageDraw = pytest.importorskip("PIL.ImageDraw")

    im = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(im)
    for x in range(0, width, 12):
        color = ((x * 17) % 255, (x * 31) % 255, (x * 47) % 255)
        draw.rectangle((x, 0, min(width, x + 6), height), fill=color)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def test_image_block_bounds_large_judge_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    Image = pytest.importorskip("PIL.Image")
    monkeypatch.setenv("VLM_JUDGE_MAX_SIDE_PX", "256")
    monkeypatch.setenv("VLM_JUDGE_JPEG_QUALITY", "70")
    raw = _striped_jpeg(1200, 800)

    block = judge._image_block(raw)

    image_url = block["image_url"]
    assert isinstance(image_url, dict)
    url = str(image_url["url"])
    compact = base64.b64decode(url.split(",", 1)[1])
    assert len(compact) < len(raw)
    with Image.open(io.BytesIO(compact)) as im:
        assert max(im.size) <= 256


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


@pytest.mark.asyncio
async def test_score_map_legibility_is_single_image_craft_judge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The zoom gate's second axis: single-image (the arrival only), and the
    # prompt must pin the contract — crisp fine detail high, blurry upscale
    # mush low, lettering legibility in scope.
    captured: dict[str, Any] = {}

    async def fake_ask(system: str, user_text: str, image_blocks: list[dict[str, object]]):
        captured["system"] = system
        captured["user_text"] = user_text
        captured["blocks"] = image_blocks
        return JudgeResult(2.0, "smeared texture", "raw")

    monkeypatch.setattr(judge, "_ask_judge", fake_ask)

    result = await judge.score_map_legibility(b"ARRIVAL")

    assert result.score == 2.0
    prompt = (captured["system"] + " " + captured["user_text"]).lower()
    assert "crisp" in prompt
    assert "blurry" in prompt and "mush" in prompt
    assert "legible" in prompt or "illegible" in prompt
    assert "0-10" in captured["system"]

    # exactly ONE image travels: the arrival
    blocks = captured["blocks"]
    assert len(blocks) == 1
    assert base64.b64encode(b"ARRIVAL").decode("ascii") in blocks[0]["image_url"]["url"]


# --- _parse_judgement robustness (the silent-zero bug, pure) ---------------
#
# gemini-3-flash (the default judge) prepends a "thought" reasoning preamble on
# hard comparisons; max_tokens then truncates the JSON before the score. The old
# parser defaulted a truncated/absent score to 0.0 — reading as "totally unlike"
# and corrupting every recon/descent cell it touched. Fixes: a legit 0 stays 0,
# a truncated reply is marked UNPARSEABLE (loud, not a silent real 0), and a
# reasoning-preambled-then-JSON reply is salvaged.


def test_parse_clean_json() -> None:
    r = judge._parse_judgement('{"score": 8, "rationale": "same tower"}')
    assert r.score == 8.0 and r.rationale == "same tower"


def test_parse_legit_zero_is_preserved() -> None:
    # A real "unrelated place" 0 must survive — not be confused with a failure.
    r = judge._parse_judgement('{"score": 0, "rationale": "unrelated"}')
    assert r.score == 0.0
    assert r.rationale == "unrelated"
    assert "UNPARSEABLE" not in r.rationale


def test_parse_truncated_thought_is_loud_not_silent_zero() -> None:
    # The exact wild failure: reasoning preamble + JSON cut off before the number.
    r = judge._parse_judgement('thought\n{"score":')
    assert r.score == 0.0  # can't recover a score
    assert r.rationale.startswith("UNPARSEABLE")  # but it says so, loudly


def test_parse_salvages_reasoning_preamble_then_json() -> None:
    # A preamble followed by a COMPLETE json object → salvage recovers the score.
    r = judge._parse_judgement('Let me think. The dome matches.\n{"score": 9, "rationale": "dome"}')
    assert r.score == 9.0


# --- _ask_judge retries a transient EMPTY / unparseable response --------------
#
# _create_with_retry only retries API-level errors; a 200 with empty content
# parses to a loud UNPARSEABLE score-0 without raising, so every caller (the
# view-loop AND the paid benches) used to bank a transient blank reply as a real
# 0. _ask_judge now re-issues the call when the reply can't be parsed.


class _FakeMessage:
    def __init__(self, content: str) -> None:
        self.content = content


class _FakeChoice:
    def __init__(self, content: str) -> None:
        self.message = _FakeMessage(content)


class _FakeResponse:
    def __init__(self, content: str) -> None:
        self.choices = [_FakeChoice(content)]


def _stub_replies(monkeypatch: pytest.MonkeyPatch, replies: list[str]) -> dict[str, int]:
    from providers import llm

    calls = {"n": 0}

    async def _fake_create(_client: Any, **_kw: Any) -> _FakeResponse:
        content = replies[min(calls["n"], len(replies) - 1)]
        calls["n"] += 1
        return _FakeResponse(content)

    monkeypatch.setattr(llm, "_client", lambda: object())
    monkeypatch.setattr(llm, "_create_with_retry", _fake_create)
    return calls


@pytest.mark.asyncio
async def test_ask_judge_retries_empty_then_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    # First call returns an empty body (the observed transient), second is valid.
    calls = _stub_replies(monkeypatch, ["", '{"score": 7, "rationale": "match"}'])

    r = await judge._ask_judge("sys", "user", [])

    assert calls["n"] == 2  # retried the blank reply
    assert r.score == 7.0
    assert "UNPARSEABLE" not in r.rationale


@pytest.mark.asyncio
async def test_ask_judge_gives_up_loudly_after_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    # Persistent empty replies → bounded retries, then the loud UNPARSEABLE 0.
    monkeypatch.setenv("VLM_JUDGE_EMPTY_RETRIES", "2")
    calls = _stub_replies(monkeypatch, [""])

    r = await judge._ask_judge("sys", "user", [])

    assert calls["n"] == 2  # capped, not infinite
    assert r.score == 0.0
    assert r.rationale.startswith("UNPARSEABLE")


@pytest.mark.asyncio
async def test_ask_judge_does_not_retry_a_legit_score(monkeypatch: pytest.MonkeyPatch) -> None:
    # A valid reply (incl. a legit 0) must not burn extra calls.
    calls = _stub_replies(monkeypatch, ['{"score": 0, "rationale": "unrelated"}'])

    r = await judge._ask_judge("sys", "user", [])

    assert calls["n"] == 1
    assert r.score == 0.0 and "UNPARSEABLE" not in r.rationale
