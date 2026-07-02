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


def _world_body(expected: list[ProjectedEntity]) -> GenerateBody:
    return GenerateBody(
        query="q", session_id="s", expected_layout=expected, world_mode=True
    )


def test_layout_clause_defaults_on_under_world_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """W1: under an ACTIVE world mode the layout clause defaults ON — it is
    the only thing pinning the map's geography on a steered render."""
    monkeypatch.delenv("WORLD_GEOMETRY_GEN", raising=False)
    monkeypatch.setenv("WORLD_MODE", "true")
    clause = generate._layout_clause_for(_world_body([_proj("Tower")]))
    assert "SCENE LAYOUT" in clause


def test_layout_clause_world_mode_explicit_false_kills(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WORLD_GEOMETRY_GEN", "false")
    monkeypatch.setenv("WORLD_MODE", "true")
    assert generate._layout_clause_for(_world_body([_proj("Tower")])) == ""


def test_layout_clause_world_request_without_env_keeps_old_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A world_mode request against a WORLD_MODE-off deploy is NOT world mode
    — the old default (off) stands, byte-identical prompts."""
    monkeypatch.delenv("WORLD_GEOMETRY_GEN", raising=False)
    monkeypatch.delenv("WORLD_MODE", raising=False)
    assert generate._layout_clause_for(_world_body([_proj("Tower")])) == ""


def test_topdown_clause_only_for_maps_when_flag_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("WORLD_TOPDOWN_MAPS", raising=False)
    assert generate._topdown_clause_for(_body([])) == ""  # flag off → nothing
    monkeypatch.setenv("WORLD_TOPDOWN_MAPS", "true")
    # no scene_view ⇒ a fresh map render → forced top-down
    assert "FLAT TOP-DOWN" in generate._topdown_clause_for(_body([]))
    # a scene/observer render is left alone (it's not a map)
    scene = generate.GenerateBody(
        query="q",
        session_id="s",
        scene_view=generate.SceneView(
            node_id="n",
            level="street",
            observer=generate.ObserverPose(
                pos=generate.WorldVec2(x=0, y=0), eye_height=1.7, gaze=0, fov=1.5
            ),
            map_crop=None,
        ),
    )
    assert generate._topdown_clause_for(scene) == ""


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


# --- P5(b): /edit-entities endpoint ------------------------------------------

import json as _json  # noqa: E402

from providers import llm as _llm  # noqa: E402


def _edit_body() -> generate.EditEntitiesBody:
    return generate.EditEntitiesBody(
        session_id="s",
        instruction="move the lighthouse north",
        entities=[generate.GeoEntityRef(id="g1", label="lighthouse",
                                        pos=generate.WorldVec2(x=0, y=0))],
        references={"g1": ["n1"]},
    )


async def test_edit_entities_endpoint_403_when_flag_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GEOMETRIC_WORLD", raising=False)
    resp = await generate.edit_entities_endpoint(SimpleNamespace(headers={}), _edit_body())
    assert resp.status_code == 403


async def test_extract_localizes_missing_bboxes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # FIX 1a: with GEOMETRIC_WORLD on, an entity the extractor left bbox-less gets
    # localized by the detector; the centre-based detection is stored top-left.
    monkeypatch.setenv("GEOMETRIC_WORLD", "true")
    from providers import detector as _det
    from providers import view_estimator as _ve

    async def fake_view(_bytes, _caption=""):
        return {"level": "map", "projection": "oblique", "pitch_deg": -45.0}

    monkeypatch.setattr(_ve, "estimate_view", fake_view)

    async def fake_extract(**_kwargs):
        return _llm.EntityExtractionResult(
            added=[
                _llm.ExtractedEntity(
                    kind="place", name="Unseen University", appearance="tower",
                    aliases=[], facts=[], state={}, confidence=0.9, bbox=None,
                )
            ],
            updated=[],
        )

    async def fake_detect(_bytes, _labels):
        return [{"label": "Unseen University", "x_pct": 0.5, "y_pct": 0.4,
                 "w_pct": 0.2, "h_pct": 0.3, "score": 0.9}]

    monkeypatch.setattr(_llm, "extract_entities", fake_extract)
    monkeypatch.setattr(_det, "detect", fake_detect)
    body = generate.ExtractEntitiesBody(
        session_id="s", node_id="n", image_data_url="data:image/jpeg;base64,QUJD"
    )
    resp = await generate.extract_entities_endpoint(SimpleNamespace(headers={}), body)
    payload = _json.loads(resp.body)
    bb = payload["result"]["added"][0]["bbox"]
    assert bb["x_pct"] == pytest.approx(0.4)  # centre 0.5 minus w/2 0.1
    assert bb["y_pct"] == pytest.approx(0.25)  # centre 0.4 minus h/2 0.15
    assert bb["w_pct"] == pytest.approx(0.2)
    # FIX 1b: the estimated camera rides on the response (no more top-down assumption)
    assert payload["view"] == {"level": "map", "projection": "oblique", "pitch_deg": -45.0}


async def test_extract_view_overlaps_extract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The view estimate must run CONCURRENTLY with entity extraction (it only
    # needs pixels + caption). Sequential execution deadlocks this pairing:
    # the extractor blocks until the view stage has started.
    import asyncio

    monkeypatch.setenv("GEOMETRIC_WORLD", "true")
    from providers import view_estimator as _ve

    view_started = asyncio.Event()

    async def fake_view(_bytes, _caption=""):
        view_started.set()
        return {"level": "map", "projection": "top_down", "pitch_deg": -90.0}

    async def fake_extract(**_kwargs):
        await asyncio.wait_for(view_started.wait(), 2.0)
        return _llm.EntityExtractionResult(added=[], updated=[])

    monkeypatch.setattr(_ve, "estimate_view", fake_view)
    monkeypatch.setattr(_llm, "extract_entities", fake_extract)
    body = generate.ExtractEntitiesBody(
        session_id="s", node_id="n", image_data_url="data:image/jpeg;base64,QUJD"
    )
    resp = await generate.extract_entities_endpoint(SimpleNamespace(headers={}), body)
    payload = _json.loads(resp.body)
    assert payload["view"]["projection"] == "top_down"


async def test_edit_entities_endpoint_returns_plan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GEOMETRIC_WORLD", "true")

    async def fake_nl(instruction, entities, references=None, scene_view=None):
        assert references == {"g1": ["n1"]}  # the endpoint forwards refs
        return _llm.EditPlan(
            edits=[{"op": "move", "target": "g1", "dx": 0.0, "dy": -5.0}],
            blast_radius=["n1"],
        )

    monkeypatch.setattr(_llm, "edit_entities_nl", fake_nl)
    resp = await generate.edit_entities_endpoint(SimpleNamespace(headers={}), _edit_body())
    assert resp.status_code == 200
    payload = _json.loads(resp.body)
    assert payload["plan"]["edits"] == [{"op": "move", "target": "g1", "dx": 0.0, "dy": -5.0}]
    assert payload["plan"]["blast_radius"] == ["n1"]
