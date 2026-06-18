"""VLM-as-judge scoring — production home (moved from the continuity bench).

Each judge renders a verdict over images/text pairs through one VLM call and
returns a JudgeResult(score 0-10, rationale, raw). Used by the paid benches
AND by the render loop (the critic-guided retry on steep view transforms), so
it lives in providers/ — tests/continuity_bench/_score.py re-exports.

Model resolution: CONTINUITY_BENCH_JUDGE_MODEL > OPENROUTER_VLM_MODEL >
gemini-3-flash — in production the bench pin is unset, so judging rides the
same VLM + key the click resolver already requires.
"""

from __future__ import annotations

import base64
import json
import os
import re
from dataclasses import dataclass
from typing import Any

_SCORE_RE = re.compile(r"\"score\"\s*:\s*(\d+(?:\.\d+)?)")


@dataclass(frozen=True)
class JudgeResult:
    score: float
    rationale: str
    raw: str


def _judge_model() -> str:
    return os.environ.get(
        "CONTINUITY_BENCH_JUDGE_MODEL",
        os.environ.get("OPENROUTER_VLM_MODEL", "google/gemini-3-flash-preview"),
    )


def _image_block(image_bytes: bytes) -> dict[str, object]:
    b64 = base64.b64encode(image_bytes).decode("ascii")
    return {
        "type": "image_url",
        "image_url": {"url": f"data:image/jpeg;base64,{b64}", "detail": "low"},
    }


def _parse_judgement(raw: str) -> JudgeResult:
    cleaned = raw.strip()
    match = _SCORE_RE.search(cleaned)
    score = float(match.group(1)) if match else 0.0
    rationale = ""
    try:
        parsed = json.loads(cleaned[cleaned.find("{") : cleaned.rfind("}") + 1])
        if isinstance(parsed, list):  # list-wrapped reply (see llm._coerce_json_dict)
            parsed = next((p for p in parsed if isinstance(p, dict)), {})
        if not isinstance(parsed, dict):
            raise ValueError("non-object judge reply")
        rationale = str(parsed.get("rationale", ""))[:300]
        if "score" in parsed:
            score = float(parsed["score"])
    except Exception:
        rationale = cleaned[:300]
    return JudgeResult(score=score, rationale=rationale, raw=cleaned[:500])


async def _ask_judge(
    system: str, user_text: str, image_blocks: list[dict[str, object]]
) -> JudgeResult:
    from providers import llm

    client = llm._client()
    messages: list[Any] = [
        {"role": "system", "content": system},
        {
            "role": "user",
            "content": [{"type": "text", "text": user_text}, *image_blocks],
        },
    ]
    response = await client.chat.completions.create(
        model=_judge_model(),
        messages=messages,
        temperature=0.0,
        max_tokens=200,
    )
    raw = response.choices[0].message.content or ""
    return _parse_judgement(raw)


async def score_style_pair(image_a: bytes, image_b: bytes) -> JudgeResult:
    system = (
        "You are a strict visual-style judge. Compare two illustrations and "
        "score how well the SECOND image matches the FIRST image's visual "
        "style: medium (flat infographic, watercolor, photoreal, line "
        "drawing, etc.), palette, line work, level of stylization, "
        "perspective. Ignore subject matter — score style only."
        ' Return JSON exactly: {"score": <0-10 number>, "rationale": "<one short sentence>"}.'
    )
    user_text = (
        "Image 1 is the reference style. Image 2 is the candidate. Score "
        "how well image 2 matches image 1's style on a 0-10 scale (10 = "
        "indistinguishable, 0 = completely different medium/palette)."
    )
    return await _ask_judge(
        system, user_text, [_image_block(image_a), _image_block(image_b)]
    )


async def score_entity_consistency(
    entity_name: str, appearance: str, image_a: bytes, image_b: bytes
) -> JudgeResult:
    system = (
        "You are an identity-consistency judge. You are shown two pages of "
        "an illustrated explorable. Both pages should contain the same "
        f"entity: \"{entity_name}\". Stated appearance: \"{appearance}\". "
        "Score 0-10 how confidently the entity in image 2 is visually the "
        "same instance as in image 1: shape, color, proportions, "
        "distinctive features. Score 0 if the entity is absent in image 2."
        ' Return JSON exactly: {"score": <0-10 number>, "rationale": "<one short sentence>"}.'
    )
    user_text = (
        f"Both pages should depict \"{entity_name}\". Score the visual "
        "identity match on a 0-10 scale."
    )
    return await _ask_judge(
        system, user_text, [_image_block(image_a), _image_block(image_b)]
    )


