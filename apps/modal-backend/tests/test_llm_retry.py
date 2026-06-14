"""Free unit test for the LLM transient-error retry (planner timeout fix).

The planner (llm.plan_page -> _complete_json -> chat.completions.create) was
killed by a single APITimeoutError on the Gemini/OpenRouter web-search path.
_create_with_retry backs off and retries transient errors so one flaky upstream
request doesn't fail the whole generation. Mocked — no network, no keys.
"""
from __future__ import annotations

import httpx
import pytest
from openai import APITimeoutError

from providers.llm import _create_with_retry

_REQ = httpx.Request("POST", "https://api.test/chat/completions")


class _FlakyCompletions:
    """chat.completions stand-in: raise APITimeoutError `fail_n` times, then ok."""

    def __init__(self, fail_n: int) -> None:
        self.fail_n = fail_n
        self.calls = 0

    async def create(self, **_kwargs: object) -> str:
        self.calls += 1
        if self.calls <= self.fail_n:
            raise APITimeoutError(request=_REQ)
        return "OK"


class _FakeClient:
    def __init__(self, fail_n: int) -> None:
        self.chat = type("Chat", (), {"completions": _FlakyCompletions(fail_n)})()


@pytest.mark.asyncio
async def test_retries_transient_timeout_then_succeeds() -> None:
    client = _FakeClient(fail_n=2)
    out = await _create_with_retry(client, max_retries=2, base_delay=0, model="m", messages=[])
    assert out == "OK"
    assert client.chat.completions.calls == 3  # 2 failures + 1 success


@pytest.mark.asyncio
async def test_raises_after_exhausting_retries() -> None:
    client = _FakeClient(fail_n=5)
    with pytest.raises(APITimeoutError):
        await _create_with_retry(client, max_retries=2, base_delay=0, model="m", messages=[])
    assert client.chat.completions.calls == 3  # initial + 2 retries, then give up
