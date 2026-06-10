"""VLM-judge scoring for the continuity bench.

Three metrics, all rendered through a VLM-as-judge against pairs/triples
of (image, image) or (image, text):

  - style_drift: 0..10, "are these two images in the same visual style?"
  - entity_consistency: 0..10, "do these crops depict the same X?"
  - prompt_alignment: 0..10, "does this image render this prompt?"

The judge VLM is configurable via CONTINUITY_BENCH_JUDGE_MODEL (defaults
to the same VLM the resolver uses). Each judgement returns a score plus
a short free-text rationale so the bench output is human-readable.
"""

from __future__ import annotations

import base64
import json
import os
import re
from dataclasses import dataclass

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
    response = await client.chat.completions.create(
        model=_judge_model(),
        messages=[
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": [{"type": "text", "text": user_text}, *image_blocks],
            },
        ],
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


async def score_view_conformance(image: bytes, projection: str) -> JudgeResult:
    """Does the render actually use the INTENDED projection? (the view grammar's
    conformance judge). Per-projection criteria spelled out so the judge can
    discriminate the hard pair — isometric (parallel verticals, no vanishing
    point) vs oblique perspective (the known iso failure mode, V1 finding 10)."""
    criteria = {
        "top_down": (
            "a FLAT top-down plan view: looking straight down, rooftops only, "
            "no building facades visible, no horizon, no perspective tilt"
        ),
        "oblique": (
            "a high-angle oblique aerial view: clearly elevated and tilted "
            "(roughly 30-60 degrees below horizontal), rooftops AND building "
            "facades both visible, NOT straight down and NOT at ground level"
        ),
        "isometric": (
            "a true isometric/axonometric illustration: parallel projection — "
            "vertical lines stay parallel, NO vanishing point, no perspective "
            "convergence, no horizon; an elevated three-quarter game-art view"
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
