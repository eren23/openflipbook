import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from providers import scene_edit as edit


@pytest.mark.parametrize("amount", ["0", "-1", "nan", "inf", "garbage", "11"])
def test_invalid_reservation_disables_planner(monkeypatch, amount):
    monkeypatch.setenv("SCENE_EDIT_ENABLED", "1")
    monkeypatch.setenv("SHARED_TOKEN", "test")
    monkeypatch.setenv("SCENE_EDIT_RESERVATION_USD", amount)
    monkeypatch.setattr(edit.llm, "_resolve_provider", lambda: None)
    assert edit.configuration()["enabled"] is False


def fixture(monkeypatch, content='{"version":1,"edits":[{"op":"move","target":"inn","dx":1,"dz":0}]}', finish="stop"):
    monkeypatch.setattr(edit, "configuration", lambda: {"enabled": True, "model": "model", "reservation": 0.2, "contract_version": 1})
    response = SimpleNamespace(id="provider-id", usage=SimpleNamespace(prompt_tokens=10, completion_tokens=20, total_tokens=30), choices=[SimpleNamespace(finish_reason=finish, message=SimpleNamespace(content=content))])
    create = AsyncMock(return_value=response)
    monkeypatch.setattr(edit.llm, "_client", lambda: SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))))
    body = edit.EditInput(prompt="Move the inn", model="model", reservation=0.2, definition={"objects": [{"id": "inn"}]}, selected_object_ids=["inn"], connection_input={"version": 1, "place_id": "place", "connections": []})
    return create, body


@pytest.mark.asyncio
async def test_one_call_keeps_exact_raw_response_selected_scope_and_saved_context(monkeypatch):
    create, body = fixture(monkeypatch)
    body.materials = [{"id": "stone", "sha256": "a" * 64, "prompt": "Grey stone"}]
    result = await edit.plan(body)
    create.assert_awaited_once()
    assert result["status"] == "ready"
    assert json.loads(result["raw_text"]) == result["result"]
    assert result["request_id"] == "provider-id"
    assert result["usage"]["total_tokens"] == 30
    context = json.loads(create.call_args.kwargs["messages"][1]["content"])
    assert context["selected_object_ids"] == ["inn"]
    assert context["saved_place"] == body.definition
    assert context["connection_input"] == body.connection_input.model_dump()
    assert context["materials"] == body.materials
    assert "Never return a replacement scene" in create.call_args.kwargs["messages"][0]["content"]


@pytest.mark.asyncio
@pytest.mark.parametrize("content,finish", [("invalid", "stop"), ("{}", "stop"), ('{"version":1,"edits":[]}', "stop"), ('{"version":1,"edits":[{}]}', "length")])
async def test_rejected_raw_output_is_preserved_without_repair(monkeypatch, content, finish):
    create, body = fixture(monkeypatch, content, finish)
    result = await edit.plan(body)
    assert result["status"] == "invalid"
    assert result["raw_text"] == content
    create.assert_awaited_once()


@pytest.mark.asyncio
async def test_timeout_is_one_ambiguous_submission(monkeypatch):
    create, body = fixture(monkeypatch)
    create.side_effect = TimeoutError()
    with pytest.raises(TimeoutError):
        await edit.plan(body)
    create.assert_awaited_once()


@pytest.mark.asyncio
async def test_disabled_or_changed_quote_never_submits(monkeypatch):
    create, body = fixture(monkeypatch)
    body.reservation = 0.3
    with pytest.raises(HTTPException) as error:
        await edit.plan(body)
    assert error.value.status_code == 409
    create.assert_not_awaited()
    monkeypatch.setattr(edit, "configuration", lambda: {"enabled": False})
    with pytest.raises(HTTPException) as error:
        await edit.plan(body)
    assert error.value.status_code == 503
    create.assert_not_awaited()


@pytest.mark.asyncio
async def test_oversized_context_never_submits(monkeypatch):
    create, body = fixture(monkeypatch)
    body.definition["label"] = "x" * 250_000
    with pytest.raises(HTTPException) as error:
        await edit.plan(body)
    assert error.value.status_code == 400
    create.assert_not_awaited()