async def score_continuation(region_crop: bytes, candidate: bytes) -> JudgeResult:
    """B3 — visual coherence of an ENTERED place vs the map region it came from.

    Image 1 is a crop of the top-down map (the spot you tapped); image 2 is the
    generated closer/entered view that should be THAT SAME place, just nearer.
    """
    system = (
        "You judge VISUAL CONTINUITY between a map and a closer view. Image 1 is a "
        "cropped region of a top-down map showing a specific place. Image 2 is a "
        "generated closer / entered view that is SUPPOSED to be that same place, "
        "just nearer. Score 0-10 how faithfully image 2 continues image 1: the same "
        "structures, colours, landmarks and layout — recognisably the SAME place, "
        "not a new invention. 10 = unmistakably the same place seen closer; 5 = the "
        "right kind of place but invented details; 0 = an unrelated place."
        ' Return JSON exactly: {"score": <0-10 number>, "rationale": "<one short sentence>"}.'
    )
    user_text = (
        "Image 1 = the map region you entered. Image 2 = the rendered closer view. "
        "Score how faithfully image 2 is a continuation of the SAME place (0-10)."
    )
    return await _ask_judge(
        system, user_text, [_image_block(region_crop), _image_block(candidate)]
    )


async def score_step_in(region_crop: bytes, candidate: bytes) -> JudgeResult:
    """Production twin of score_continuation with the ZOOM DIRECTION made
    explicit. The live failure it exists for: an "enter" edit that redraws
    the WHOLE CITY around the tapped courtyard scores 10/10 on plain
    same-place (a wider view of a place IS that place) and sails through
    the render loop. A step IN must be closer/tighter than its reference —
    wider is a failure even when the place is right. The enter bench keeps
    score_continuation so its committed baseline stays comparable."""
    system = (
        "You judge whether image 2 is a faithful STEP INTO image 1. Image 1 is "
        "a cropped region of a map showing a specific place. Image 2 is a "
        "generated view that is SUPPOSED to be that same place seen CLOSER or "
        "from within — a tighter framing covering LESS area than image 1. "
        "Score 0-10: 10 = unmistakably the same place, clearly closer or "
        "inside; 5 = the same place at roughly the SAME framing (no step in); "
        "0-2 = a different place, OR a WIDER view that shows more area around "
        "the place (zoomed out — e.g. the whole city around a tapped "
        "courtyard). Zooming OUT is a failure no matter how consistent."
        ' Return JSON exactly: {"score": <0-10 number>, "rationale": "<one short sentence>"}.'
    )
    user_text = (
        "Image 1: the tapped map region (the reference). Image 2: the entered "
        "view. Is image 2 that same place seen CLOSER (high) — or the same "
        "framing (5), a wider/zoomed-out view (low), or a different place "
        "(low)? Score 0-10."
    )
    return await _ask_judge(
        system, user_text, [_image_block(region_crop), _image_block(candidate)]
    )


async def score_prompt_alignment(prompt: str, image: bytes) -> JudgeResult:
    system = (
        "You are a prompt-alignment judge. Score on a 0-10 scale how "
        "faithfully the image renders the given prompt. 10 = every "
        "explicit element is present and visually correct, 0 = the image "
        "ignores the prompt. Mention any missing or misrendered elements."
        ' Return JSON exactly: {"score": <0-10 number>, "rationale": "<one short sentence>"}.'
    )
    user_text = f"Prompt:\n{prompt}\n\nScore the rendering on a 0-10 scale."
    return await _ask_judge(system, user_text, [_image_block(image)])


async def score_map_plausibility(
    image: bytes, genre: str, description: str
) -> JudgeResult:
    """Is this a COHERENT, physically plausible map of its genre? The recon
    bench's sanity judge — geometry scores can be high on a map that is
    locally right but globally nonsense (collaged panels, rivers that stop
    dead, three projections at once)."""
    system = (
        "You are a strict cartographic plausibility judge. Score on a 0-10 "
        "scale how much the image reads as ONE coherent, physically "
        "plausible map of the stated genre: a single consistent scale and "
        "projection, connected features (roads, rivers and coasts continue "
        "rather than stopping dead), no impossible geometry, no collaged "
        "panels, lettering (if any) sparse and legible. Ignore artistic "
        "quality — judge coherence only."
        ' Return JSON exactly: {"score": <0-10 number>, "rationale": "<one short sentence>"}.'
    )
    user_text = (
        f"Genre: {genre}. The map is meant to depict: {description[:400]}\n\n"
        "Score the map's plausibility on a 0-10 scale."
    )
    return await _ask_judge(system, user_text, [_image_block(image)])


