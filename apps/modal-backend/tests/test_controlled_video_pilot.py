from __future__ import annotations

import argparse
import hashlib
import json
from decimal import Decimal
from unittest.mock import AsyncMock

import httpx
import pytest
from PIL import Image

from tests.video_transition_bench import controlled_assets as a
from tests.video_transition_bench import controlled_runner as r
from tests.video_transition_bench.runner import Ledger


def manifest():
    names = {name for cell in r.configurations() for name in cell["files"].values()}
    return {
        "signature": {"version": a.VERSION, "source_sha256": "source"},
        "assets": {name: name + "-hash" for name in names},
    }


def prices():
    return {
        "prices": [
            {
                "endpoint_id": r.STRUCTURAL,
                "unit_price": "0.0024075",
                "unit": "megapixels",
                "currency": "USD",
            },
            {"endpoint_id": r.FAST, "unit_price": "0.06", "unit": "seconds", "currency": "USD"},
        ]
    }


def test_all_reference_frames_retain_landmark_and_use_uniform_affine():
    assert a.crop() == pytest.approx((0, 0.029, 0.528))
    for i in range(a.FRAMES):
        t = i / (a.FRAMES - 1)
        x, y, w, h = a.expected_box(t)
        assert 0 <= x < x + w <= 1
        assert 0 <= y < y + h <= 1
        scale, tx, ty = a.transform(t)
        assert tx <= 0 and ty <= 0 and tx + scale >= 1 and ty + scale >= 1
        assert w / h == pytest.approx(a.LANDMARK[2] / a.LANDMARK[3])
    assert a.transform(0) == (1, 0, 0)
    assert a.transform(-1) == a.transform(0)
    assert a.transform(2) == a.transform(1)


def test_contain_does_not_stretch_and_pixel_frame_has_fixed_dimensions():
    source = Image.new("RGB", (1376, 768), "red")
    rect = a.contain(a.SIZE, source.size)
    assert abs(rect[2] / rect[3] - source.width / source.height) < 0.002
    for t in (0, 0.5, 1):
        image = a.frame(source, t)
        assert image.size == a.SIZE
        assert image.getpixel((0, 0)) == (17, 17, 17)
        assert image.getpixel((640, 352)) == (255, 0, 0)


def test_five_fixed_payloads_and_matching_assets():
    cells = r.configurations()
    assert len(cells) == 5
    assert len({c["id"] for c in cells}) == 5
    for cell in cells[:4]:
        p = cell["arguments"]
        assert p["resolution"] == {"width": 1280, "height": 704}
        assert p["num_frames"] == 121 and p["frames_per_second"] == 24
        assert p["preserve_original_video"] and p["skip_control_preprocess"]
        assert not p["enable_prompt_expansion"] and not p["generate_audio"]
        assert "painting" not in p["negative_prompt"]
        assert set(cell["files"]) == {
            "image_url",
            "mid_image_url",
            "end_image_url",
            "video_url",
            "control_video_url",
        }
    assert cells[-1]["arguments"]["duration"] == 6
    assert "video_url" not in cells[-1]["files"]


def test_new_fingerprint_covers_control_anchor_source_and_settings():
    cell = r.configurations()[0]
    inputs = manifest()
    base = r.fingerprint(cell, inputs)
    for name in cell["files"].values():
        changed = json.loads(json.dumps(inputs))
        changed["assets"][name] += "changed"
        assert r.fingerprint(cell, changed) != base
    changed = json.loads(json.dumps(cell))
    changed["arguments"]["strength"] = 0.99
    assert r.fingerprint(changed, inputs) != base
    inputs["signature"]["source_sha256"] = "different"
    assert r.fingerprint(cell, inputs) != base


def test_pricing_uses_megapixels_and_reserves_headroom():
    rates = r.prices_from_payload(prices())
    cells = r.configurations()
    assert r.reservation(cells[0], rates) == Decimal("0.35")
    assert r.reservation(cells[-1], rates) == Decimal("0.50")
    assert sum(r.reservation(c, rates) for c in cells) == Decimal("1.90")
    rates[r.STRUCTURAL] = Decimal("0.1")
    assert r.reservation(cells[0], rates) > r.CAP


