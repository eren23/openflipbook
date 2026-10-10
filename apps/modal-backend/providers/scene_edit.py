"""Single-attempt typed scene edits. The web worker owns quotes, durable claims and review."""
import asyncio
import json
import math
import os
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from providers import llm
from providers.place_build import ConnectionInput

router = APIRouter(prefix="/scene-edit")


def configuration() -> dict[str, Any]:
    try:
        reservation = float(os.environ.get("SCENE_EDIT_RESERVATION_USD", "0"))
        llm._resolve_provider()
        available = True
    except (ValueError, RuntimeError):
        reservation, available = 0, False
    enabled = (os.environ.get("SCENE_EDIT_ENABLED") == "1" and bool(os.environ.get("SHARED_TOKEN"))
               and available and math.isfinite(reservation) and 0 < reservation <= 10)
    return {"enabled": enabled, "model": llm._text_model(online=False), "reservation": reservation if enabled else 0,
            "contract_version": 1, "reason": None if enabled else "Scene edits need an LLM, shared token and operator-set cost reservation."}


@router.get("/capabilities")
async def capabilities() -> dict[str, Any]:
    return configuration()


class EditInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str = Field(min_length=3, max_length=4000)
    model: str = Field(min_length=1, max_length=200)
    reservation: float
    definition: dict[str, Any]
    selected_object_ids: list[str] = Field(default_factory=list, max_length=100)
    connection_input: ConnectionInput
    materials: list[dict[str, Any]] = Field(default_factory=list, max_length=100)


SYSTEM = """Return ONLY JSON {"version":1,"edits":[typed edits]} with 1 to 30 edits.
This is a proposal for the saved authoritative place. Never return a replacement scene.
Preserve all existing object/entity/floor/room/opening identities, place dimensions,
entrance and immutable boundary connections. Targets are saved object IDs. If selected
IDs are supplied, target those objects or their explicitly bound furnishings only.
Allowed operations:
{"op":"move","target":"saved-id","dx":1,"dz":0} (world authored metres);
{"op":"patch","target":"saved-id","changes":{...}} with ONLY x,z,width,depth,
height,heading (radians),color (#RRGGBB),label,eave_height,roof_offset,roof_material
(terracotta or teal),materials (saved material asset bindings);
{"op":"roof","target":"building-id","roof_height":1.4};
{"op":"door","target":"building-id","changes":{side,wall_id,offset,width,height,sill,floor}};
{"op":"remove","target":"saved-id"};
{"op":"add","object":{...new typed scene object...}}.
Use only supplied saved material asset IDs: binding {asset_id,tile_metres,rotation,
roughness} on wall,floor,roof,ceiling,stair. New texture or mesh generation needs a
separate explicit quote; do not request it or invent asset IDs/URLs.
New objects need unique symbolic id/entity_id, kind,label,x,z,width,depth,height,
heading,color. Allowed kinds: building,path,bench,barrels,tree,well,pond,wall,pergola,
volume. Enterable buildings need existing structured-shell schema: wall_thickness,
roof_height, floors (one or two with id,label), door (id,side,offset,width,height,sill,
floor), windows array and a valid stair for two floors. Reuse physical dimensions
and schema from saved buildings, never substitute a decorative solid mesh shell.
Furnishings reference the saved placement {building_id,floor_id}; x,z are building-
local metres and heading is relative. Keep doorway, stair and room circulation clear.
Remove a building's furnishings explicitly if removing the building. No unrequested
neighbor changes. Keep all footprints within the place and its connection approaches
reachable. A roof-height change may need a compatible total building height patch.
"""


@router.post("/plan")
async def plan(body: EditInput) -> dict[str, Any]:
    config = configuration()
    if not config["enabled"]:
        raise HTTPException(503, "Scene edit planning is not configured")
    if body.model != config["model"] or body.reservation != config["reservation"]:
        raise HTTPException(409, "Scene edit configuration changed")
    context = {"request": body.prompt, "saved_place": body.definition,
               "selected_object_ids": body.selected_object_ids,
               "connection_input": body.connection_input.model_dump(), "materials": body.materials}
    context_json = json.dumps(context, ensure_ascii=False)
    if not body.prompt.strip() or len(context_json) > 250_000:
        raise HTTPException(400, "Invalid scene edit input")
    # The shared SDK client has retries disabled. No format fallback or repair call.
    async with asyncio.timeout(150):
        response = await llm._client().chat.completions.create(
            model=body.model, max_tokens=16384,
            messages=[{"role": "system", "content": SYSTEM}, {"role": "user", "content": context_json}],
            **llm._maybe_response_format(body.model),
        )
    choice = response.choices[0] if response.choices else None
    raw_text = choice.message.content or "" if choice else ""
    usage = getattr(response, "usage", None)
    receipt = {"model": body.model, "request_id": getattr(response, "id", None), "raw_text": raw_text[:250_000],
               "usage": {k: getattr(usage, k, None) for k in ("prompt_tokens", "completion_tokens", "total_tokens")}}
    try:
        if not choice or choice.finish_reason != "stop" or len(raw_text) > 250_000:
            raise ValueError("Incomplete response")
        result = json.loads(raw_text)
        if not isinstance(result, dict) or result.get("version") != 1 or not isinstance(result.get("edits"), list) or not 1 <= len(result["edits"]) <= 30:
            raise ValueError("Invalid edit list")
    except (ValueError, TypeError):
        return {**receipt, "status": "invalid", "error": "Scene edit response rejected; no repair call was submitted."}
    return {**receipt, "status": "ready", "result": result}
