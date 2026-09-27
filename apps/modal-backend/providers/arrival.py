"""Opt-in exterior arrival controls; unknown visual evidence never passes."""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Literal, TypedDict

State = Literal["pass", "fail", "unknown"]
AXES = ("near_target", "exterior", "single_target", "scene_not_map")
EXTERIOR = (
    "Arrive OUTSIDE this specific place, nearby at human eye height, not indoors. "
    "The target must be clearly inspectable, not a distant landmark behind other buildings. "
    "Preserve the actual silhouette, materials, and distinctive features. "
    "Show an entrance only if supported by the reference; do not invent a doorway. "
    "One instance of the target only. No duplicated facade, inset, or aerial map backdrop."
)


class ArrivalResult(TypedDict):
    status: State
    checks: dict[str, State]
    rationale: str


def parse_arrival(value: object) -> ArrivalResult:
    data = value if isinstance(value, dict) else {}
    raw = data.get("checks", {})
    raw = raw if isinstance(raw, dict) else {}
    checks: dict[str, State] = {
        axis: raw[axis] if raw.get(axis) in ("pass", "fail", "unknown") else "unknown"
        for axis in AXES
    }
    status: State = "fail" if "fail" in checks.values() else "unknown" if "unknown" in checks.values() else "pass"
    rationale = data.get("rationale")
    return {"status": status, "checks": checks, "rationale": rationale[:300] if isinstance(rationale, str) else "Arrival could not be verified"}


def parse_arrival_reply(raw: str) -> ArrivalResult:
    # Some providers fence complete JSON despite the JSON-only instruction.
    # Unwrap only one complete fence; never salvage a truncated object.
    fenced = re.fullmatch(r"```(?:json)?\s*\n(.*?)\n```", raw.strip(), re.DOTALL | re.IGNORECASE)
    try:
        return parse_arrival(json.loads(fenced.group(1) if fenced else raw))
    except (ValueError, TypeError):
        return parse_arrival(None)


async def check_exterior(reference: bytes, candidate: bytes, label: str) -> ArrivalResult:
    from providers import judge, llm

    response = await llm._create_with_retry(
        llm._client(), model=judge._judge_model(), temperature=0.0, max_tokens=800,
        messages=[
            {"role": "system", "content": (
                "Compare an architectural reference crop (image 1) with a proposed exterior arrival (image 2). "
                "Return ONLY a JSON object with checks and rationale. Each check is pass, fail, or unknown. "
                "near_target: the selected structure is nearby and clearly inspectable, not small/distant behind foreground buildings. "
                "exterior: the camera remains outside. single_target: exactly one instance of the selected structure, no duplicated facade. "
                "scene_not_map: an immersive scene, no aerial map used as a backdrop or inset. "
                "Missing, obscured or uncertain evidence is unknown, never pass. Do not require an invented door. "
                'Shape: {"checks":{"near_target":"pass|fail|unknown","exterior":"pass|fail|unknown",'
                '"single_target":"pass|fail|unknown","scene_not_map":"pass|fail|unknown"},"rationale":"short explanation"}.'
            )},
            {"role": "user", "content": [{"type": "text", "text": f"Selected place: {json.dumps(label)}"}, judge._image_block(reference), judge._image_block(candidate)]},
        ],
    )
    if response.choices[0].finish_reason == "length":
        return parse_arrival(None)
    return parse_arrival_reply(response.choices[0].message.content or "")


@dataclass(frozen=True)
class ReferenceInputs:
    source: str
    instruction: str
    identity: str | None
    context: str | None
    policy: str


def reference_inputs(source: str, canonical: str, instruction: str, label: str, visual: str, *, exterior: bool) -> ReferenceInputs:
    policy = os.environ.get("WORLD_ARRIVAL_REFERENCE_MODE", "context_first") if exterior else "context_first"
    if policy not in ("context_first", "target_first"):
        raise ValueError("Unknown arrival reference policy")
    if policy == "target_first":
        roles = f"Image 1 is the canonical architectural crop of {label}. Image 2 is world context only, not a background plate."
        first, identity, context = canonical, None, source
    else:
        roles = f"Image 1 is the current world context. Image 2 is the canonical crop of {label}."
        first, identity, context = source, canonical, None
    text = f"{instruction}\n{roles} Render this SPECIFIC place, not a similar one. Preserve its layout and distinctive features: {visual}. Context is not permission to invent, move or rename landmarks."
    if exterior:
        text += f"\n{EXTERIOR}"
    return ReferenceInputs(first, text, identity, context, policy)
