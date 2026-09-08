from __future__ import annotations

import argparse
import json
from decimal import Decimal
from unittest.mock import AsyncMock

import httpx
import pytest

from tests.video_transition_bench import runner as r


def test_ledger_survives_restart_and_rejects_duplicates_and_overflow(tmp_path):
    path = tmp_path / "ledger.json"
    with r.Ledger(path) as ledger:
        ledger.reserve("first", Decimal("1.90"))
        with pytest.raises(RuntimeError, match="again"):
            ledger.reserve("first", Decimal(".01"))
        with pytest.raises(BlockingIOError), r.Ledger(path):
            pass
    with r.Ledger(path) as ledger:
        assert ledger.total == Decimal("1.90")
        with pytest.raises(RuntimeError, match="budget"):
            ledger.reserve("second", Decimal(".11"))
        ledger.reserve("second", Decimal(".10"))
        assert ledger.total == r.CAP


@pytest.mark.parametrize("value", ["NaN", "Infinity", "-1", "0"])
def test_invalid_prices_and_ledgers_fail_closed(tmp_path, value):
    with pytest.raises(ValueError):
        r.money(value)
    path = tmp_path / "ledger.json"
    path.write_text(json.dumps({"cap_usd": "2.00", "cells": {"x": {"reserved_usd": value}}}))
    with pytest.raises(ValueError), r.Ledger(path):
        pass


def test_missing_ledger_with_existing_outputs_is_not_a_fresh_budget(tmp_path):
    (tmp_path / "old.mp4").write_bytes(b"clip")
    with pytest.raises(ValueError, match="without a ledger"), r.Ledger(tmp_path / "ledger.json"):
        pass


def test_cache_keys_cover_both_frames_models_and_settings():
    key = r.fingerprint(b"a", b"b", "h3", {"duration": 6})
    assert key == r.fingerprint(b"a", b"b", "h3", {"duration": 6, "image_url": "new-url"})
    assert (
        len(
            {
                key,
                r.fingerprint(b"c", b"b", "h3", {"duration": 6}),
                r.fingerprint(b"a", b"c", "h3", {"duration": 6}),
                r.fingerprint(b"a", b"b", "ltx", {"duration": 6}),
                r.fingerprint(b"a", b"b", "h3", {"duration": 5}),
            }
        )
        == 5
    )


def handler(calls):
    def respond(request):
        calls.append(request.method)
        if request.method == "POST":
            return httpx.Response(
                200,
                json={
                    "request_id": "one",
                    "status_url": "https://queue.fal.run/test/requests/one/status",
                    "response_url": "https://queue.fal.run/test/requests/one",
                },
            )
        if request.url.path.endswith("/status"):
            return httpx.Response(200, json={"status": "COMPLETED"})
        return httpx.Response(200, json={"video": {"url": "https://fal.media/video.mp4"}})

    return respond


async def test_completed_rerun_is_zero_submit_and_zero_poll(tmp_path):
    calls = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler(calls))) as client:
        with r.Ledger(tmp_path / "ledger.json") as ledger:
            result = await r.generate_cell(
                client, {}, ledger, "cell", r.H3_MAX_MODEL, {}, Decimal(".12")
            )
        assert result["request_id"] == "one"
        assert calls == ["POST", "GET", "GET"]
        with r.Ledger(tmp_path / "ledger.json") as ledger:
            await r.generate_cell(client, {}, ledger, "cell", r.H3_MAX_MODEL, {}, Decimal(".12"))
            assert ledger.total == Decimal(".12")
        assert calls == ["POST", "GET", "GET"]


async def test_known_job_resumes_without_submission(tmp_path):
    calls = []
    with r.Ledger(tmp_path / "ledger.json") as ledger:
        row = ledger.reserve("cell", Decimal(".12"))
        row.update(
            request_id="one",
            status_url="https://queue.fal.run/test/status",
            response_url="https://queue.fal.run/test/result",
        )
        ledger.save()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler(calls))) as client:
        with r.Ledger(tmp_path / "ledger.json") as ledger:
            await r.generate_cell(client, {}, ledger, "cell", r.H3_MAX_MODEL, {}, Decimal(".12"))
    assert calls == ["GET", "GET"]


@pytest.mark.parametrize("status", [500, 429, 401])
async def test_failed_submission_counts_and_never_retries(tmp_path, status):
    calls = []

    def fail(request):
        calls.append(request.method)
        return httpx.Response(status)

    async with httpx.AsyncClient(transport=httpx.MockTransport(fail)) as client:
        with r.Ledger(tmp_path / "ledger.json") as ledger:
            with pytest.raises(httpx.HTTPStatusError):
                await r.generate_cell(
                    client, {}, ledger, "cell", r.H3_MAX_MODEL, {}, Decimal(".12")
                )
            with pytest.raises(RuntimeError, match="ambiguous"):
                await r.generate_cell(
                    client, {}, ledger, "cell", r.H3_MAX_MODEL, {}, Decimal(".12")
                )
            assert ledger.total == Decimal(".12")
    assert calls == ["POST"]


async def test_cap_prevents_the_network_call(tmp_path):
    calls = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler(calls))) as client:
        with r.Ledger(tmp_path / "ledger.json") as ledger:
            ledger.reserve("spent", r.CAP)
            with pytest.raises(RuntimeError, match="budget"):
                await r.generate_cell(client, {}, ledger, "new", r.H3_MAX_MODEL, {}, Decimal(".12"))
    assert calls == []


