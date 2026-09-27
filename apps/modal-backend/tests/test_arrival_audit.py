import json

import pytest
from PIL import Image

from tests.continuity_bench.arrival_audit import build, prepare, sha


def test_dry_manifest_has_twelve_unique_unsubmitted_cells_and_no_runtime_human_refs():
    report = build()
    assert len({cell["id"] for cell in report["cells"]}) == 12
    assert report["approved_cap_usd"] == report["reserved_usd"] == "0.00"
    assert all(cell["state"] == "not_submitted" and cell["view_verdict"] is None for cell in report["cells"])
    assert all(c["runtime_reference"] is None and c["review"]["provenance"] == "human_evaluation_only" for c in report["cases"])
    assert build() == report


def test_prepare_writes_real_crops_without_reclassifying_them_as_runtime_references(tmp_path):
    report = prepare(tmp_path)
    for case in report["cases"]:
        path = tmp_path / f"{case['id']}-review.png"
        assert sha(path.read_bytes()) == case["review"]["crop_sha256"]
        with Image.open(path) as image:
            assert image.width > 50 and image.height > 50
        x, y, w, h = case["review"]["bbox"]
        assert x <= case["click"]["x_pct"] <= x + w
        assert y <= case["click"]["y_pct"] <= y + h
    assert prepare(tmp_path) == report


@pytest.mark.parametrize("name", ["ledger.json", "cell-receipt.json", "cell-candidate.png"])
def test_prepare_never_overwrites_submitted_artifacts(tmp_path, name):
    (tmp_path / name).write_text("frozen")
    with pytest.raises(ValueError, match="artifacts"):
        prepare(tmp_path)
    assert (tmp_path / name).read_text() == "frozen"


def test_prepare_never_resets_trial_state(tmp_path):
    report = prepare(tmp_path)
    report["cells"][0]["state"] = "submitted"
    (tmp_path / "manifest.json").write_text(json.dumps(report))
    with pytest.raises(ValueError, match="Submitted"):
        prepare(tmp_path)
