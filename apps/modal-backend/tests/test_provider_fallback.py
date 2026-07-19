"""Wave 4: capability registry, fallback chains, the circuit breaker, and
the failover path in image.generate_image (slug dispatch monkeypatched)."""
from __future__ import annotations

import pytest

from providers import breaker, image, model_router
from providers.image import GeneratedImage


@pytest.fixture(autouse=True)
def _fresh(monkeypatch: pytest.MonkeyPatch):
    breaker.reset_for_tests()
    monkeypatch.delenv("PROVIDER_FALLBACK", raising=False)
    monkeypatch.setenv("FAL_KEY", "test")  # dispatch is mocked; key gate is upstream
    yield
    breaker.reset_for_tests()


def test_registry_shape() -> None:
    rows = model_router.registry()
    assert any(r["slug"] == "fal-ai/nano-banana-pro" for r in rows)
    sample = rows[0]
    for key in ("slug", "label", "supports_edit", "est_cost", "est_latency_s"):
        assert key in sample


def test_fallback_chain_steps_down_in_cost() -> None:
    chain = model_router.fallback_chain("openrouter:sourceful/riverflow-v2.5-pro")
    assert chain == ("fal-ai/nano-banana-pro", "fal-ai/nano-banana")
    assert model_router.fallback_chain("fal-ai/flux-pro/kontext") == ()
    # never include the slug itself
    assert "fal-ai/nano-banana" not in model_router.fallback_chain("fal-ai/nano-banana")[:0]


def test_breaker_opens_after_threshold_and_recovers() -> None:
    slug = "fal-ai/nano-banana-pro"
    assert breaker.available(slug)
    for _ in range(breaker.FAILURE_THRESHOLD):
        breaker.record_failure(slug)
    assert not breaker.available(slug)
    breaker.record_success(slug)  # success closes the circuit
    assert breaker.available(slug)


def test_breaker_cooldown_expiry_half_open_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    """After COOLDOWN_S the circuit half-opens: one probe is allowed, a probe
    failure re-opens immediately (count stays >= threshold), a probe success
    closes fully."""
    slug = "fal-ai/nano-banana-pro"
    clock = [1000.0]
    monkeypatch.setattr(breaker.time, "monotonic", lambda: clock[0])

    for _ in range(breaker.FAILURE_THRESHOLD):
        breaker.record_failure(slug)
    clock[0] += breaker.COOLDOWN_S - 1
    assert not breaker.available(slug)  # still cooling
    clock[0] += 2
    assert breaker.available(slug)  # cooldown over -> probe allowed

    breaker.record_failure(slug)  # failed probe re-opens on the spot
    assert not breaker.available(slug)

    clock[0] += breaker.COOLDOWN_S + 1
    assert breaker.available(slug)
    breaker.record_success(slug)  # good probe closes and clears the count
    breaker.record_failure(slug)  # so one fresh failure stays sub-threshold
    assert breaker.available(slug)


def _img(model: str) -> GeneratedImage:
    return GeneratedImage(b"jpeg", "image/jpeg", model, None)


async def test_fallback_off_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    async def boom(model, prompt, aspect, refs):
        calls.append(model)
        raise RuntimeError("provider down")

    monkeypatch.setattr(image, "_generate_with_slug", boom)
    with pytest.raises(RuntimeError):
        await image.generate_image("p", "16:9", tier="balanced")
    assert calls == ["fal-ai/nano-banana-pro"]  # one slug, no chain


async def test_fallback_chain_degrades_to_next_slug(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PROVIDER_FALLBACK", "1")
    calls: list[str] = []

    async def flaky(model, prompt, aspect, refs):
        calls.append(model)
        if model == "fal-ai/nano-banana-pro":
            raise RuntimeError("outage")
        return _img(model)

    monkeypatch.setattr(image, "_generate_with_slug", flaky)
    out = await image.generate_image("p", "16:9", tier="balanced")
    assert out.model == "fal-ai/nano-banana-2"  # the chain's next stop
    assert calls == ["fal-ai/nano-banana-pro", "fal-ai/nano-banana-2"]


async def test_open_circuit_skips_the_dead_slug(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PROVIDER_FALLBACK", "1")
    for _ in range(breaker.FAILURE_THRESHOLD):
        breaker.record_failure("fal-ai/nano-banana-pro")
    calls: list[str] = []

    async def ok(model, prompt, aspect, refs):
        calls.append(model)
        return _img(model)

    monkeypatch.setattr(image, "_generate_with_slug", ok)
    out = await image.generate_image("p", "16:9", tier="balanced")
    assert calls == ["fal-ai/nano-banana-2"]  # pro never even attempted
    assert out.model == "fal-ai/nano-banana-2"


async def test_all_circuits_open_still_tries_the_requested_slug(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PROVIDER_FALLBACK", "1")
    for slug in ("fal-ai/nano-banana-pro", "fal-ai/nano-banana-2", "fal-ai/nano-banana"):
        for _ in range(breaker.FAILURE_THRESHOLD):
            breaker.record_failure(slug)
    calls: list[str] = []

    async def ok(model, prompt, aspect, refs):
        calls.append(model)
        return _img(model)

    monkeypatch.setattr(image, "_generate_with_slug", ok)
    out = await image.generate_image("p", "16:9", tier="balanced")
    # everything open -> last resort is the requested slug itself, not an error
    assert calls == ["fal-ai/nano-banana-pro"]
    assert out.model == "fal-ai/nano-banana-pro"
