"""One POST, one row, never on the hot path unless asked.

    d = await decide("render.accept", state={...}, incumbent={"accept": "yes"})
    accepted = d.yes("accept", accepted)   # the incumbent's answer, unless live and sure

In shadow the call runs as a task beside the pipeline and costs the stream
nothing; the row lands ~400 ms later under the same trace id. Live waits, but
never past DECISION_TIMEOUT_MS, and a dead backend leaves the incumbent's
answer standing. Under MOCK_PROVIDERS the model is a hash-seeded stub, so the
mock stack exercises every seam without a key or a network.
"""
from __future__ import annotations

import asyncio
import contextvars
import hashlib
import json
import os
import time
import uuid
from collections.abc import Callable
from typing import Any, TypeVar

import httpx

from obs import log, span, trace_var
from providers import mock

from . import registry
from .types import DecisionReceipt, DecisionRow, Mode, Question

T = TypeVar("T")

BACKENDS: dict[str, tuple[str | None, str, str]] = {
    # name -> (url, model, key env var). None url = JEV_BASE_URL + /v1/systemone.
    "openrouter": ("https://openrouter.ai/api/alpha/decisions", "typesafe/jev-1.13", "OPENROUTER_API_KEY"),
    "typesafe": ("https://api.typesafe.ai/v1/systemone", "jev-1.13.0", "TYPESAFE_API_KEY"),
    "local": (None, "jev-latest", "OPENJEV_API_KEY"),
}
USD_PER_M_INPUT = 0.042  # hosted jev; output tokens are free

# Shadow tasks started during one request, drained at `final` for receipts.
pending_var: contextvars.ContextVar[list[asyncio.Task[DecisionRow]] | None] = contextvars.ContextVar(
    "of_decisions", default=None
)
_CLIENT: httpx.AsyncClient | None = None
_KEEP: set[asyncio.Task[DecisionRow]] = set()  # fire-and-forget tasks must be referenced or they are collected


def _client() -> httpx.AsyncClient:
    global _CLIENT
    if _CLIENT is None or _CLIENT.is_closed:
        _CLIENT = httpx.AsyncClient(timeout=httpx.Timeout(_timeout_s(), connect=3.0))
    return _CLIENT


def _timeout_s() -> float:
    return max(0.1, registry.env_float("DECISION_TIMEOUT_MS", 800.0) / 1000.0)


def _backend() -> tuple[str, str, str, str | None]:
    name = os.environ.get("DECISION_BACKEND", "openrouter").strip().lower()
    url, model, keyvar = BACKENDS.get(name, BACKENDS["openrouter"])
    if url is None:
        url = os.environ.get("JEV_BASE_URL", "http://127.0.0.1:8000").rstrip("/") + "/v1/systemone"
    return name, url, os.environ.get("DECISION_MODEL", model), os.environ.get(keyvar)


# ---------------------------------------------------------------- answers

def verdict(q: Question, a: dict[str, Any] | None) -> str | None:
    """One comparable string per answer: yes/no, the option, or the level name."""
    if not a:
        return None
    kind = a.get("type") or q.get("type")
    if kind == "noul":
        return "yes" if float(a.get("noul", 0.0)) >= 0.5 else "no"
    if kind == "choice":
        return str(a.get("choice"))
    if kind == "score":
        levels = q.get("criteria") or []
        if not isinstance(levels, list) or not levels:
            return None
        i = max(0, min(len(levels) - 1, round(float(a.get("score", 0.0)))))
        return str(levels[i]).split(": ", 1)[0]
    return None


def top_prob(a: dict[str, Any] | None) -> float:
    if not a:
        return 0.0
    if "noul" in a:
        p = float(a["noul"])
        return max(p, 1.0 - p)
    probs = a.get("probabilities") or {}
    if probs:
        return float(max(probs.values()))
    return float(a.get("confidence", 0.0))