@pytest.mark.parametrize(
    "url", ["http://queue.fal.run/a", "https://evil.test/a", "https://queue.fal.run.evil.test/a"]
)
def test_credentials_cannot_follow_foreign_queue_urls(url):
    with pytest.raises(ValueError):
        r.queue_url(url)


async def test_pricing_validates_currency_units_and_coverage():
    rows = [
        {"endpoint_id": model, "unit_price": 0.06, "unit": "seconds", "currency": "USD"}
        for model in r.MODELS
    ]
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"prices": rows}))
    ) as client:
        prices, _ = await r.quote(client, {})
        assert prices[r.DESCENT_ANIMATE_MODEL] == Decimal(".36")
        rows[0]["unit"] = "video"
        with pytest.raises(ValueError, match="units"):
            await r.quote(client, {})
        rows.clear()
        with pytest.raises(ValueError, match="Missing"):
            await r.quote(client, {})


async def test_dry_run_and_missing_opt_in_never_load_credentials_or_call_models(
    monkeypatch, tmp_path
):
    monkeypatch.setattr(r, "input_cells", lambda _: [])
    load = AsyncMock()
    monkeypatch.setattr(r, "load_dotenv", load)
    args = argparse.Namespace(assets_root=tmp_path, out=tmp_path, run=False)
    await r.run(args)
    args.run = True
    monkeypatch.delenv("H3_TRANSITION_PILOT", raising=False)
    with pytest.raises(ValueError, match="disabled"):
        await r.run(args)
    load.assert_not_called()


async def test_paid_mode_refuses_mock_stack(monkeypatch, tmp_path):
    monkeypatch.setattr(r, "input_cells", lambda _: [])
    monkeypatch.setenv("H3_TRANSITION_PILOT", "1")
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    with pytest.raises(ValueError, match="Mock mode"):
        await r.run(argparse.Namespace(assets_root=tmp_path, out=tmp_path, run=True))


async def test_timeout_retains_reservation_and_cannot_rebill(tmp_path):
    calls = []

    def fail(request):
        calls.append(request.method)
        raise httpx.ReadTimeout("lost response")

    async with httpx.AsyncClient(transport=httpx.MockTransport(fail)) as client:
        with r.Ledger(tmp_path / "ledger.json") as ledger, pytest.raises(httpx.ReadTimeout):
            await r.generate_cell(client, {}, ledger, "cell", r.H3_MAX_MODEL, {}, Decimal(".12"))
        with (
            r.Ledger(tmp_path / "ledger.json") as ledger,
            pytest.raises(RuntimeError, match="ambiguous"),
        ):
            await r.generate_cell(client, {}, ledger, "cell", r.H3_MAX_MODEL, {}, Decimal(".12"))
    assert calls == ["POST"]


async def test_billing_is_scoped_and_unavailable_is_not_zero():
    rows = [{"request_id": "ours"}]

    def respond(request):
        assert request.method == "GET"
        assert request.url.params["request_id"] == "ours"
        return httpx.Response(
            200,
            json={
                "has_more": False,
                "billing_events": [
                    {"request_id": "ours", "cost_total": 0.1},
                    {"request_id": "unrelated", "cost_total": 5},
                ],
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        assert await r.billing_report(client, {}, rows) == {
            "status": "complete",
            "costs_usd": {"ours": "0.1"},
        }
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(403))
    ) as client:
        assert await r.billing_report(client, {}, rows) == {"status": "unavailable"}


@pytest.mark.parametrize("cost", ["invalid", None, "NaN", "-1"])
async def test_malformed_billing_cost_is_unavailable(cost):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(
                200,
                json={"billing_events": [{"request_id": "ours", "cost_total": cost}]},
            )
        )
    ) as client:
        assert await r.billing_report(client, {}, [{"request_id": "ours"}]) == {
            "status": "unavailable"
        }


def test_frozen_inputs_match_the_published_receipts():
    receipts = json.loads(
        (r.BACKEND.parents[1] / "docs/research/12-transition-video-pilot.json").read_text()
    )
    cells = r.input_cells(r.BACKEND)
    assert len(cells) == 6
    for cell, receipt in zip(cells, receipts["results"], strict=True):
        assert (
            r.fingerprint(
                cell["source"].read_bytes(),
                cell["destination"].read_bytes(),
                cell["model"],
                cell["arguments"],
            )
            == receipt["fingerprint"]
        )


def test_offline_review_builds_relative_media_and_contact_sheets(tmp_path, monkeypatch):
    from PIL import Image

    from tests.video_transition_bench import review

    source = tmp_path / "input.jpg"
    Image.new("RGB", (30, 20), "red").save(source)
    monkeypatch.setattr(
        review,
        "input_cells",
        lambda _: [{"case": c, "source": source, "destination": source} for c in r.CASES],
    )
    rows = []
    for case in r.CASES:
        for model in r.MODELS:
            stem = case + ("-h3" if model == r.H3_MAX_MODEL else "-ltx")
            rows.append({"case": case, "model": model, "complete": True, "output": stem + ".mp4"})
            for frame in range(5):
                Image.new("RGB", (30, 20), "blue").save(tmp_path / f"{stem}-frame-{frame}.jpg")
    r.atomic_json(tmp_path / "summary.json", {"reserved_usd": "1.44", "results": rows})
    review.build(tmp_path, tmp_path)
    document = (tmp_path / "review.html").read_text()
    assert document.count("<video controls") == 6
    assert "https://" not in document
    assert len(json.loads((tmp_path / "ab-mapping.json").read_text())) == 6
    for case in r.CASES:
        with Image.open(tmp_path / f"{case}-contact.jpg") as sheet:
            assert sheet.size == (1600, 420)