async def score_view_conformance(image: bytes, projection: str) -> JudgeResult:
    """Does the render actually use the INTENDED projection? (the view grammar's
    conformance judge). Per-projection criteria spelled out so the judge can
    discriminate the hard pair — isometric (parallel verticals, no vanishing
    point) vs oblique perspective (the known iso failure mode, V1 finding 10)."""
    # Calibrated to the PRODUCT promise, not pedantry (first live run scored a
    # genuine castle PLAN 1.5 because map-convention side-view landmarks
    # tripped "no facades"): hand-drawn cartography draws landmarks in
    # elevation on plans, and the iso pill promises the game-art register, not
    # strict axonometry. The hard fails stay hard: a ground-level or wholly
    # tilted view can never pass top_down; ground/top-down can never pass iso.
    criteria = {
        "top_down": (
            "a flat top-down PLAN view: the GROUND LAYOUT reads as a plan — "
            "positions and footprints laid out as seen from straight above, "
            "no horizon, no overall perspective tilt. Hand-drawn map "
            "conventions are FINE and not violations: decorative side-view "
            "landmark drawings, a compass rose, labels. Score low only when "
            "the overall view itself is tilted, perspective, or ground-level"
        ),
        "oblique": (
            "a high-angle oblique aerial view: clearly elevated and tilted "
            "(roughly 30-60 degrees below horizontal), rooftops AND building "
            "facades both visible, NOT straight down and NOT at ground level"
        ),
        "isometric": (
            "an isometric-register illustration: an elevated three-quarter "
            "game-art diorama view — rooftops and facades both visible, the "
            "scene reads as a tilted parallel-ish projection. Ideal = strictly "
            "parallel verticals with no vanishing point; minor perspective "
            "convergence costs a point or two, NOT a failure. Score low only "
            "when the view is ground-level, straight top-down, or a sweeping "
            "wide-angle perspective"
        ),
        "eye_level": (
            "a ground-level first-person view: camera at standing eye height "
            "inside the scene, natural perspective with a visible horizon line, "
            "near things large and far things small"
        ),
    }
    want = criteria.get(projection, projection)
    system = (
        "You are a strict camera-projection judge for illustrations. Classify "
        "the image's actual camera and score 0-10 how well it matches the "
        "INTENDED projection. 10 = unmistakably the intended projection; 5 = "
        "leaning the right way but compromised (e.g. perspective convergence "
        "in a supposed isometric, facades visible in a supposed plan view); "
        "0 = a different projection entirely. Judge geometry only — ignore "
        "subject and art style."
        ' Return JSON exactly: {"score": <0-10 number>, "rationale": "<one '
        'short sentence naming the actual projection and pitch>"}.'
    )
    user_text = (
        f"Intended projection: {projection} — {want}.\n"
        "Score how faithfully the image uses that projection (0-10)."
    )
    return await _ask_judge(system, user_text, [_image_block(image)])


async def score_annotation(
    image: bytes, description: str, labels: list[str]
) -> JudgeResult:
    """Annotation-quality judge — drives the corpus ensemble-annotate auto-promote
    gate (tests/map_corpus/annotate.py). Given the image, the prose meant to let a
    painter redraw it, and the catalogued entity labels, score how COMPLETE and
    ACCURATE the annotation is. The rationale is fed back into the refine pass, so
    it must name what is missing or wrong."""
    named = ", ".join(label.strip() for label in labels if label and label.strip())[:400]
    system = (
        "You are a strict annotation-quality judge for a ground-truth map/scene "
        "corpus. You are given an image, a prose description meant to let a painter "
        "redraw it, and the list of entities that were catalogued. Score 0-10 how "
        "COMPLETE and ACCURATE the annotation is: every prominent feature named and "
        "correctly placed in the prose, no invented features absent from the image, "
        "no major visible feature missed. 10 = a faithful, complete annotation; 5 = "
        "roughly right but missing or misdescribing notable features; 0 = wrong or "
        "badly incomplete. Judge fidelity to the image only — ignore art quality."
        ' Return JSON exactly: {"score": <0-10 number>, "rationale": "<one short '
        'sentence naming what is missing or wrong>"}.'
    )
    user_text = (
        f"Catalogued entities: {named or '(none)'}.\n\nDescription:\n{description[:1200]}\n\n"
        "Score the annotation's completeness and accuracy against the image (0-10)."
    )
    return await _ask_judge(system, user_text, [_image_block(image)])


async def score_feature_articulation(
    image: bytes, place_label: str, features: list[str]
) -> JudgeResult:
    """The richness critic — does the render ARTICULATE the place's interior
    structure, or did it collapse into a sealed/simplified mass? Closes the
    render loop's critic gap: a retry that fixed the projection while roofing
    over the bailey scored 10/10 on the other axes (the Goodhart failure this
    judge exists to catch)."""
    named = "; ".join(f.strip() for f in features if f and f.strip())[:300]
    system = (
        "You judge STRUCTURAL RICHNESS of an illustrated place. Score 0-10 "
        "how well the image articulates the place's internal structure: "
        "courtyards and open compounds drawn OPEN with their inner buildings "
        "visible, distinct sub-structures distinguishable, walls/gates/towers "
        "individually drawn. 10 = richly articulated interior; 5 = the right "
        "outline but the inside is mostly empty or generic; 0 = the place is "
        "sealed into one simplified mass (e.g. a compound covered by a single "
        "invented roof) or its interior is blank. Judge structure only — "
        "ignore art style and camera angle."
        ' Return JSON exactly: {"score": <0-10 number>, "rationale": "<one short sentence>"}.'
    )
    user_text = (
        f'The place is "{place_label}".'
        + (f" Expected interior features: {named}." if named else "")
        + " Score how richly its internal structure is articulated (0-10)."
    )
    return await _ask_judge(system, user_text, [_image_block(image)])
