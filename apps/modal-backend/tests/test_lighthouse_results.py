import hashlib
import json

import pytest

from tests.continuity_bench import lighthouse_results as results


@pytest.fixture
def artifacts(tmp_path, monkeypatch):
    reports = tmp_path / "reports"
    out = reports / "lighthouse-control-pilot"
    guides = reports / "lighthouse-guides"
    out.mkdir(parents=True)
    guides.mkdir()
    trials, reviews, cells = [], {}, {}
    for variant in ("guide_color", "guide_clay", "qwen_eye", "qwen_low"):
        for seed in (521, 522):
            key = f"{variant}-{seed}"
            pixels = key.encode()
            (out / f"{key}.png").write_bytes(pixels)
            (out / f"{key}-receipt.json").write_text("{}")
            trials.append({"id": key, "variant": variant, "seed": seed,
                           "output_sha256": hashlib.sha256(pixels).hexdigest(),
                           "all_checks_passed": False, "architecture": {"accepted": False},
                           "view_verdict": {"conformance": 9, "medium": 8}})
            reviews[key] = {"accepted": False, "note": "<script>Not trusted markup</script>"}
            cells[key] = {"kind": "image", "reserved_usd": ".15"}
            for i in range(6):
                cells[f"{key}:{i}"] = {"kind": "llm", "reserved_usd": ".001", "reported_cost_usd": ".001"}
    (out / "manifest.json").write_text(json.dumps({"status": "complete_not_promoted", "trials": trials}))
    (out / "ledger.json").write_text(json.dumps({"cells": cells}))
    for name in ("color.png", "clay.png", "depth.png", "capture.json"):
        (guides / name).write_bytes(b"fixture")
    review = tmp_path / "review.json"
    review.write_text(json.dumps({"trials": reviews}))
    monkeypatch.setattr(results, "REPORTS", reports)
    monkeypatch.setattr(results, "OUT", out)
    monkeypatch.setattr(results, "REVIEW", review)
    return out


def test_offline_gallery_preserves_outputs_separates_review_and_counts_cost(artifacts, tmp_path):
    destination = tmp_path / "gallery"
    summary = results.build(destination)
    assert summary["image_calls"] == 8 and summary["judge_calls"] == 48
    assert summary["reserved_usd"] == "1.248"
    assert summary["reported_judge_cost_usd"] == "0.048"
    assert summary["automatic_passes"] == summary["assistant_passes"] == 0
    assert summary["human_review"] is None and not summary["fal_invoice_reconciled"]
    document = (destination / "index.html").read_text()
    assert "&lt;script&gt;" in document and "<script>" not in document
    for file in artifacts.glob("*.png"):
        assert (destination / "raw" / file.name).read_bytes() == file.read_bytes()


def test_changed_candidate_is_rejected_before_packaging(artifacts, tmp_path):
    (artifacts / "guide_color-521.png").write_bytes(b"changed")
    destination = tmp_path / "gallery"
    with pytest.raises(ValueError, match="hash mismatch"):
        results.build(destination)
    assert not destination.exists()
