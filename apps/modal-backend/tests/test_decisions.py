"""The decision layer's contract: off by default, shadow costs the stream
nothing, live applies only above the bar and never for a spend question,
a dead backend leaves the incumbent standing, and the mock stack never
touches the network."""
from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from providers.decisions import client, registry
from providers.decisions.client import decide, drain, top_prob, verdict


def _log_rows(text: str, span: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for line in text.splitlines():
        if line.startswith("{"):
            rec = json.loads(line)
            if rec.get("span") == span:
                out.append(rec)
    return out


def _mock(monkeypatch: pytest.MonkeyPatch, handler: Any) -> list[httpx.Request]:
    calls: list[httpx.Request] = []

    def wrapped(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        return handler(req)

    monkeypatch.setattr(client, "_CLIENT", httpx.AsyncClient(transport=httpx.MockTransport(wrapped)))
    return calls


def _answers(p: float = 0.91) -> dict[str, Any]:
    return {
        "model": "typesafe/jev-1.13",
        "answers": {
            "accept": {"type": "noul", "noul": p},
            "retry_worth_it": {"type": "noul", "noul": 0.2},
        },
        "usage": {"input_tokens": 480, "output_tokens": 0},
    }


STATE = {"projection": "eye_level", "attempt": 1, "axes": {"conformance": {"score": 9.0, "rationale": "camera as asked"}}}


@pytest.fixture
def shadow(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DECISION_MODE", "shadow")
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(client, "_KEEP", set())


# ---------------------------------------------------------------- off / shadow

async def test_off_by_default_never_builds_a_client(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DECISION_MODE", raising=False)
    monkeypatch.setattr(client.httpx, "AsyncClient", lambda **kw: pytest.fail("no HTTP when off"))
    d = await decide("render.accept", state=STATE, incumbent={"accept": "yes"})
    assert d.mode == "off" and d.row is None
    assert d.yes("accept", True) is True
    assert await drain() == []


async def test_shadow_returns_at_once_and_lands_a_row(shadow: None, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    calls = _mock(monkeypatch, lambda req: httpx.Response(200, json=_answers()))
    client.begin()
    d = await decide("render.accept", state=STATE, incumbent={"accept": "yes", "retry_worth_it": "no"})
    assert d.mode == "shadow" and d.row is None  # nothing awaited on the hot path
    receipts = await drain(grace_s=2.0)
    assert len(receipts) == 1
    r = receipts[0]
    assert r["site"] == "render.accept" and r["verdict"] == {"accept": "yes", "retry_worth_it": "no"}
    assert r["agree"] is True and r["p"]["accept"] == 0.91 and r["applied"] is False
    assert r["error"] is None and r["latency_ms"] >= 0
    assert r["cost_usd"] == pytest.approx(480 * 0.042 / 1e6)
    # The request is the wire contract: model + state + questions, bearer key.
    body = json.loads(calls[0].content)
    assert set(body) == {"model", "state", "questions"} and body["model"] == "typesafe/jev-1.13"
    assert body["questions"]["accept"]["type"] == "noul"
    assert calls[0].headers["authorization"] == "Bearer test-key"
    out = capsys.readouterr().out
    rows = _log_rows(out, "decision.row")
    assert len(rows) == 1 and rows[0]["state"] == STATE and rows[0]["incumbent"]["accept"] == "yes"
    # The span carries the receipt, never the state.
    ends = _log_rows(out, "decision.render.accept.end")
    assert ends and "state" not in ends[0] and ends[0]["agree"] is True


async def test_disagreement_is_recorded(shadow: None, monkeypatch: pytest.MonkeyPatch) -> None:
    _mock(monkeypatch, lambda req: httpx.Response(200, json=_answers(p=0.12)))
    client.begin()
    await decide("render.accept", state=STATE, incumbent={"accept": "yes", "retry_worth_it": "no"})
    [r] = await drain(grace_s=2.0)
    assert r["verdict"]["accept"] == "no" and r["agree"] is False and r["p"]["accept"] == pytest.approx(0.88)


# ---------------------------------------------------------------- fail-open

@pytest.mark.parametrize("handler", [
    lambda req: httpx.Response(500, text="boom"),
    lambda req: (_ for _ in ()).throw(httpx.ReadTimeout("slow")),
    lambda req: httpx.Response(200, json={"answers": {}, "usage": {}}),
])
async def test_backend_failure_leaves_the_incumbent_standing(shadow: None, monkeypatch: pytest.MonkeyPatch, handler: Any) -> None:
    monkeypatch.setenv("DECISION_LIVE", "render.accept")
    _mock(monkeypatch, handler)
    client.begin()
    d = await decide("render.accept", state=STATE, incumbent={"accept": "yes"})
    assert d.mode == "live"
    assert d.yes("accept", True) is True and d.yes("accept", False) is False
    [r] = await drain(grace_s=2.0)
    assert r["error"] and r["agree"] is None and r["verdict"]["accept"] is None and r["applied"] is False


async def test_live_waits_no_longer_than_the_timeout(shadow: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DECISION_LIVE", "render.accept")
    monkeypatch.setenv("DECISION_TIMEOUT_MS", "50")
    gate = asyncio.Event()

    async def slow(req: httpx.Request) -> httpx.Response:
        await gate.wait()
        return httpx.Response(200, json=_answers())

    _mock(monkeypatch, slow)
    d = await decide("render.accept", state=STATE, incumbent={"accept": "yes"})
    assert d.row is None and d.yes("accept", True) is True  # default stood; nothing raised
    gate.set()


# ---------------------------------------------------------------- mock stack

async def test_mock_providers_never_touch_the_network(shadow: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    monkeypatch.setattr(client.httpx, "AsyncClient", lambda **kw: pytest.fail("no HTTP under MOCK_PROVIDERS"))
    monkeypatch.setattr(client, "_CLIENT", None)
    client.begin()
    await decide("click.classify", state={"subject": "a lighthouse"}, incumbent={"enter_as": "scene"})
    [a] = await drain(grace_s=2.0)
    row_a = client.pending_var.get()[0].result()  # type: ignore[index]
    client.begin()
    await decide("click.classify", state={"subject": "a lighthouse"}, incumbent={"enter_as": "scene"})
    [b] = await drain(grace_s=2.0)
    assert row_a["mock"] is True and a["cost_usd"] == 0.0 and a["error"] is None
    assert a["verdict"] == b["verdict"] and a["p"] == b["p"]  # deterministic
    assert set(a["verdict"]) == {"ask_user", "worth_generating", "enter_as"}
    assert a["verdict"]["enter_as"] in {"scene", "submap", "explainer"}


async def test_no_key_falls_back_to_the_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DECISION_MODE", "shadow")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setattr(client.httpx, "AsyncClient", lambda **kw: pytest.fail("no HTTP without a key"))
    monkeypatch.setattr(client, "_CLIENT", None)
    client.begin()
    await decide("render.accept", state=STATE, incumbent={"accept": "yes"})
    [r] = await drain(grace_s=2.0)
    assert r["error"] is None and r["verdict"]["accept"] in {"yes", "no"}


# ---------------------------------------------------------------- live seam

async def test_live_applies_only_above_the_bar_and_never_spend(shadow: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DECISION_LIVE", "render.accept")

    def sure(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"model": "m", "answers": {
            "accept": {"type": "noul", "noul": 0.02},            # no, p 0.98
            "retry_worth_it": {"type": "noul", "noul": 0.99},    # yes, but spend
        }, "usage": {"input_tokens": 1}})

    _mock(monkeypatch, sure)
    d = await decide("render.accept", state=STATE, incumbent={"accept": "yes", "retry_worth_it": "no"})
    assert d.row is not None and d.mode == "live"
    assert d.yes("accept", True) is False and d.row["applied"] is True
    assert d.yes("retry_worth_it", False) is False  # spend question: advise only

    def unsure(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"model": "m", "answers": {"accept": {"type": "noul", "noul": 0.4}}, "usage": {}})

    _mock(monkeypatch, unsure)
    d2 = await decide("render.accept", state=STATE, incumbent={"accept": "yes"})
    assert d2.yes("accept", True) is True and d2.row is not None and d2.row["applied"] is False


async def test_canary_keeps_sessions_outside_the_bucket_on_the_incumbent(shadow: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DECISION_LIVE", "render.accept")
    monkeypatch.setenv("DECISIONS_CANARY", "0.0")
    _mock(monkeypatch, lambda req: httpx.Response(200, json={"model": "m", "answers": {"accept": {"type": "noul", "noul": 0.01}}, "usage": {}}))
    d = await decide("render.accept", state=STATE, incumbent={"accept": "yes"}, session_id="s1")
    assert d.yes("accept", True) is True


async def test_drain_leaves_slow_rows_for_the_log(shadow: None, monkeypatch: pytest.MonkeyPatch) -> None:
    gate = asyncio.Event()

    async def slow(req: httpx.Request) -> httpx.Response:
        await gate.wait()
        return httpx.Response(200, json=_answers())

    _mock(monkeypatch, slow)
    client.begin()
    await decide("render.accept", state=STATE, incumbent={"accept": "yes"})
    assert await drain(grace_s=0.05) == []
    gate.set()
    assert len(await drain(grace_s=2.0)) == 1


async def test_state_is_capped(shadow: None, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _mock(monkeypatch, lambda req: httpx.Response(200, json=_answers()))
    client.begin()
    await decide("render.accept", state={"blob": "x" * 20000}, incumbent={"accept": "yes"})
    await drain(grace_s=2.0)
    sent = json.loads(calls[0].content)["state"]
    assert isinstance(sent, str) and len(sent) == registry.SITES["render.accept"].state_max_chars


# ---------------------------------------------------------------- answers

def test_verdict_and_top_prob_shapes() -> None:
    assert verdict({"type": "noul"}, {"type": "noul", "noul": 0.5}) == "yes"
    assert verdict({"type": "noul"}, {"type": "noul", "noul": 0.49}) == "no"
    assert top_prob({"noul": 0.2}) == pytest.approx(0.8)
    choice = {"type": "choice", "choice": "submap", "probabilities": {"scene": 0.3, "submap": 0.6, "explainer": 0.1}, "confidence": 0.6}
    assert verdict({"type": "choice"}, choice) == "submap" and top_prob(choice) == pytest.approx(0.6)
    score_q = {"type": "score", "criteria": ["low: a", "mid: b", "high: c"]}
    assert verdict(score_q, {"type": "score", "score": 1.6}) == "high"
    assert verdict(score_q, {"type": "score", "score": 0.4}) == "low"
    assert verdict({"type": "noul"}, None) is None and top_prob(None) == 0.0


# ---------------------------------------------------------------- registry

def test_mode_resolution(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DECISION_MODE", raising=False)
    assert registry.mode("render.accept") == "off"
    monkeypatch.setenv("DECISION_MODE", "shadow")
    assert registry.mode("render.accept") == "shadow"
    assert registry.mode("no.such.site") == "off"
    monkeypatch.setenv("DECISION_LIVE", "render.accept, click.classify")
    assert registry.mode("render.accept") == "live"
    assert registry.mode("click.classify") == "advise"  # capped by the site
    assert registry.mode("zoom.accept") == "shadow"
    monkeypatch.setenv("DECISION_MODE", "garbage")
    assert registry.mode("render.accept") == "off"


def test_threshold_and_params_honour_legacy_env(monkeypatch: pytest.MonkeyPatch) -> None:
    assert registry.threshold("render.accept") == 0.7
    monkeypatch.setenv("DECISION_THRESHOLD_RENDER_ACCEPT", "0.9")
    assert registry.threshold("render.accept") == 0.9
    assert registry.param("render.accept", "accept_conformance") == 7.0
    monkeypatch.setenv("VIEW_LOOP_ACCEPT_CONFORMANCE", "8.5")
    assert registry.param("render.accept", "accept_conformance") == 8.5
    monkeypatch.setenv("VIEW_LOOP_ACCEPT_CONFORMANCE", "seven")
    assert registry.param("render.accept", "accept_conformance") == 7.0
    assert registry.env_float("NOT_SET_ANYWHERE", 1.5) == 1.5


def test_canary_buckets_by_session(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DECISIONS_CANARY", raising=False)
    assert registry.in_canary("any") is True
    monkeypatch.setenv("DECISIONS_CANARY", "0.0")
    assert registry.in_canary("any") is False and registry.in_canary(None) is True
    monkeypatch.setenv("DECISIONS_CANARY", "0.5")
    hits = sum(registry.in_canary(f"session-{i}") for i in range(400))
    assert 140 < hits < 260  # about half, deterministic per id


def test_no_question_mentions_a_floor() -> None:
    # The echo guard: the model must read scores and sentences, not thresholds.
    for site in registry.SITES.values():
        for q in site.questions.values():
            text = json.dumps(q)
            assert "floor" not in text.lower() and "at least 7" not in text and ">= 6" not in text
