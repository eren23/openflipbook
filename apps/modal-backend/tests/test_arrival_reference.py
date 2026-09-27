import hashlib
import io
import json
from dataclasses import asdict
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from providers import arrival_reference as refs
from providers.image import encode_data_url
from providers.place_identity import reference_crop

BOX = refs.ReferenceBox(.1, .2, .3, .4)


@pytest.fixture
def source():
    out = io.BytesIO()
    Image.new("RGB", (100, 100), "green").save(out, "PNG")
    return encode_data_url(out.getvalue(), "image/png")


def coverage(**overrides):
    return {"checks": {**dict.fromkeys(refs.AXES, "pass"), **overrides}, "rationale": "visible"}


@pytest.mark.parametrize("box", [None, [], {}, {**asdict(BOX), "x_pct": True}, {**asdict(BOX), "w_pct": "0.3"},
    {**asdict(BOX), "y_pct": float("nan")}, {**asdict(BOX), "h_pct": float("inf")},
    {**asdict(BOX), "w_pct": 0}, {**asdict(BOX), "x_pct": -.1}, {**asdict(BOX), "w_pct": 1},
    {**asdict(BOX), "extra": 1}])
def test_bbox_must_be_finite_normalized_and_nonempty(box):
    assert refs.ReferenceBox.parse(box) is None
    assert refs.ReferenceBox.parse(asdict(BOX)) == BOX


async def test_localizes_then_independently_checks_actual_pixels(source, monkeypatch):
    located = {"status": "pass", "bbox": asdict(BOX), "rationale": "locator-only-evidence"}
    inspect = AsyncMock(side_effect=[located, coverage()])
    monkeypatch.setattr(refs, "_inspect", inspect)
    hint = refs.ReferenceBox(.5, .1, .2, .1)
    result = await refs.resolve_physical_reference(source, hint, "Tower", "red roof")
    assert result.crop == reference_crop(source, BOX)
    assert result.receipt["status"] == "pass"
    assert result.receipt["original_bbox"] == asdict(hint)
    assert result.receipt["crop_sha256"] == hashlib.sha256(result.crop).hexdigest()
    assert result.receipt["effective_bbox"] == asdict(BOX)
    args = inspect.await_args_list[1].args
    assert args[1][1] == reference_crop(source, hint)
    assert args[1][2] == result.crop
    assert "locator-only-evidence" not in args[0]


@pytest.mark.parametrize("located", [{}, {"status": "unknown", "bbox": asdict(BOX)}, {"status": "pass", "bbox": {}}])
async def test_uncertain_localization_stops_without_verification(source, monkeypatch, located):
    inspect = AsyncMock(return_value=located)
    monkeypatch.setattr(refs, "_inspect", inspect)
    result = await refs.resolve_physical_reference(source, BOX, "Tower", "red")
    assert result.crop is None and result.receipt["status"] == "unknown"
    inspect.assert_awaited_once()


@pytest.mark.parametrize("axis", refs.AXES)
@pytest.mark.parametrize("state", ["fail", "unknown", None, True])
async def test_reference_requires_every_coverage_axis(source, monkeypatch, axis, state):
    monkeypatch.setattr(refs, "_inspect", AsyncMock(return_value=coverage(**{axis: state})))
    result = await refs.resolve_physical_reference(source, BOX, "Tower", "red", curated=True)
    assert result.crop is None and result.receipt["status"] != "pass"


async def test_curated_reference_is_checked_but_never_relocated(source, monkeypatch):
    inspect = AsyncMock(return_value=coverage())
    monkeypatch.setattr(refs, "_inspect", inspect)
    result = await refs.resolve_physical_reference(source, BOX, "Tower", "red", curated=True)
    inspect.assert_awaited_once()
    assert result.crop == reference_crop(source, BOX)
    assert result.receipt["effective_bbox"] == result.receipt["original_bbox"]


@pytest.mark.parametrize("raw,finish,expected", [
    (json.dumps(coverage()), "stop", True), (f"```json\n{json.dumps(coverage())}\n```", "stop", True),
    (json.dumps(coverage()), "length", False), (json.dumps(coverage()), "content_filter", False),
    ('```json\n{"checks":', "stop", False), ("[]", "stop", False), ("null", "stop", False),
    (f"prefix\n```json\n{json.dumps(coverage())}\n```", "stop", False),
])
async def test_inspection_preserves_fail_closed_json_contract(monkeypatch, raw, finish, expected):
    monkeypatch.setattr(refs.llm, "_client", lambda: None)
    call = AsyncMock(return_value=SimpleNamespace(choices=[SimpleNamespace(finish_reason=finish, message=SimpleNamespace(content=raw))]))
    monkeypatch.setattr(refs.llm, "_create_with_retry", call)
    assert bool(await refs._inspect("inspect", [b"image"])) == expected
    assert call.await_args.kwargs["max_tokens"] == 1200
