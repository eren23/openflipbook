"""Wave 5: SHARED_TOKEN gate, per-IP rate limit, MODERATE_PROMPTS hook —
all default OFF (the self-host posture), each proven both ways."""
from __future__ import annotations

import json
import sys
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.modules.setdefault("modal", MagicMock())

from fastapi.testclient import TestClient  # noqa: E402

import providers.image as image_mod  # noqa: E402
import providers.llm as llm_mod  # noqa: E402
from generate import GenerateBody, _event_stream, fastapi_app  # noqa: E402
from providers import moderation, ratelimit  # noqa: E402
from providers.image import GeneratedImage  # noqa: E402
from providers.llm import PagePlan  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh(monkeypatch: pytest.MonkeyPatch):
    ratelimit.reset_for_tests()
    for var in ("SHARED_TOKEN", "RATE_LIMIT_RPM", "MODERATE_PROMPTS"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("PROGRESSIVE_DRAFT", "false")
    yield
    ratelimit.reset_for_tests()


# ── SHARED_TOKEN ────────────────────────────────────────────────────────────


def test_token_unset_everything_open() -> None:
    client = TestClient(fastapi_app)
    assert client.get("/models").status_code == 200


def test_token_set_gates_everything_but_health(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SHARED_TOKEN", "s3cret")
    client = TestClient(fastapi_app)
    assert client.get("/health").status_code == 200  # probes stay open
    assert client.get("/models").status_code == 401
    ok = client.get("/models", headers={"x-openflipbook-token": "s3cret"})
    assert ok.status_code == 200
    wrong = client.get("/models", headers={"x-openflipbook-token": "nope"})
    assert wrong.status_code == 401


# ── Rate limit ──────────────────────────────────────────────────────────────


def test_ratelimit_off_by_default() -> None:
    for _ in range(50):
        assert ratelimit.allow("1.2.3.4")


def test_ratelimit_bucket_drains_and_isolates_ips(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RATE_LIMIT_RPM", "4")  # capacity = max(2, 1) = 2
    assert ratelimit.allow("a")
    assert ratelimit.allow("a")
    assert not ratelimit.allow("a")  # bucket drained
    assert ratelimit.allow("b")  # other IPs unaffected


def test_sse_generate_429s_when_drained(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RATE_LIMIT_RPM", "4")
    client = TestClient(fastapi_app)
    # empty body: the gate sits BEFORE validation, so the first two get 400
    # (pydantic), the third gets 429 (drained bucket).
    codes = [
        client.post("/sse/generate", json={}).status_code for _ in range(3)
    ]
    assert codes == [400, 400, 429]


# ── Moderation ──────────────────────────────────────────────────────────────


class _FakeChat:
    def __init__(self, payload: dict[str, Any]):
        self._payload = payload

    async def create(self, **kwargs: Any) -> Any:
        msg = MagicMock()
        msg.content = json.dumps(self._payload)
        choice = MagicMock()
        choice.message = msg
        resp = MagicMock()
        resp.choices = [choice]
        return resp


def _fake_client(payload: dict[str, Any]) -> Any:
    client = MagicMock()
    client.chat.completions = _FakeChat(payload)
    return client


async def test_moderation_off_means_no_call(monkeypatch: pytest.MonkeyPatch) -> None:
    called = MagicMock()
    monkeypatch.setattr(llm_mod, "_client", called)
    assert await moderation.flagged("anything") == (False, "")
    called.assert_not_called()


async def test_moderation_blocks_and_allows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MODERATE_PROMPTS", "1")
    monkeypatch.setattr(
        llm_mod, "_client", lambda: _fake_client({"allowed": False, "reason": "nope"})
    )
    assert await moderation.flagged("bad thing") == (True, "nope")
    monkeypatch.setattr(
        llm_mod, "_client", lambda: _fake_client({"allowed": True, "reason": ""})
    )
    assert await moderation.flagged("fine thing") == (False, "")


async def test_moderation_fails_open(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MODERATE_PROMPTS", "1")

    def boom() -> Any:
        raise RuntimeError("moderation infra down")

    monkeypatch.setattr(llm_mod, "_client", boom)
    assert await moderation.flagged("anything") == (False, "")


async def test_moderation_block_without_reason_gets_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MODERATE_PROMPTS", "1")
    monkeypatch.setattr(llm_mod, "_client", lambda: _fake_client({"allowed": False}))
    assert await moderation.flagged("bad thing") == (True, "blocked by moderation")


async def _collect(agen: Any) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    async for chunk in agen:
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        for block in text.strip().split("\n\n"):
            block = block.strip()
            if block.startswith("data:"):
                events.append(json.loads(block[len("data:") :].strip()))
    return events


async def test_blocked_prompt_yields_clean_error_frame(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        llm_mod,
        "plan_page",
        AsyncMock(return_value=PagePlan("T", "a scene", [], [])),
    )
    gen = AsyncMock(
        return_value=GeneratedImage(b"jpeg", "image/jpeg", "fal-ai/nano-banana-pro", "r")
    )
    monkeypatch.setattr(image_mod, "generate_image", gen)
    from providers import moderation as moderation_mod

    monkeypatch.setattr(
        moderation_mod, "flagged", AsyncMock(return_value=(True, "test block"))
    )

    events = await _collect(
        _event_stream(
            GenerateBody(query="x", session_id="s1", web_search=False), "t1"
        )
    )
    assert any(
        e["type"] == "error" and "Blocked by moderation" in e["message"]
        for e in events
    )
    gen.assert_not_awaited()


def test_moderate_text_endpoint_allows_when_off() -> None:
    client = TestClient(fastapi_app)
    res = client.post("/moderate-text", json={"text": "a quiet harbor"})
    assert res.status_code == 200
    assert res.json() == {"allowed": True, "reason": ""}


def test_moderate_text_endpoint_blocks(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MODERATE_PROMPTS", "1")
    monkeypatch.setattr(
        llm_mod, "_client", lambda: _fake_client({"allowed": False, "reason": "nope"})
    )
    client = TestClient(fastapi_app)
    res = client.post("/moderate-text", json={"text": "bad"})
    assert res.json() == {"allowed": False, "reason": "nope"}
