import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from providers import place_build as build


def test_disabled_without_configuration(monkeypatch):
    monkeypatch.delenv("PLACE_BUILD_ENABLED", raising=False)
    assert build.configuration()["enabled"] is False


@pytest.mark.parametrize("amount", ["0", "-1", "nan", "inf", "garbage", "11"])
def test_reservation_fails_closed(monkeypatch, amount):
    monkeypatch.setenv("PLACE_BUILD_ENABLED", "1")
    monkeypatch.setenv("SHARED_TOKEN", "test")
    monkeypatch.setenv("PLACE_BUILD_RESERVATION_USD", amount)
    monkeypatch.setattr(build.llm, "_resolve_provider", lambda: None)
    assert build.configuration()["enabled"] is False


def fixture(monkeypatch, content='{"objects":[{"id":"proposed"}]}', finish="stop"):
    monkeypatch.setattr(build, "configuration", lambda: {"enabled": True, "model": "configured-model", "reservation": 0.1})
    response = SimpleNamespace(id="provider-id", usage=SimpleNamespace(prompt_tokens=10, completion_tokens=20, total_tokens=30), choices=[SimpleNamespace(finish_reason=finish, message=SimpleNamespace(content=content))])
    create = AsyncMock(return_value=response)
    monkeypatch.setattr(build.llm, "_client", lambda: SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))))
    return create, build.PlanInput(prompt="Build a workshop", model="configured-model", reservation=0.1, definition={"objects": []})


@pytest.mark.asyncio
async def test_material_proposals_remain_in_the_same_single_layout_response(monkeypatch):
    payload = {"objects": [{"id": "workshop"}], "materials": [
        {"id": "masonry", "prompt": "Weathered grey limestone", "targets": [
            {"object_id": "workshop", "surface": "wall", "tile_metres": 2,
             "rotation": 0, "roughness": 0.85}]}]}
    create, body = fixture(monkeypatch, json.dumps(payload))
    result = await build.plan(body)
    assert result["status"] == "ready"
    assert result["result"] == payload
    create.assert_awaited_once()
    instructions = create.call_args.kwargs["messages"][0]["content"]
    assert "separately approved asset" in instructions
    assert "ONLY new building or path" in instructions
    assert "object_id:null, surface:floor" in instructions
    assert "empty AND saved_place has no ground_material" in instructions
    assert "Never target the ground when adding to an existing place" in instructions


@pytest.mark.asyncio
async def test_mesh_proposals_keep_roles_and_targets_in_one_layout_response(monkeypatch):
    payload = {"objects": [{"id": "monument", "kind": "volume"}], "meshes": [
        {"id": "stone", "prompt": "An isolated weathered stone monument",
         "role": "exterior", "targets": [{"object_id": "monument"}]}]}
    create, body = fixture(monkeypatch, json.dumps(payload))
    result = await build.plan(body)
    assert result["status"] == "ready"
    assert result["result"] == payload
    assert result["request_id"] == "provider-id"
    create.assert_awaited_once()
    instructions = create.call_args.kwargs["messages"][0]["content"]
    assert "Targets reference only new" in instructions
    assert "fit proportionally INSIDE" in instructions
    assert "solid non-enterable objects on outdoor ground ONLY" in instructions
    assert "keep its structured shell" in instructions


@pytest.mark.asyncio
async def test_single_call_keeps_saved_context_and_receipt(monkeypatch):
    create, body = fixture(monkeypatch)
    result = await build.plan(body)
    assert result["status"] == "ready"
    assert result["request_id"] == "provider-id"
    assert result["usage"]["total_tokens"] == 30
    assert create.await_count == 1
    assert create.call_args.kwargs["max_tokens"] == 16384
    assert json.loads(create.call_args.kwargs["messages"][1]["content"])["saved_place"] == body.definition


