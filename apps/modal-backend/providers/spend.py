"""In-process spend accounting — the bill, visible before it arrives.

Honest-coarse estimates mirroring docs/COSTS.md: the fal/OpenRouter image
call is ~99% of the dollars, so each generation records its image calls by
model slug plus one flat increment for the whole VLM stack (planner +
judges + extraction ≈ $0.02 on gemini-flash). Totals live in-process —
per-container, reset on restart — which is the right cheapness for a
self-hosted cap; the limitation is documented in docs/COSTS.md.

`MAX_DAILY_SPEND` (dollars, env) turns the daily total into a hard gate:
generate streams refuse with a clean error frame once today's estimate
crosses it. Absent/0 → no cap (today's behaviour).
"""
from __future__ import annotations

import os
import threading
import time
from collections import OrderedDict

# Slug-prefix → $ per image. Mirrors docs/COSTS.md "The models we call";
# longest prefix wins so "fal-ai/nano-banana-pro/edit" beats "fal-ai/nano-banana".
_IMAGE_PRICES: tuple[tuple[str, float], ...] = (
    ("fal-ai/nano-banana-pro", 0.15),
    ("fal-ai/nano-banana-2", 0.08),
    ("fal-ai/nano-banana", 0.039),
    ("fal-ai/flux-pro/v1/fill", 0.10),
    ("fal-ai/flux-pro/kontext", 0.04),
    ("fal-ai/bria", 0.04),
    ("openrouter:sourceful/riverflow", 0.24),
    ("openai/gpt-image", 0.17),
)
_DEFAULT_IMAGE_PRICE = 0.15  # unknown slug: assume the balanced default
VLM_STACK_FLAT = 0.02  # planner + judges + extraction, per generation

_MAX_SESSIONS = 512  # bounded LRU of per-session totals

_lock = threading.Lock()
_session_totals: OrderedDict[str, float] = OrderedDict()
_daily_total = 0.0
_daily_key = ""  # YYYY-MM-DD the daily total belongs to


def estimate_image(model: str | None) -> float:
    slug = (model or "").strip().lower()
    best: float | None = None
    best_len = -1
    for prefix, price in _IMAGE_PRICES:
        if slug.startswith(prefix) and len(prefix) > best_len:
            best, best_len = price, len(prefix)
    return best if best is not None else _DEFAULT_IMAGE_PRICE


def _today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def record(session_id: str, amount: float) -> float:
    """Add `amount` to the session + daily totals; returns the session total."""
    global _daily_total, _daily_key
    if amount <= 0:
        amount = 0.0
    with _lock:
        day = _today()
        if day != _daily_key:
            _daily_key = day
            _daily_total = 0.0
        _daily_total += amount
        total = _session_totals.get(session_id, 0.0) + amount
        _session_totals[session_id] = total
        _session_totals.move_to_end(session_id)
        while len(_session_totals) > _MAX_SESSIONS:
            _session_totals.popitem(last=False)
        return total


def record_generation(session_id: str, model: str | None, images: int = 1) -> float:
    """One generation: `images` calls on `model` + the flat VLM stack."""
    return record(
        session_id, estimate_image(model) * max(1, images) + VLM_STACK_FLAT
    )


def session_total(session_id: str) -> float:
    with _lock:
        return _session_totals.get(session_id, 0.0)


def daily_total() -> float:
    with _lock:
        return _daily_total if _daily_key == _today() else 0.0


def daily_cap() -> float:
    """The configured cap in dollars; 0 = uncapped."""
    try:
        return max(0.0, float(os.environ.get("MAX_DAILY_SPEND", "") or 0.0))
    except ValueError:
        return 0.0


def cap_exceeded() -> bool:
    cap = daily_cap()
    return cap > 0 and daily_total() >= cap


def reset_for_tests() -> None:
    global _daily_total, _daily_key
    with _lock:
        _session_totals.clear()
        _daily_total = 0.0
        _daily_key = ""