@pytest.mark.parametrize(
    "field,value",
    [("unit", "video"), ("currency", "EUR"), ("unit_price", "NaN"), ("unit_price", "0")],
)
def test_unknown_pricing_fails_closed(field, value):
    payload = prices()
    payload["prices"][0][field] = value
    with pytest.raises(ValueError):
        r.prices_from_payload(payload)


def test_duplicate_or_missing_prices_fail_closed():
    for rows in (prices()["prices"][:1], prices()["prices"] * 2):
        with pytest.raises(ValueError):
            r.prices_from_payload({"prices": rows})


def test_custom_cap_preserves_old_default_and_rejects_changed_authorization(tmp_path):
    path = tmp_path / "ledger.json"
    with Ledger(path, r.CAP) as ledger:
        ledger.reserve("first", Decimal("2.90"))
        with pytest.raises(RuntimeError, match="budget"):
            ledger.reserve("second", Decimal(".11"))
    with pytest.raises(ValueError, match="cap"), Ledger(path):
        pass
    with Ledger(path, r.CAP) as ledger:
        assert ledger.total == Decimal("2.90")


def test_geometry_measurement_has_no_automatic_visual_pass():
    boxes = [a.expected_box(i / 10) for i in range(11)]
    result = r.geometry_verdict(boxes, 1376 / 768)
    assert result["sampled_geometry"] == "pass"
    assert "visual_verdict" not in result
    boxes[5][0] += 0.06
    assert r.geometry_verdict(boxes, 1376 / 768)["sampled_geometry"] == "fail"
    with pytest.raises(ValueError):
        r.geometry_verdict(boxes[:3], 1.5)
    boxes[5][2] = 2
    with pytest.raises(ValueError, match="visible"):
        r.geometry_verdict(boxes, 1.5)


async def test_offline_and_missing_opt_in_never_read_keys_or_upload(monkeypatch, tmp_path):
    monkeypatch.setattr(a, "prepare", lambda _: manifest())
    monkeypatch.setattr(r, "load_dotenv", lambda _: pytest.fail("Read credentials"))
    monkeypatch.delenv("SPATIAL_VIDEO_PILOT", raising=False)
    await r.run(argparse.Namespace(out=tmp_path, run=False))
    assert json.loads((tmp_path / "summary.json").read_text())["reserved_usd"] == "0"
    with pytest.raises(ValueError, match="disabled"):
        await r.paid_run(tmp_path, manifest())


async def test_batch_and_cached_replay_submit_exactly_once(monkeypatch, tmp_path):
    import fal_client

    from providers import mock

    monkeypatch.setenv("SPATIAL_VIDEO_PILOT", "1")
    monkeypatch.setenv("FAL_KEY", "test-key")
    monkeypatch.setattr(r, "load_dotenv", lambda _: None)
    monkeypatch.setattr(mock, "on", lambda: False)
    upload = AsyncMock(return_value="https://fal.media/input")
    monkeypatch.setattr(fal_client, "upload_file_async", upload)
    calls = []

    def respond(request):
        calls.append(request)
        if request.url.path.endswith("/pricing"):
            return httpx.Response(200, json=prices())
        if request.url.path.endswith("/billing-events"):
            return httpx.Response(403)
        if request.method == "POST":
            job = str(len([c for c in calls if c.method == "POST"]))
            return httpx.Response(
                200,
                json={
                    "request_id": job,
                    "status_url": f"https://queue.fal.run/{job}/status",
                    "response_url": f"https://queue.fal.run/{job}/result",
                },
            )
        if request.url.path.endswith("/status"):
            return httpx.Response(200, json={"status": "COMPLETED"})
        if request.url.path.endswith("/result"):
            return httpx.Response(200, json={"video": {"url": "https://fal.media/output"}})
        assert "Authorization" not in request.headers
        return httpx.Response(200, content=b"video")

    original_client = httpx.AsyncClient
    monkeypatch.setattr(
        r.httpx,
        "AsyncClient",
        lambda **kw: original_client(transport=httpx.MockTransport(respond), **kw),
    )
    monkeypatch.setattr(
        a, "inspect_video", lambda _: {"sha256": hashlib.sha256(b"video").hexdigest()}
    )
    await r.paid_run(tmp_path, manifest())
    first = json.loads((tmp_path / "summary.json").read_text())
    assert first["complete"] and first["reserved_usd"] == "1.90"
    assert len([c for c in calls if c.method == "POST"]) == 5
    assert upload.await_count == 7
    calls.clear()
    upload.reset_mock()
    await r.paid_run(tmp_path, manifest())
    assert all(c.url.path.endswith("/billing-events") for c in calls)
    assert upload.await_count == 0
    assert json.loads((tmp_path / "summary.json").read_text())["reserved_usd"] == "1.90"


