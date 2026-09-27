import io
import json
from decimal import Decimal
from unittest.mock import AsyncMock

import httpx
import pytest
from PIL import Image

from tests.continuity_bench import connected_demo_runner as r


def price(**changes):
    return {"prices": [{"endpoint_id": r.MODEL, "currency": "USD", "unit": "image",
                        "unit_price": ".15", **changes}]}


def fixture(tmp_path, monkeypatch):
    source = tmp_path / "source.png"
    Image.new("RGB", (80, 40), "teal").save(source)
    monkeypatch.setattr(r, "SOURCE", source)
    plan = {"shots": {"market": {"source": "root", "click": [.6, .4], "title": "Market",
                                  "attempts": {"1": {"prompt": "Same harbor", "seed": 7}}}}}
    return plan, r.prepare("market", 1, plan, tmp_path)


def test_price_reserves_headroom():
    assert r.reserve_price(price()) == Decimal(".25")
    assert r.reserve_price(price(unit_price=".21")) == Decimal(".32")


@pytest.mark.parametrize("changes", [{"currency": "EUR"}, {"unit": "second"},
                                    {"unit_price": "NaN"}, {"unit_price": "-1"}])
def test_invalid_price_fails_closed(changes):
    with pytest.raises(ValueError):
        r.reserve_price(price(**changes))


def test_fingerprint_tracks_pixels_prompt_crop_and_endpoint(tmp_path, monkeypatch):
    plan, item = fixture(tmp_path, monkeypatch)
    assert item["model"].endswith("/edit") and "image_urls" not in item["arguments"]
    plan["shots"]["market"]["attempts"]["1"]["reference_crop"] = [0, 0, .5, 1]
    cropped = r.prepare("market", 1, plan, tmp_path)
    assert cropped["fingerprint"] != item["fingerprint"]
    with Image.open(cropped["inputs"][0]["path"]) as image:
        assert image.size == (40, 40)
    plan["shots"]["market"]["attempts"]["1"]["prompt"] = "Changed"
    assert r.prepare("market", 1, plan, tmp_path)["fingerprint"] != cropped["fingerprint"]
    frozen = (tmp_path / "market-1-reference.png").read_bytes()
    plan["shots"]["market"]["attempts"]["1"]["reference_crop"] = [0, 0, .75, 1]
    with pytest.raises(ValueError, match="new attempt"):
        r.prepare("market", 1, plan, tmp_path)
    assert (tmp_path / "market-1-reference.png").read_bytes() == frozen


def test_review_binds_to_pixels_and_rejected_parents_cannot_generate(tmp_path, monkeypatch):
    plan, item = fixture(tmp_path, monkeypatch)
    output = tmp_path / "market-1.png"
    output.write_bytes(r.SOURCE.read_bytes())
    r.atomic_json(tmp_path / "market-1-receipt.json", {**item, "output": output.name,
                  "output_sha256": r.sha(output)})
    plan["shots"]["inside"] = {**plan["shots"]["market"], "source": "market-1"}
    with pytest.raises(ValueError, match="reviewed"):
        r.prepare("inside", 1, plan, tmp_path)
    r.review(tmp_path, item, "reject", "Duplicate building")
    with pytest.raises(ValueError, match="reviewed"):
        r.prepare("inside", 1, plan, tmp_path)
    r.review(tmp_path, item, "accept", "Test-only acceptance")
    assert len(r.prepare("inside", 1, plan, tmp_path)["inputs"]) == 2
    Image.new("RGB", (80, 40), "red").save(output)
    with pytest.raises(ValueError, match="bytes"):
        r.review(tmp_path, item, "accept", "Wrong pixels")
    with pytest.raises(ValueError, match="reviewed"):
        r.prepare("inside", 1, plan, tmp_path)


async def test_offline_gate_precedes_credentials(tmp_path, monkeypatch):
    _, item = fixture(tmp_path, monkeypatch)
    monkeypatch.delenv("CONNECTED_DEMO", raising=False)
    monkeypatch.setattr(r, "load_dotenv", lambda _: pytest.fail("Credentials accessed"))
    with pytest.raises(ValueError, match="disabled"):
        await r.run(item, tmp_path)


async def test_cached_replay_is_free_and_cap_blocks_before_upload(tmp_path, monkeypatch):
    import fal_client

    plan, item = fixture(tmp_path, monkeypatch)
    monkeypatch.setenv("CONNECTED_DEMO", "1")
    monkeypatch.setenv("FAL_KEY", "test-only")
    monkeypatch.delenv("MOCK_PROVIDERS", raising=False)
    monkeypatch.setattr(r, "load_dotenv", lambda _: None)
    upload = AsyncMock(return_value="https://fal.media/reference.png")
    monkeypatch.setattr(fal_client, "upload_file_async", upload)
    pixels = io.BytesIO()
    Image.new("RGB", (80, 40), "blue").save(pixels, format="PNG")
    calls = []

    def respond(request):
        calls.append(request)
        if request.url.path.endswith("/pricing"):
            return httpx.Response(200, json=price())
        if request.method == "POST":
            assert request.url.path.endswith("/nano-banana-pro/edit")
            assert json.loads(request.content)["image_urls"] == ["https://fal.media/reference.png"]
            return httpx.Response(200, json={"request_id": "job", "status_url": "https://queue.fal.run/job/status",
                                            "response_url": "https://queue.fal.run/job/result"})
        if request.url.path.endswith("/status"):
            return httpx.Response(200, json={"status": "COMPLETED"})
        if request.url.path.endswith("/result"):
            return httpx.Response(200, json={"images": [{"url": "https://fal.media/output.png"}]})
        assert "Authorization" not in request.headers
        return httpx.Response(200, content=pixels.getvalue())

    client = httpx.AsyncClient
    monkeypatch.setattr(r.httpx, "AsyncClient", lambda **kw: client(transport=httpx.MockTransport(respond), **kw))
    await r.run(item, tmp_path)
    assert upload.await_count == 1 and sum(c.method == "POST" for c in calls) == 1
    calls.clear()
    upload.reset_mock()
    await r.run(item, tmp_path)
    assert calls == [] and upload.await_count == 0
    with r.Ledger(tmp_path / "ledger.json", r.CAP) as ledger:
        ledger.reserve("other-approved-spend", Decimal("2.75"))
    plan["shots"]["market"]["attempts"]["2"] = {"prompt": "Other attempt", "seed": 8}
    with pytest.raises(ValueError, match="budget"):
        await r.run(r.prepare("market", 2, plan, tmp_path), tmp_path)
    assert upload.await_count == 0 and all(c.method == "GET" for c in calls)
