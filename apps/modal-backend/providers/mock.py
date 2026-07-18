"""MOCK_PROVIDERS=1 — the zero-key stack.

The OSS-health unlock: a contributor (or CI, or a public demo) can run the
WHOLE app — taps, enters, edits, judges, extraction — without a single API
key. Two seams cover everything:

  - `llm._client()` returns `mock_llm_client()` — one OpenAI-compatible fake
    that routes on the request's system text and answers with deterministic,
    schema-valid JSON (the judges share this client, so they're covered too).
  - the four image provider entry points return `mock_image(...)` — a
    PIL-drawn parchment card, deterministic per (op, prompt), so flows are
    reproducible and visually distinguishable. No binary fixtures in the
    repo; the "fixtures" are drawn at runtime.

Determinism rule: same inputs → same bytes/JSON (hash-seeded), so e2e runs
and snapshot-y assertions are stable. Everything here is best-effort
plausible, not beautiful — it exists so the *plumbing* is exercised.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
from dataclasses import dataclass
from typing import Any

from _env import env_flag

_SUBJECTS = (
    "The Clock Tower",
    "The River Quarter",
    "The Old Market",
    "The Lighthouse",
    "The Guild Hall",
    "The Harbor Gate",
)

_STYLE = "hand-inked map, sepia, fine linework"

# The real click/candidates prompts embed: titled '<T>' (user query: '<Q>').
# (providers/llm/click.py — click_to_subject + precompute_click_candidates
# both use exactly this shape.) GREEDY groups + the literal separators keep
# inner apostrophes intact: "the smith's tavern" must NOT truncate at the
# possessive — a truncated extraction loses the trigger word and silently
# mis-steers e2e specs. Lazy `(.*?)` would stop at the same inner apostrophe;
# greedy is safe because neither classified prompt contains a later "')" for
# the tail group to overshoot to.
_TEMPLATE_RE = re.compile(r"titled '(.*)' \(user query: '(.*)'\)")

_CLASSIFY_RULES: tuple[tuple[tuple[str, ...], tuple[str, str]], ...] = (
    (
        ("tower", "lighthouse", "tavern", "hall", "conservatory", "keep"),
        ("scene", "interior"),
    ),
    (("district", "quarter", "market", "harbor"), ("submap", "complex")),
    (("valley", "coast", "forest", "garden"), ("scene", "landscape")),
)


def _classify(text: str) -> tuple[str, str]:
    """Deterministic (enter_as, place_form) keyed on lowercase substrings, so
    e2e specs steer classification from the OUTSIDE via /play?q=… — the real
    prompts embed parent_query/parent_title, and "tower" in the query makes
    every mock classification scene/interior, "district" submap/complex, etc.

    When the text carries the prompts' embedded `titled '…' (user query:
    '…')` template, ONLY the title+query are matched: the candidates/world-
    mode prompts' static instructions themselves name "a tower, house,
    temple … harbor, market square … valley, coastline, forest" as EXAMPLES
    and would otherwise classify every single request as scene/interior.

    Precedence: title and query are joined ("<title> <query>") and the rule
    ladder runs top-down, first match wins — so an interior word in EITHER
    field beats a district word (title 'X tower' + query 'Y district' →
    scene/interior)."""
    t = text.lower()
    m = _TEMPLATE_RE.search(t)
    if m:
        t = m.group(1) + " " + m.group(2)
    for keys, result in _CLASSIFY_RULES:
        if any(k in t for k in keys):
            return result
    return ("explainer", "")


def on() -> bool:
    return env_flag("MOCK_PROVIDERS")


def _h(*parts: str) -> int:
    return int.from_bytes(
        hashlib.sha1("|".join(parts).encode()).digest()[:4], "big"
    )


# ── Images ─────────────────────────────────────────────────────────────────


@dataclass
class MockImage:
    jpeg_bytes: bytes
    mime_type: str
    model: str
    request_id: str


def mock_image(prompt: str, *, op: str, aspect_ratio: str = "16:9") -> MockImage:
    """A deterministic parchment card: op + prompt snippet as text, plus a
    few hash-placed blocks so different prompts are visibly different."""
    from PIL import Image, ImageDraw

    w, h = (1280, 720) if aspect_ratio != "1:1" else (1024, 1024)
    seed = _h(op, prompt)
    im = Image.new("RGB", (w, h), (240, 235, 221))
    d = ImageDraw.Draw(im)
    d.rectangle((8, 8, w - 9, h - 9), outline=(60, 50, 40), width=4)
    for i in range(4):
        s = _h(op, prompt, str(i))
        x = 40 + (s % (w - 240))
        y = 80 + ((s >> 8) % (h - 260))
        tone = 150 + (s % 70)
        d.rectangle((x, y, x + 120, y + 90), fill=(tone, tone - 20, tone - 50))
    d.text((24, 20), f"MOCK {op}", fill=(60, 50, 40))
    d.text((24, 40), prompt[:110], fill=(90, 75, 60))
    d.text((24, h - 32), f"seed {seed}", fill=(120, 105, 90))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=80)
    return MockImage(buf.getvalue(), "image/jpeg", f"mock/{op}", "mock")


# ── The one fake LLM client ────────────────────────────────────────────────


class _Msg:
    def __init__(self, content: str):
        self.content = content
        self.annotations: list[Any] = []
        self.tool_calls: list[Any] = []


class _Choice:
    def __init__(self, content: str):
        self.message = _Msg(content)
        self.finish_reason = "stop"


class _Usage:
    prompt_tokens = 0
    completion_tokens = 0

    def model_dump(self) -> dict[str, int]:
        return {"prompt_tokens": 0, "completion_tokens": 0}


class _Response:
    def __init__(self, content: str):
        self.choices = [_Choice(content)]
        self.usage = _Usage()
        self.model = "mock/llm"


def _route(system: str, user: str) -> str:
    """Deterministic, schema-valid JSON per request family. Routed on
    distinctive phrases in the system prompt; the tolerant parsers upstream
    make near-misses degrade instead of crash."""
    s = system.lower()
    # Stateless per-request failure switch for e2e: any prompt carrying
    # "mock_error" fails loudly here and propagates through _complete_json
    # into generate.py's stream except-handler — exercising the REAL SSE
    # error path (#153 friendly frames) with zero keys and zero state.
    if "mock_error" in s or "mock_error" in user.lower():
        raise RuntimeError("MOCK_ERROR: forced test failure")
    seed = _h(system[:120], user[:200])
    subject = _SUBJECTS[seed % len(_SUBJECTS)]
    if "content reviewer" in s:
        return json.dumps({"allowed": True, "reason": ""})
    if "score" in s and ("judge" in s or "rate" in s or "0-10" in s or "10" in s):
        return json.dumps({"score": 8.5, "rationale": "mock judge: accepted"})
    # BEFORE the click catch-all: the candidates prompt also contains the word
    # "click(able)", so it used to fall into the click route — the ClickResolution
    # -shaped reply then validated to zero candidates and Wander stopped
    # instantly ("no-candidates"). Match on the prompt's own schema echo.
    if '"candidates"' in s:
        enter_as, place_form = _classify(system)
        spots = (
            (0.30, 0.30, 0.9),
            (0.70, 0.35, 0.8),
            (0.50, 0.70, 0.7),
            (0.25, 0.60, 0.6),
        )
        return json.dumps(
            {
                "candidates": [
                    {
                        "x_pct": x,
                        "y_pct": y,
                        "subject": _SUBJECTS[(seed + i) % len(_SUBJECTS)],
                        "style": _STYLE,
                        "salience": sal,
                        "enter_as": enter_as,
                        "place_form": place_form,
                    }
                    for i, (x, y, sal) in enumerate(spots)
                ]
            }
        )
    # The expand-outward neighbour survey (providers/llm/world.py).
    if "expand outward" in s:
        scales = ("container", "peer", "peer", "component")
        return json.dumps(
            {
                "neighbors": [
                    {
                        "subject": _SUBJECTS[(seed + i) % len(_SUBJECTS)],
                        "scale": scales[i],
                        "note": "a nearby subject in the mock world",
                    }
                    for i in range(4)
                ]
            }
        )
    if "tapped" in s or "crosshair" in s or "click" in s:
        enter_as, place_form = _classify(system)
        payload: dict[str, Any] = {
            "subject": subject,
            "style": _STYLE,
            "subject_context": f"{subject}, a notable place in this scene",
            "groundable": True,
            "confidence": 0.9,
            "enter_as": enter_as,
        }
        # "" is ClickResolution's neutral place_form; omitting the key keeps
        # the default (non-steered) reply byte-identical to the classic mock.
        if place_form:
            payload["place_form"] = place_form
        return json.dumps(payload)
    if "page_title" in s or ("plan" in s and "image" in s):
        return json.dumps(
            {
                "page_title": f"Mock page: {user.strip()[:48] or subject}",
                "prompt": (
                    "A detailed hand-inked illustration of "
                    f"{user.strip()[:80] or subject}, aged parchment, sepia."
                ),
                "facts": ["The North Hall", "The Long Stair"],
            }
        )
    if "entities" in s and ("added" in s or "extract" in s):
        return json.dumps({"added": [], "updated": [], "removed": []})
    if "scene graph" in s or "place_kind" in s:
        return json.dumps(
            {"place_kind": "place", "entities": [], "relations": [], "clarifiers": []}
        )
    if "projection" in s and ("camera" in s or "view" in s):
        return json.dumps(
            {"level": "map", "projection": "top_down", "confidence": 0.9}
        )
    # polish / freeform: echo a usable instruction
    if "json" not in s:
        return user.strip()[:200] or "a quiet scene"
    return "{}"


class _Completions:
    async def create(self, **kwargs: Any) -> _Response:
        messages = kwargs.get("messages") or []
        system = ""
        user_parts: list[str] = []
        for m in messages:
            role = m.get("role")
            content = m.get("content")
            text = ""
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                text = " ".join(
                    str(p.get("text", ""))
                    for p in content
                    if isinstance(p, dict) and p.get("type") == "text"
                )
            if role == "system":
                system += text
            else:
                user_parts.append(text)
        return _Response(_route(system, " ".join(user_parts)))


class _Chat:
    completions = _Completions()


class MockLLMClient:
    chat = _Chat()


_CLIENT: MockLLMClient | None = None


def mock_llm_client() -> MockLLMClient:
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = MockLLMClient()
    return _CLIENT