def _stub_answers(site_id: str, state: Any, questions: dict[str, Question]) -> dict[str, Any]:
    """MOCK_PROVIDERS: deterministic, shaped like the real thing, no network."""
    seed = hashlib.sha1(f"{site_id}|{json.dumps(state, sort_keys=True, default=str)}".encode()).digest()
    out: dict[str, Any] = {}
    for i, (key, q) in enumerate(questions.items()):
        h = int.from_bytes(seed[(i * 4) % 16:(i * 4) % 16 + 4], "big")
        if q["type"] == "noul":
            out[key] = {"type": "noul", "noul": round(0.55 + (h % 40) / 100.0, 2) if h % 2 else round(0.45 - (h % 40) / 100.0, 2)}
        elif q["type"] == "choice":
            names = list(q["criteria"])
            pick = names[h % len(names)]
            rest = (1.0 - 0.7) / max(1, len(names) - 1)
            out[key] = {"type": "choice", "choice": pick, "confidence": 0.7,
                        "probabilities": {n: (0.7 if n == pick else rest) for n in names}}
        else:
            levels = q["criteria"]
            idx = h % len(levels)
            out[key] = {"type": "score", "score": float(idx), "confidence": 0.7,
                        "legend": {str(j): lv for j, lv in enumerate(levels)},
                        "probabilities": {str(j): (0.7 if j == idx else 0.3 / max(1, len(levels) - 1)) for j in range(len(levels))}}
    return out


# ---------------------------------------------------------------- the call

def _truncate(state: str | dict[str, Any], limit: int) -> str | dict[str, Any]:
    text = state if isinstance(state, str) else json.dumps(state, ensure_ascii=False, default=str)
    if len(text) <= limit:
        return state
    return text[:limit]


async def _run(site_id: str, state: str | dict[str, Any], incumbent: dict[str, str | None],
               mode: Mode, session_id: str | None) -> DecisionRow:
    site = registry.SITES[site_id]
    backend, url, model, key = _backend()
    row: DecisionRow = {
        "id": uuid.uuid4().hex[:12], "site": site_id, "mode": mode,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "trace_id": trace_var.get(), "session_id": session_id,
        "backend": backend, "model": model, "mock": False,
        "state": _truncate(state, site.state_max_chars), "questions": dict(site.questions),
        "answers": None, "usage": None,
        "verdict": {k: None for k in site.questions}, "incumbent": dict(incumbent),
        "agree": None, "p": {}, "applied": False, "latency_ms": 0, "cost_usd": 0.0, "error": None,
    }
    t0 = time.perf_counter()
    async with span(f"decision.{site_id}", mode=mode) as extra:
        try:
            if not site.questions:
                row["answers"] = {}
            elif mock.on() or not key:
                row["mock"] = True
                row["answers"] = _stub_answers(site_id, row["state"], site.questions)
            else:
                r = await _client().post(
                    url, json={"model": model, "state": row["state"], "questions": row["questions"]},
                    headers={"Authorization": f"Bearer {key}"},
                )
                r.raise_for_status()
                body = r.json()
                row["answers"] = body.get("answers") or None
                row["usage"] = body.get("usage") or None
                row["model"] = str(body.get("model") or model)
                if not row["answers"]:
                    row["error"] = "no answers in response"
        except Exception as exc:  # fail-open on purpose: the incumbent stands
            row["error"] = f"{type(exc).__name__}: {str(exc)[:200]}"
        row["latency_ms"] = int((time.perf_counter() - t0) * 1000)
        answers = row["answers"] or {}
        for k, q in site.questions.items():
            a = answers.get(k)
            row["verdict"][k] = verdict(q, a)
            if a:
                row["p"][k] = round(top_prob(a), 4)
        judged = [k for k in site.questions if row["verdict"][k] is not None and incumbent.get(k) is not None]
        row["agree"] = all(row["verdict"][k] == incumbent[k] for k in judged) if judged else None
        tokens = (row["usage"] or {}).get("input_tokens", 0)
        row["cost_usd"] = 0.0 if row["mock"] or backend == "local" else round(tokens * USD_PER_M_INPUT / 1e6, 8)
        # The ring buffer and the log line carry the receipt, never the state.
        extra.update(
            id=row["id"], verdict=row["verdict"], incumbent=row["incumbent"], agree=row["agree"], p=row["p"],
            latency_ms=row["latency_ms"], cost_usd=row["cost_usd"], error=row["error"], mock=row["mock"],
        )
    log("info", "decision.row", **{k: v for k, v in row.items() if k != "questions"})
    return row


