import base64
import io
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from tests.continuity_bench.arrival_live import ACTIVE, LLM, Meter, llm_reservation, scrub
from tests.video_transition_bench.runner import Ledger


def test_scrub_preserves_prompt_but_hashes_image_payload():
    assert scrub({"prompt": "hello", "images": ["data:image/png;base64,abc"]})["prompt"] == "hello"
    assert "data_url_sha256" in scrub(["data:image/png;base64,abc"])[0]


def test_meter_bounds_images_and_output():
    buffer = io.BytesIO()
    Image.new("RGB", (32, 32)).save(buffer, format="PNG")
    image = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()
    request = {"model": LLM, "max_tokens": 800, "messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": image}}]}]}
    assert Decimal(".03") < llm_reservation(request) < Decimal(".05")
    request["messages"][0]["content"][0]["image_url"]["url"] = "https://remote/image"
    with pytest.raises(ValueError, match="remote"):
        llm_reservation(request)


@pytest.mark.parametrize("changes", [{"model": "other"}, {"stream": True}, {"max_tokens": 4001}, {"max_tokens": 0}])
def test_unapproved_calls_rejected(changes):
    with pytest.raises(ValueError):
        llm_reservation({"model": LLM, "max_tokens": 800, **changes})


def test_pilot_cap_and_ambiguous_reservations_survive_restart(tmp_path):
    with Ledger(tmp_path / "ledger.json", Decimal("5.00")) as ledger:
        ledger.reserve("ambiguous", Decimal("4.90"))
    with Ledger(tmp_path / "ledger.json", Decimal("5.00")) as ledger:
        with pytest.raises(RuntimeError, match="budget"):
            ledger.reserve("image", Decimal(".15"))
        with pytest.raises(RuntimeError, match="again"):
            ledger.reserve("ambiguous", Decimal(".01"))


async def test_reference_meter_enforces_call_limit_and_disables_images(tmp_path, monkeypatch):
    import fal_client

    from providers import llm
    original = AsyncMock()
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=original)))
    monkeypatch.setattr(llm, "_client", lambda: client)
    monkeypatch.setattr(fal_client, "subscribe_async", AsyncMock())
    with Ledger(tmp_path / "ledger.json", Decimal("1.00")) as ledger:
        ledger.reserve("previous", Decimal(".01"))
        meter = Meter(ledger)
        meter.install(image_calls=False, max_llm_calls=1)
        assert meter.summary()["approved_cap_usd"] == "1.00"
        token = ACTIVE.set("reference")
        try:
            with pytest.raises(RuntimeError, match="call limit"):
                await client.chat.completions.create(model=LLM, messages=[], max_tokens=100)
            with pytest.raises(RuntimeError, match="disabled"):
                await fal_client.subscribe_async("fal-ai/nano-banana-pro/edit", arguments={})
        finally:
            ACTIVE.reset(token)
        original.assert_not_awaited()


async def test_image_reservation_does_not_consume_judge_call_limit(tmp_path, monkeypatch):
    import fal_client

    from providers import llm
    response = SimpleNamespace(id="judge-id", model_dump=lambda **_: {"usage": {"cost": .001}})
    original = AsyncMock(return_value=response)
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=original)))
    monkeypatch.setattr(llm, "_client", lambda: client)
    monkeypatch.setattr(fal_client, "subscribe_async", AsyncMock())
    with Ledger(tmp_path / "ledger.json", Decimal("1.00")) as ledger:
        ledger.reserve("image", Decimal(".15"))["kind"] = "image"
        meter = Meter(ledger)
        meter.install(max_llm_calls=1, image_operations=frozenset({"allowed"}))
        token = ACTIVE.set("allowed")
        try:
            await client.chat.completions.create(model=LLM, messages=[], max_tokens=100)
            with pytest.raises(RuntimeError, match="call limit"):
                await client.chat.completions.create(model=LLM, messages=[], max_tokens=100)
        finally:
            ACTIVE.reset(token)
        token = ACTIVE.set("not-allowed")
        try:
            with pytest.raises(RuntimeError, match="outside"):
                await fal_client.subscribe_async("fal-ai/nano-banana-pro/edit", arguments={})
        finally:
            ACTIVE.reset(token)
        original.assert_awaited_once()