def test_prepare_rejects_tampered_frozen_input(tmp_path):
    signature = {
        "version": a.VERSION,
        "source_sha256": a.sha(a.SOURCE),
        "landmark": list(a.LANDMARK),
        "tap": list(a.TAP),
        "padding": a.PADDING,
        "crop": list(a.crop()),
        "size": list(a.SIZE),
        "frames": a.FRAMES,
        "fps": a.FPS,
    }
    (tmp_path / "first.png").write_bytes(b"changed")
    (tmp_path / "manifest.json").write_text(
        json.dumps({"signature": signature, "assets": {"first.png": "wrong"}})
    )
    with pytest.raises(ValueError, match="changed"):
        a.prepare(tmp_path)


def test_offline_review_is_hash_bound_and_never_invents_measurements(tmp_path, monkeypatch):
    inputs = manifest()
    inputs["source_size"] = [1376, 768]
    entries = []
    with Ledger(tmp_path / "ledger.json", r.CAP) as ledger:
        for item in r.configurations():
            digest = r.fingerprint(item, inputs)
            ledger.reserve(digest, Decimal(".35"))
            output = tmp_path / f"{item['id']}.mp4"
            output.write_bytes(b"frozen clip")
            r.atomic_json(
                tmp_path / f"{item['id']}-receipt.json",
                {
                    "id": item["id"],
                    "fingerprint": digest,
                    "state": "complete",
                    "output": output.name,
                    "metadata": {"sha256": a.sha(output)},
                    "visual_verdict": "unreviewed",
                },
            )
            entries.append(
                {
                    "id": item["id"],
                    "output_sha256": a.sha(output),
                    "visual_verdict": "No clear added value",
                }
            )
        r.summary(tmp_path, r.configurations(), inputs, ledger)
    report = json.loads((tmp_path / "summary.json").read_text())
    report["billing"] = {"status": "unavailable"}
    r.atomic_json(tmp_path / "summary.json", report)
    review = {"reviewer": "test", "method": "sampled visual audit", "results": entries}
    path = tmp_path / "review.json"
    r.atomic_json(path, review)
    monkeypatch.setattr(r, "load_dotenv", lambda _: pytest.fail("Read credentials"))
    r.record_review(tmp_path, inputs, path)
    report = json.loads((tmp_path / "summary.json").read_text())
    assert not report["promotion"]
    assert report["billing"]["status"] == "unavailable"
    assert report["reserved_usd"] == "1.75"
    assert all(row["geometry"]["sampled_geometry"] == "unverified" for row in report["results"])
    entries[-1]["output_sha256"] = "unrelated output"
    entries[0]["visual_verdict"] = "Should not be written"
    r.atomic_json(path, review)
    before = (tmp_path / f"{entries[0]['id']}-receipt.json").read_bytes()
    with pytest.raises(ValueError, match="match"):
        r.record_review(tmp_path, inputs, path)
    assert (tmp_path / f"{entries[0]['id']}-receipt.json").read_bytes() == before
