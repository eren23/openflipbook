import json

import pytest

from tests.continuity_bench import arrival_destination_pilot as pilot
from tests.continuity_bench.arrival_audit import sha


@pytest.fixture
def reference(tmp_path):
    source = tmp_path / "source.jpg"
    source.write_bytes(b"source")
    (tmp_path / "harbor_lighthouse-proposed.png").write_bytes(b"crop")
    (tmp_path / "manifest.json").write_text(json.dumps({"cases": [{"id": "harbor_lighthouse", "source": str(source), "source_sha256": sha(b"source"), "label": "Crystal", "visual": "Stone tower"}]}))
    (tmp_path / "harbor_lighthouse-receipt.json").write_text(json.dumps({"status": "pass", "source_sha256": sha(b"source"), "crop_sha256": sha(b"crop")}))
    return tmp_path


def test_preparation_is_frozen_to_one_image_and_five_judges(reference):
    report = pilot.prepare(reference)
    assert report["approved_cap_usd"] == "0.00"
    assert report["quoted_cap_usd"] == "1.00"
    assert report["image_limit"] == 1 and report["max_judge_calls"] == 5
    assert report["videos"] == report["retries"] == 0
    assert report["reference_sha256"] == sha(b"crop")
    assert "standing height" in report["prompt"]
    assert "landscape 16:9" in report["prompt"]
    assert "Do not change the input aspect ratio" not in report["prompt"]
    assert "Step inside" not in report["prompt"]


@pytest.mark.parametrize("file", ["source.jpg", "harbor_lighthouse-proposed.png"])
def test_changed_pixels_cannot_be_submitted(reference, file):
    (reference / file).write_bytes(b"changed")
    with pytest.raises(ValueError, match="changed"):
        pilot.prepare(reference)


def test_rejected_reference_cannot_be_submitted(reference):
    path = reference / "harbor_lighthouse-receipt.json"
    value = json.loads(path.read_text())
    value["status"] = "unknown"
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError, match="rejected"):
        pilot.prepare(reference)


async def test_explicit_approval_required_before_any_live_work(monkeypatch):
    monkeypatch.delenv("ARRIVAL_DESTINATION_PILOT", raising=False)
    with pytest.raises(RuntimeError, match="approval"):
        await pilot.run()
