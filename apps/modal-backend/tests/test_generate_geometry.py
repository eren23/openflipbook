"""P3 generate-wiring gate (free): the layout clause appears only when the
geometry-gen flag is on AND an expected layout was sent (flag-off = no change)."""
from __future__ import annotations

import sys
from unittest.mock import MagicMock

import pytest

# generate.py imports `modal` at module level (deploy-only, not a test dep).
sys.modules.setdefault("modal", MagicMock())

import generate  # noqa: E402
from generate import GenerateBody, ProjectedEntity  # noqa: E402


def _proj(label: str) -> ProjectedEntity:
    return ProjectedEntity(
        id="a",
        label=label,
        x_pct=0.5,
        y_pct=0.3,
        w_pct=0.2,
        h_pct=0.5,
        depth=10.0,
        h_pos="center",
        v_pos="top",
        size="large",
    )


def _body(expected: list[ProjectedEntity]) -> GenerateBody:
    return GenerateBody(query="q", session_id="s", expected_layout=expected)


def test_layout_clause_off_when_flag_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WORLD_GEOMETRY_GEN", raising=False)
    assert generate._layout_clause_for(_body([_proj("Tower")])) == ""


def test_layout_clause_on_with_flag_and_expected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WORLD_GEOMETRY_GEN", "true")
    clause = generate._layout_clause_for(_body([_proj("Tower")]))
    assert "SCENE LAYOUT" in clause
    assert "Tower — large, center top" in clause


def test_layout_clause_empty_without_expected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WORLD_GEOMETRY_GEN", "true")
    assert generate._layout_clause_for(_body([])) == ""


# --- P4(c): grounding wiring -------------------------------------------------

from types import SimpleNamespace  # noqa: E402

from providers import detector, grounding  # noqa: E402


def test_vlm_grounding_flags_default_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("VLM_GROUNDING", raising=False)
    monkeypatch.delenv("VLM_GROUNDING_REPAIR", raising=False)
    assert generate._vlm_grounding_on() is False
    assert generate._vlm_grounding_repair_on() is False


def test_vlm_grounding_flags_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VLM_GROUNDING", "true")
    monkeypatch.setenv("VLM_GROUNDING_REPAIR", "yes")
    assert generate._vlm_grounding_on() is True
    assert generate._vlm_grounding_repair_on() is True


def test_grounding_summary_shape() -> None:
    report = grounding.GroundingReport(
        matched=[grounding.Match("tower", 0.9, True)],
        missing=["boat"],
        extra=["dragon"],
        score=0.812345,
        mean_iou=0.654321,
    )
    out = generate._grounding_summary(report, repaired=True, iterations=1)
    assert out == {
        "score": 0.812,
        "mean_iou": 0.654,
        "matched": ["tower"],
        "missing": ["boat"],
        "extra": ["dragon"],
        "repaired": True,
        "iterations": 1,
    }


_EXP = [{"label": "tower", "size": "large", "h_pos": "center", "v_pos": "top",
         "x_pct": 0.5, "y_pct": 0.3, "w_pct": 0.2, "h_pct": 0.5}]


def _fake_img() -> SimpleNamespace:
    return SimpleNamespace(jpeg_bytes=b"x", mime_type="image/jpeg", model="nano")


async def _noop_abort(_stage: str) -> None:
    return None


async def test_run_grounding_verify_only_happy_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_detect(_bytes, _labels):
        return [{"label": "tower", "x_pct": 0.5, "y_pct": 0.3,
                 "w_pct": 0.2, "h_pct": 0.5, "score": 1.0}]

    monkeypatch.setattr(detector, "detect", fake_detect)
    img = _fake_img()
    out_img, summary = await generate._run_grounding(
        img, _EXP, repair_on=False, abort=_noop_abort
    )
    assert out_img is img  # verify-only never mutates the image
    assert summary is not None
    assert summary["matched"] == ["tower"]
    assert summary["missing"] == [] and summary["repaired"] is False
    assert summary["score"] == pytest.approx(1.0)


async def test_run_grounding_degrades_on_detector_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def boom(_bytes, _labels):
        raise RuntimeError("vlm 429")

    monkeypatch.setattr(detector, "detect", boom)
    img = _fake_img()
    out_img, summary = await generate._run_grounding(
        img, _EXP, repair_on=False, abort=_noop_abort
    )
    assert out_img is img and summary is None  # best-effort: never breaks gen


async def test_run_grounding_verify_only_low_score_not_repaired(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Verify-only on a render missing entities → low score, but NO repair was
    # attempted, so the image is untouched and `repaired` is False. (The live
    # demo caught this: an attempt-counter must not imply a *kept* repair.)
    async def fake_detect(_bytes, _labels):
        return []  # detector finds nothing → every expected entity is missing

    monkeypatch.setattr(detector, "detect", fake_detect)
    img = _fake_img()
    out_img, summary = await generate._run_grounding(
        img, _EXP, repair_on=False, abort=_noop_abort
    )
    assert out_img is img
    assert summary is not None
    assert summary["repaired"] is False
    assert summary["iterations"] == 0
    assert summary["matched"] == [] and summary["missing"] == ["tower"]


async def test_run_grounding_empty_labels_is_noop() -> None:
    img = _fake_img()
    out_img, summary = await generate._run_grounding(
        img, [], repair_on=False, abort=_noop_abort
    )
    assert out_img is img and summary is None