class Decision:
    """What a call site holds: the mode it ran in and, when live, the row."""

    __slots__ = ("mode", "row", "session_id", "site")

    def __init__(self, site: str, mode: Mode, row: DecisionRow | None, session_id: str | None) -> None:
        self.site, self.mode, self.row, self.session_id = site, mode, row, session_id

    def pick(self, question: str, default: T, parse: Callable[[str], T]) -> T:
        """The model's answer in place of `default` -- only live, only above
        the threshold, only in the canary, and never for a spend question."""
        row = self.row
        if self.mode != "live" or row is None or row["error"] or row["verdict"].get(question) is None:
            return default
        site = registry.SITES[self.site]
        if question in site.spend_questions or not registry.in_canary(self.session_id):
            return default
        if row["p"].get(question, 0.0) < registry.threshold(self.site):
            return default
        value = row["verdict"][question]
        assert value is not None
        row["applied"] = True
        return parse(value)

    def yes(self, question: str, default: bool) -> bool:
        return self.pick(question, default, lambda v: v == "yes")


async def decide(site_id: str, *, state: str | dict[str, Any], incumbent: dict[str, str | None],
                 session_id: str | None = None) -> Decision:
    """Shadow: start the task and return at once. Advise/live: wait for the
    row, up to the timeout. Off: nothing, not even a task."""
    mode = registry.mode(site_id)
    if mode == "off":
        return Decision(site_id, mode, None, session_id)
    task = asyncio.create_task(_run(site_id, state, incumbent, mode, session_id))
    _KEEP.add(task)
    task.add_done_callback(_KEEP.discard)
    pending = pending_var.get()
    if pending is not None:
        pending.append(task)
    if mode == "shadow":
        return Decision(site_id, mode, None, session_id)
    try:
        row = await asyncio.wait_for(asyncio.shield(task), timeout=_timeout_s())
    except (TimeoutError, Exception):
        return Decision(site_id, mode, None, session_id)
    return Decision(site_id, mode, row, session_id)


def begin() -> list[asyncio.Task[DecisionRow]]:
    """Bind a fresh pending list to this request's context; call at stream start."""
    pending: list[asyncio.Task[DecisionRow]] = []
    pending_var.set(pending)
    return pending


def receipt(row: DecisionRow) -> DecisionReceipt:
    return {
        "id": row["id"], "site": row["site"], "mode": row["mode"],
        "verdict": row["verdict"], "incumbent": row["incumbent"], "agree": row["agree"], "p": row["p"],
        "applied": row["applied"], "latency_ms": row["latency_ms"], "cost_usd": row["cost_usd"], "error": row["error"],
    }


async def drain(grace_s: float = 0.0) -> list[DecisionReceipt]:
    """Receipts for the rows that have ALREADY landed.

    It waits for nothing by default: this runs just before the `final`
    frame, and a shadow decision that is still in flight must not hold the
    stream open -- turning the layer on would otherwise cost the user the
    very latency shadow mode exists to avoid. Nothing is lost when a row
    misses the frame: the log line is the ledger, and it lands when the row
    does. Tests pass a grace to wait on purpose."""
    pending = pending_var.get()
    if not pending:
        return []
    done, _ = await asyncio.wait(pending, timeout=grace_s)
    out: list[DecisionReceipt] = []
    for task in pending:
        if task in done and not task.cancelled() and task.exception() is None:
            out.append(receipt(task.result()))
    return out
