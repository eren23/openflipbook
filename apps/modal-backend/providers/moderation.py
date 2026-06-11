"""MODERATE_PROMPTS=1 — one cheap LLM check on the composed image prompt
before any image dollars are spent. Off (the default) -> no call, no change.

Fail-open by design: a moderation-infra hiccup must never brick generation
for a self-hoster — a parse failure or client error logs and allows. The
check rides the existing llm client (so MOCK_PROVIDERS covers it too).
"""
from __future__ import annotations

import contextlib
from typing import Any

from _env import env_flag

_SYSTEM = (
    "You are a content reviewer for an image-generation prompt. Reply as "
    'JSON: {"allowed": true|false, "reason": "<short>"}. Disallow only '
    "clearly prohibited visual content (sexual content involving minors, "
    "gratuitous real-person sexual imagery, instructions for serious harm); "
    "fantasy violence, maps, machinery and ordinary scenes are all allowed."
)


async def flagged(text: str) -> tuple[bool, str]:
    """(blocked, reason). Always (False, "") when the flag is off."""
    if not env_flag("MODERATE_PROMPTS"):
        return (False, "")
    from obs import log
    from providers import llm

    try:
        client = llm._client()
        resp: Any = await client.chat.completions.create(
            model=llm._vlm_model(),
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": text[:4000]},
            ],
            response_format={"type": "json_object"},
        )
        raw = resp.choices[0].message.content or "{}"
        parsed = llm._safe_json(raw)
        allowed = parsed.get("allowed")
        if allowed is False:
            reason = str(parsed.get("reason", ""))[:200] or "blocked by moderation"
            log("warn", "moderation.blocked", reason=reason)
            return (True, reason)
        return (False, "")
    except Exception as exc:  # fail-open: never brick generation
        with contextlib.suppress(Exception):
            log("warn", "moderation.degraded", error=f"{type(exc).__name__}: {exc}")
        return (False, "")