@pytest.mark.asyncio
async def test_selected_floor_is_sent_unchanged_in_the_single_call(monkeypatch):
    create, body = fixture(monkeypatch)
    body.definition = {"objects": [{"id": "inn", "kind": "building", "structure": {
        "floors": [{"id": "upper", "label": "Upper room"}]}}]}
    body.target_floor = build.FloorTarget(building_id="inn", floor_id="upper")
    assert (await build.plan(body))["status"] == "ready"
    context = json.loads(create.call_args.kwargs["messages"][1]["content"])
    assert context["target_floor"] == {"building_id": "inn", "floor_id": "upper"}
    assert context["saved_place"] == body.definition
    instructions = create.call_args.kwargs["messages"][0]["content"]
    assert "placement EXACTLY equal to target_floor" in instructions
    assert "A prompt\ncannot override this scope" in instructions
    create.assert_awaited_once()


@pytest.mark.asyncio
async def test_rejects_missing_floor_before_spending(monkeypatch):
    create, body = fixture(monkeypatch)
    body.target_floor = build.FloorTarget(building_id="foreign", floor_id="upper")
    with pytest.raises(HTTPException) as error:
        await build.plan(body)
    assert error.value.status_code == 400
    create.assert_not_awaited()


@pytest.mark.asyncio
async def test_saved_boundary_context_is_sent_unchanged_without_another_call(monkeypatch):
    create, body = fixture(monkeypatch)
    context = {"version": 1, "place_id": "here", "connections": [{
        "id": "road", "version": 1, "kind": "boundary", "width": 4,
        "created_at": "2026-09-13", "a": {"place_id": "here", "side": "east", "offset": 20},
        "b": {"place_id": "next", "side": "west", "offset": 20},
    }]}
    body.connection_input = build.ConnectionInput.model_validate(context)
    assert (await build.plan(body))["status"] == "ready"
    assert json.loads(create.call_args.kwargs["messages"][1]["content"])["connection_input"] == context
    assert "Connect EVERY saved opening" in create.call_args.kwargs["messages"][0]["content"]
    create.assert_awaited_once()


@pytest.mark.asyncio
async def test_planner_can_propose_explicit_stairs_without_a_second_call(monkeypatch):
    stair = {"id": "flight", "x": 0, "z": 1, "direction": "east"}
    payload = {"objects": [{"id": "building", "structure": {"stair": stair}}]}
    create, body = fixture(monkeypatch, json.dumps(payload))
    result = await build.plan(body)
    assert result["result"] == payload
    create.assert_awaited_once()
    instructions = create.call_args.kwargs["messages"][0]["content"]
    assert "structure.stair" in instructions
    assert "centre in building-local metres" in instructions
    assert "Only two-floor buildings may have stair" in instructions


@pytest.mark.asyncio
async def test_compound_outline_contract_retains_wall_references(monkeypatch):
    payload = {"objects": [{"id": "building", "structure": {
        "footprint": [{"id": "wall_a", "x": -0.5, "z": -0.5}],
        "door": {"wall_id": "wall_a"},
    }}]}
    create, body = fixture(monkeypatch, json.dumps(payload))
    assert (await build.plan(body))["result"] == payload
    create.assert_awaited_once()
    instructions = create.call_args.kwargs["messages"][0]["content"]
    assert "structure.footprint" in instructions
    assert "NORMALIZED to -0.5..0.5" in instructions
    assert "wall_id referencing that wall" in instructions
    assert "never separately proposed" in instructions


@pytest.mark.asyncio
@pytest.mark.parametrize("content,finish", [('{}', 'stop'), ('invalid', 'stop'), ('{"objects":[]}', 'stop'), ('{"objects":[{}]}', 'length')])
async def test_invalid_or_truncated_output_never_repairs_automatically(monkeypatch, content, finish):
    create, body = fixture(monkeypatch, content, finish)
    assert (await build.plan(body))["status"] == "invalid"
    assert create.await_count == 1


@pytest.mark.asyncio
async def test_ambiguous_provider_call_is_not_retried(monkeypatch):
    create, body = fixture(monkeypatch)
    create.side_effect = TimeoutError()
    with pytest.raises(TimeoutError):
        await build.plan(body)
    assert create.await_count == 1


@pytest.mark.asyncio
async def test_rejects_configuration_change_before_spending(monkeypatch):
    create, body = fixture(monkeypatch)
    body.reservation = 0.2
    with pytest.raises(HTTPException) as error:
        await build.plan(body)
    assert error.value.status_code == 409
    create.assert_not_awaited()
