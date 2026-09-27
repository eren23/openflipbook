import json

import pytest

from tests.continuity_bench import arrival_reference_pilot as pilot
from tests.continuity_bench.arrival_audit import sha


@pytest.fixture
def saved(tmp_path):
    cases = []
    for key in pilot.CASES:
        source = tmp_path / f"{key}.jpg"
        source.write_bytes(b"source")
        cases.append({"id": key, "source": source.name, "source_sha256": sha(b"source"), "review": {"bbox": "NEVER USE"}})
        ref = {"label": "Automatic title", "visual": "Automatic appearance", "bbox": {"x_pct": .1, "y_pct": .2, "w_pct": .3, "h_pct": .4},
               "provenance": {"kind": "first_seen", "image_sha256": sha(b"source")}}
        (tmp_path / f"{key}-context_first-1-request.json").write_text(json.dumps({"place_reference": ref}))
    (tmp_path / "manifest.json").write_text(json.dumps({"cases": cases}))
    return tmp_path


def test_uses_recorded_automatic_metadata_not_human_review(saved):
    result = pilot.inputs(saved, saved)
    assert len(result) == 3
    assert "NEVER USE" not in json.dumps(result)
    assert result[0]["label"] == "Automatic title"
    assert result[0]["bbox"]["x_pct"] == .1


def test_rejects_changed_source(saved):
    (saved / "fishing_lighthouse.jpg").write_bytes(b"changed")
    with pytest.raises(ValueError, match="match"):
        pilot.inputs(saved, saved)


def test_rejects_curated_metadata_for_automatic_pilot(saved):
    path = saved / "fishing_lighthouse-context_first-1-request.json"
    request = json.loads(path.read_text())
    request["place_reference"]["provenance"]["kind"] = "curated"
    path.write_text(json.dumps(request))
    with pytest.raises(ValueError, match="automatic"):
        pilot.inputs(saved, saved)


async def test_run_requires_explicit_opt_in_before_preparation(monkeypatch):
    monkeypatch.delenv("ARRIVAL_REFERENCE_PILOT", raising=False)
    with pytest.raises(RuntimeError, match="approval"):
        await pilot.run()
