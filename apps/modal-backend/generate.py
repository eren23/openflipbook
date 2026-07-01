"""Endless Canvas — page generation service (FastAPI on Modal).

Exposes `POST /sse/generate` as an SSE stream. The Next.js web app proxies to
this endpoint. Flow:

1. If `mode == "tap"`, resolve click coords to a subject phrase via the VLM.
2. Plan the page (title, prompt, facts) via the text LLM with optional
   `:online` web search.
3. Call fal-ai nano-banana with the composed prompt.
4. Emit SSE events: `progress` (placeholder, for future progressive models)
   and `final` with the base64 JPEG and metadata.
"""

from __future__ import annotations

import asyncio as _asyncio
import base64
import contextlib
import hashlib
import json
import os
import threading as _threading
import time as _time_mod
from collections import OrderedDict
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TYPE_CHECKING, Any, cast

import modal

if TYPE_CHECKING:
    # Type-only — the providers are imported lazily at the call sites (Modal cold
    # start cost), but mypy needs the shapes to check the geometry boundary and the
    # render/edit-loop accumulators. The geometry TypedDict is aliased to avoid
    # clashing with this module's Pydantic `ProjectedEntity` wire model (same shape;
    # model_dump() yields the TypedDict).
    from providers.detector import Detection
    from providers.edit_loop import EditAttempt
    from providers.geometry import ProjectedEntity as ProjectedEntityDict
    from providers.judge import JudgeResult
    from providers.render_loop import Attempt
    from providers.view_estimator import ViewEstimate
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from _env import env_flag

APP_NAME = "openflipbook-generate"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install_from_requirements("requirements.txt")
    .add_local_python_source("providers")
    .add_local_python_source("obs")
    .add_local_python_source("_env")
)

secrets = [
    modal.Secret.from_name(
        "openflipbook-secrets",
        required_keys=["FAL_KEY", "OPENROUTER_API_KEY"],
    )
]

app = modal.App(APP_NAME, image=image)
fastapi_app = FastAPI(title="Endless Canvas — generate")

# ── Public-deploy safety (Wave 5; all default OFF) ───────────────────────────
SHARED_TOKEN_HEADER = "x-openflipbook-token"


@fastapi_app.middleware("http")
async def _shared_token_gate(request: Request, call_next: Any) -> Any:
    """SHARED_TOKEN (env, unset = open): when set, every endpoint except
    /health requires the matching header. The web's server-side proxies
    inject it (lib/modal.modalAuthHeaders); browsers never hold the token."""
    token = os.environ.get("SHARED_TOKEN")
    if (
        token
        and request.url.path != "/health"
        and request.headers.get(SHARED_TOKEN_HEADER) != token
    ):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return await call_next(request)


def _client_ip(req: Request) -> str:
    forwarded = req.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    # getattr: a malformed/mocked request may lack `.client` — never crash the
    # rate-limit pre-flight over a missing attribute (it just buckets as anon).
    client = getattr(req, "client", None)
    return client.host if client else "unknown"


def _rate_limited(req: Request) -> JSONResponse | None:
    """RATE_LIMIT_RPM (env, 0/unset = off): per-IP token bucket on the
    spendy endpoints. Returns the 429 to send, or None to proceed."""
    from providers import ratelimit

    if ratelimit.allow(_client_ip(req)):
        return None
    return JSONResponse(
        {"error": "rate limited — slow down (RATE_LIMIT_RPM)"}, status_code=429
    )


def _paid_guard(
    req: Request, trace_id: str, session_id: str | None = None
) -> JSONResponse | None:
    """Pre-flight for the NON-streaming paid endpoints (extract / edit / plan /
    precompute): per-IP rate limit + the daily/session spend cap. The streaming
    /sse/generate path has its own inline gate. Returns the response to send, or
    None to proceed. Both controls default off (env unset)."""
    limited = _rate_limited(req)
    if limited is not None:
        return limited
    from providers import spend

    reason = spend.over_cap(session_id)
    if reason is not None:
        return JSONResponse(
            {
                "error": f"spend cap reached — {reason}. "
                "Raise/unset MAX_DAILY_SPEND / MAX_SESSION_SPEND to continue.",
                "trace_id": trace_id,
            },
            status_code=429,
            headers={"X-Trace-Id": trace_id},
        )
    return None


class Click(BaseModel):
    x_pct: float = Field(ge=0.0, le=1.0)
    y_pct: float = Field(ge=0.0, le=1.0)


class EditRegion(BaseModel):
    """The drag-selected area of a mask-scoped edit (EDIT_REGION), normalized
    to natural-image space. Mirrors `edit_region` on the TS request body; the
    mask PNG is authoritative for the model, this box scopes the judge crop."""

    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    w: float = Field(gt=0.0, le=1.0)
    h: float = Field(gt=0.0, le=1.0)


class WorldContextEntity(BaseModel):
    id: str
    kind: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    appearance: str
    reference_image_url: str | None = None
    # Mirrors EntityState in packages/config: a key/value bag whose values are
    # primitives only (door=open, lantern=lit, mira_present=true). The tightened
    # union (not dict[str, Any]) keeps the TS<->Py schema-parity check meaningful.
    state: dict[str, str | int | float | bool] = Field(default_factory=dict)
    # Optional geometric size carried from the entity's WorldEntityGeo so
    # the planner can keep recurring entities at a consistent relative scale.
    # Mirrors the TS `footprint?: {w,d}` / `height?` (schema-parity gated).
    footprint: dict[str, float] | None = None
    height: float | None = None
    # Compass phrase from the entity's top-level map geo ("the north-west of
    # the map") — the spatial half of continuity. Rendered as a fixed-position
    # instruction so landmarks stop relocating between pages (the palace-on-
    # the-riverbank drift). Omitted → appearance-only continuity, as today.
    location_hint: str | None = None


# Geometric world model — Pydantic mirrors of the packages/config TS shapes.
# Must stay in field-parity with index.ts; the schema-parity check guards drift.
class WorldVec2(BaseModel):
    x: float
    y: float


class ObserverPose(BaseModel):
    pos: WorldVec2
    eye_height: float
    gaze: float
    pitch: float = 0.0
    fov: float


class MapCrop(BaseModel):
    x: float
    y: float
    w: float
    h: float


class ViewSpec(BaseModel):
    """Render-intent camera spec (the view grammar), persisted on SceneView.

    Distinct from the view ESTIMATOR's read-out of a generated image
    (view_estimator.ViewEstimate); the estimator's "perspective" maps to
    "eye_level" here via prompt_library.policy. Absent on legacy nodes ⇒ the
    pre-grammar hardcoded behavior, byte-identical."""

    projection: str  # top_down | oblique | isometric | eye_level
    pitch_deg: float | None = None
    azimuth_deg: float | None = None
    # Qualitative register ("ground"/"eye"/"rooftop"/"aerial") or metric height.
    camera_height: str | float | None = None
    fov_deg: float | None = None
    source: str = "policy"  # policy | user | estimated


class SceneView(BaseModel):
    node_id: str
    level: str
    observer: ObserverPose | None = None
    map_crop: MapCrop | None = None
    # Closeup rung (tap descent ladder): this frame is a TIGHT zoom on
    # focus_id — the next tap on that entity transitions (enters) instead of
    # zooming again. Mirrors the optional TS field (schema-parity gated).
    closeup: bool | None = None
    # The entity you ENTERED to get here (the tapped place's geo id). geo-tap.ts
    # sets it and the extract route reads it to anchor the child frame; without
    # it the field was silently dropped on validation, breaking the round-trip.
    focus_id: str | None = None
    # Coarse SCALE_LADDER rung for this view (B2 scale navigation). Mirrors the
    # optional `scale_tier?` on the TS SceneView; a free str so the ladder lives
    # in one place (packages/config).
    scale_tier: str | None = None
    # The deliberate camera for this render (the view grammar). None ⇒ legacy.
    view: ViewSpec | None = None
    # How many times this place has already been entered (the client's revisit
    # count). >0 rotates the scene camera to another angle under
    # ENTER_AZIMUTH_ROTATE; None/0 is byte-identical. Mirrors the optional TS
    # `enter_index?` (schema-parity gated).
    enter_index: int | None = None


class ProjectedEntity(BaseModel):
    id: str
    label: str
    x_pct: float
    y_pct: float
    w_pct: float
    h_pct: float
    depth: float
    h_pos: str
    v_pos: str
    size: str


class GenerateBody(BaseModel):
    query: str
    aspect_ratio: str = "16:9"
    web_search: bool = True
    session_id: str
    current_node_id: str = ""
    mode: str = "query"
    image: str | None = None
    parent_query: str | None = None
    parent_title: str | None = None
    click: Click | None = None
    click_hint: str | None = None
    image_tier: str | None = None
    image_model: str | None = None
    # Per-request loop control (the speed preset). Absent -> today's env
    # defaults, byte-identical. verify=False skips the judged loops for this
    # request (the proven one-shot paths, user-chosen); max_attempts clamps
    # to the loops' hard cap server-side.
    max_attempts: int | None = None
    verify: bool | None = None
    edit_instruction: str | None = None
    # Mask-scoped edit (EDIT_REGION, default off): an opaque PNG data URL at
    # the page's natural dims, WHITE = edit / black = keep, plus the selection
    # box that produced it. Absent -> the legacy whole-image edit path,
    # byte-identical to today.
    edit_mask: str | None = None
    edit_region: EditRegion | None = None
    output_locale: str | None = None
    prefetched_subject: str | None = None
    prefetched_style: str | None = None
    prefetched_subject_context: str | None = None
    # World Mode semi-autonomy already resolved the tap client-side; this carries
    # the resolver's spatial-anchor note back so the planner can keep the
    # entered place's neighbours where the parent map had them.
    prefetched_surroundings: str | None = None
    # Sightline-culled surroundings (client geometry: the observer pose's view
    # frustum decided what is in sight). When true, prefetched_surroundings is
    # VIEW-relative (frame positions, not map bearings) and surroundings_behind
    # lists the mapped landmarks that are NOT visible — banned from the
    # backdrop by name. Absent -> legacy map-bearing wording (parity).
    surroundings_pov: bool = False
    surroundings_behind: str | None = None
    # Multi-turn refer (SAMA / MM-Conv pattern): when the user rejects a
    # resolved subject and taps again nearby, the client forwards the
    # rejected phrase so the VLM picks something different.
    prior_rejected_subject: str | None = None
    session_style_anchor: str | None = None
    # World-memory continuity. Web proxy resolves a slim slice of the session's
    # registry before forwarding; planner injects each entity's `appearance`
    # into the image prompt so recurring characters / places stay visually
    # consistent across pages. Capped server-side.
    world_context: list[WorldContextEntity] = Field(
        default_factory=list, max_length=16
    )
    # Image conditioning — ordered reference data URLs (region crop → parent →
    # anchor) the generator blends so the page stays in the same world.
    # `condition_roles` labels each url in order. Built client-side. Capped.
    condition_image_urls: list[str] | None = Field(default=None, max_length=4)
    condition_roles: list[str] | None = None
    # World Mode (gated server-side by the WORLD_MODE env). When on, a tap
    # ENTERS the tapped place (scene / closer sub-map) instead of explaining a
    # topic. `render_mode` is an explicit framing override; otherwise the click
    # classifier's `enter_as` decides. `autonomy` is carried for symmetry.
    world_mode: bool = False
    # DOM-labels mode (NEXT_PUBLIC_DOM_LABELS): map/explainer renders carry
    # NO baked text — names ride a client overlay built from entity data.
    # Optional + default False: old clients omit it, prompts byte-identical.
    suppress_map_labels: bool = False
    # The transition tap's origin (tap descent ladder): the SOURCE frame was a
    # closeup of the entered place — the establishing shot already happened,
    # so the enter descends to ground level instead of another aerial.
    from_closeup: bool = False
    autonomy: str = "auto"
    render_mode: str | None = None
    # B2 logical AROUND (SCALE_AROUND_LOGICAL): the same-scale neighbours the client
    # already knows from geometry (to exclude) + the focus's rung, so the expand
    # bloom proposes NEW peers at that scale. Ignored unless the flag is on.
    known_neighbors: list[str] | None = None
    around_tier: str | None = None
    # Geometric world (GEOMETRIC_WORLD): the scene's observer pose/level + the
    # geometry engine's expected per-entity layout for this frame.
    scene_view: SceneView | None = None
    expected_layout: list[ProjectedEntity] = Field(default_factory=list)
    trace_id: str | None = None


# World Mode is gated behind an env flag (default off) so it's a no-op in prod
# until a deployer turns it on — like EXPAND_MAP_PAN / IMAGE_CONDITIONING.
def _world_mode_on(requested: bool) -> bool:
    return bool(requested) and env_flag("WORLD_MODE")


def _segment_borders_on() -> bool:
    """Fill per-node SAM3 border polygons during extraction (WORLD_SEGMENT_BORDERS).
    Pairs with SEGMENTER_PROVIDER=sam3_fal to get pixel-accurate outlines in the
    live overlay; off → only the detector box is known (current behaviour)."""
    return env_flag("WORLD_SEGMENT_BORDERS")


def _grounding_sam3_on() -> bool:
    """Tighten the grounding loop's detector boxes to SAM3 mask bboxes
    (GROUNDING_SAM3). Pairs with SEGMENTER_PROVIDER=sam3_fal; off → box-level
    grounding (current behaviour)."""
    return env_flag("GROUNDING_SAM3")


def _geometric_world_on() -> bool:
    """Master gate for the geometric world (GEOMETRIC_WORLD). Off → the geo
    endpoints (e.g. /edit-entities) are disabled and behave as if absent."""
    return env_flag("GEOMETRIC_WORLD")


def _world_geometry_gen_on(world_mode: bool = False) -> bool:
    """Geometry steers generation (WORLD_GEOMETRY_GEN). Defaults ON under an
    active world mode — the layout clause is the only thing pinning the map's
    geography, and without it entered scenes relocate landmarks freely — and
    OFF otherwise (non-world prompts stay byte-identical). An explicit
    =false is a kill-switch everywhere."""
    return env_flag("WORLD_GEOMETRY_GEN", "true" if world_mode else "false")


def _condition_url_for_role(body: GenerateBody, role: str) -> str | None:
    """The first condition image URL tagged with `role` (e.g. "style"), or None.
    Lets the edit path pull the style exemplar the client already sends in the
    condition stack (condition_image_urls / condition_roles, same index)."""
    urls = body.condition_image_urls or []
    roles = body.condition_roles or []
    for u, r in zip(urls, roles, strict=False):
        if r == role and u:
            return u
    return None


def _layout_clause_for(body: GenerateBody, *, view_grammar: bool = False) -> str:
    """The geometry layout-constraint clause for this request, or "" when the
    geometry-gen flag is off or no expected layout was sent. Under the view
    grammar the research/09 extensions activate: depth layers (free — depths
    already ride expected_layout) + relative heights from world_context
    entries with REAL heights (the extraction seed constant 4.0 is excluded —
    the A1 audit's information-loss fix, V1 must-fix 9)."""
    if not _world_geometry_gen_on(_world_mode_on(body.world_mode)) or not body.expected_layout:
        return ""
    from providers import geometry_prompt

    # model_dump() erases the static type, but a ProjectedEntity Pydantic model
    # dumps to exactly the ProjectedEntity TypedDict shape the prompt consumes.
    expected = cast(
        "list[ProjectedEntityDict]", [e.model_dump() for e in body.expected_layout]
    )
    if not view_grammar:
        return geometry_prompt.layout_constraints(expected)
    return geometry_prompt.layout_constraints(
        expected, depth_layers=True, heights=_heights_for_view(body)
    )


def _heights_for_view(body: GenerateBody) -> list[tuple[str, float, str]] | None:
    """Relative-height pairs (label, ratio, anchor) from world_context entries
    with REAL heights. The extraction seed gives EVERY entity height=4 (A1
    audit), so 4.0 is treated as no-data; needs >=2 real values to compare.
    Anchor = the shortest real-height entity (one shared anchor, research/09)."""
    real: list[tuple[str, float]] = []
    for e in body.world_context:
        d = e.model_dump()
        h = d.get("height")
        name = str(d.get("name") or "").strip()
        if name and isinstance(h, (int, float)) and h > 0 and float(h) != 4.0:
            real.append((name, float(h)))
    if len(real) < 2:
        return None
    real.sort(key=lambda t: t[1])
    anchor_name, anchor_h = real[0]
    return [(n, h / anchor_h, anchor_name) for n, h in real[1:]]


def _same_place_judge(judge_mod: Any) -> Any:
    """The render loop's same-place axis. Default: the zoom-aware step-in
    judge (a city-wide redraw of a tapped courtyard scores 10/10 on plain
    same-place — a wider view of a place IS that place — and sailed through
    the loop live). ENTER_STEP_IN_JUDGE=false reverts byte-for-byte to the
    plain continuation judge."""
    if env_flag("ENTER_STEP_IN_JUDGE", "true"):
        return judge_mod.score_step_in
    return judge_mod.score_continuation


def _view_grammar_on() -> bool:
    """The view grammar (a deliberate camera per render). Default ON; =false
    is a strict kill-switch — every render byte-identical to pre-grammar."""
    return env_flag("VIEW_GRAMMAR", "true")


# Words that carry no identity — dropped before token comparison so "the
# palace of the patrician" still meets "Patrician's Palace". Twin of the
# client's entity-label-match.ts STOP_WORDS.
_LABEL_STOP_WORDS = frozenset(
    {"the", "a", "an", "of", "and", "its", "their", "in", "on", "at"}
)


def _normalize_label(s: str) -> str:
    """lowercase → strip diacritics → strip punctuation → collapse spaces.
    Apostrophes are REMOVED (not space-split) so "Patrician's" folds to
    "patricians" rather than shedding a stray "s" token."""
    import unicodedata

    folded = unicodedata.normalize("NFKD", s.lower())
    # U+2019 = the curly apostrophe.
    folded = folded.replace("'", "").replace("\u2019", "")
    stripped = "".join(c for c in folded if not unicodedata.combining(c))
    alnum = "".join(c if c.isalnum() else " " for c in stripped)
    return " ".join(alnum.split())


def _label_tokens(s: str) -> list[str]:
    return [t for t in _normalize_label(s).split() if t not in _LABEL_STOP_WORDS]


def _match_world_entity(
    entities: list[WorldContextEntity], subject: str | None
) -> dict | None:
    """W2 label-click routing, server half (covers autonomy="auto", where the
    click resolve runs in-band). The resolved subject names a mapped PLACE —
    the tap landed on the map's baked-in lettering rather than the footprint.
    Exact or token-containment match over normalized name/aliases, places
    only; the semi-autonomy client does its own (fuzzier) match in
    entity-label-match.ts before the request."""
    subj_norm = _normalize_label(subject or "")
    subj_tokens = _label_tokens(subject or "")
    if not subj_norm or not subj_tokens:
        return None
    subj_set = set(subj_tokens)
    best: dict | None = None
    best_score = 0
    for e in entities:
        d = e.model_dump()
        if str(d.get("kind") or "") != "place":
            continue
        names = [str(d.get("name") or "")] + [
            str(a) for a in (d.get("aliases") or [])
        ]
        for name in names:
            name_norm = _normalize_label(name)
            name_tokens = _label_tokens(name)
            if not name_norm or not name_tokens:
                continue
            if name_norm == subj_norm:
                score = 2
            else:
                # Either direction: a subject "patrician's palace and its
                # gardens" contains the label; a clipped subject "the river"
                # is contained by "The River Ankh".
                name_set = set(name_tokens)
                contained = all(t in subj_set for t in name_tokens) or all(
                    t in name_set for t in subj_tokens
                )
                score = 1 if contained else 0
            if score > best_score:
                best_score = score
                best = d
        if best_score == 2:
            break
    return best


def _focus_world_entry(body: GenerateBody, subject: str | None) -> dict | None:
    """The world_context entry for the tapped place: focus_id match first,
    else name/alias equality against the resolved subject (pre-hint)."""
    sv = body.scene_view
    focus_id = sv.focus_id if sv else None
    subj = (subject or "").strip().lower()
    for e in body.world_context:
        d = e.model_dump()
        if focus_id and d.get("id") == focus_id:
            return d
        names = [str(d.get("name") or "").strip().lower()] + [
            str(a).strip().lower() for a in (d.get("aliases") or [])
        ]
        if subj and subj in names:
            return d
    return None


def _view_spec_for(
    body: GenerateBody,
    render_mode: str,
    *,
    world_mode: bool,
    has_region: bool,
    subject: str | None,
    subject_context: str | None,
    place_form: str | None,
) -> dict | None:
    """Resolve the deliberate camera: user/persisted pin > policy > None.
    VIEW_GRAMMAR=false -> None unconditionally (the strict kill-switch:
    byte-identical legacy renders, V1 must-fix 3)."""
    if not _view_grammar_on():
        return None
    sv = body.scene_view
    if sv and sv.view is not None:
        return sv.view.model_dump(exclude_none=True)
    from providers.prompt_library import policy as view_policy

    focus = _focus_world_entry(body, subject)
    fp: tuple[float, float] | None = None
    if focus and isinstance(focus.get("footprint"), dict):
        f = focus["footprint"]
        if f.get("w") and f.get("d"):
            fp = (float(f["w"]), float(f["d"]))
    # Another-angle on re-enter (flag-gated OFF): the client's revisit count
    # rotates a scene enter to a new side. Off ⇒ 0 ⇒ byte-identical.
    enter_index = (
        int(sv.enter_index)
        if sv and sv.enter_index and sv.enter_index > 0 and env_flag("ENTER_AZIMUTH_ROTATE")
        else 0
    )
    return cast(
        "dict | None",
        view_policy.default_view(
            render_mode=render_mode or None,
            world_mode=world_mode,
            level=sv.level if sv else None,
            scale_tier=sv.scale_tier if sv else None,
            has_observer=bool(sv and sv.observer is not None),
            has_region=has_region,
            place_form=place_form,
            from_closeup=bool(body.from_closeup),
            subject=subject,
            subject_context=subject_context,
            focus_kind=str(focus.get("kind") or "") if focus else None,
            focus_footprint=fp,
            enter_index=enter_index,
        ),
    )


def _camera_clause_for(body: GenerateBody, view: dict | None) -> str:
    """The deliberate-camera clause for composed (fresh-path) prompts."""
    if view is None:
        return ""
    from providers import image as image_provider
    from providers.prompt_library import camera as camera_lib
    from providers.prompt_library.types import ViewSpec as ViewSpecDict

    sv = body.scene_view
    obs = sv.observer.model_dump() if sv and sv.observer else None
    medium = (body.session_style_anchor or "").strip() or None
    family = camera_lib.model_family(
        image_provider._resolve_model(body.image_tier, body.image_model)
    )
    from providers.geometry import ObserverPose as ObserverPoseDict

    return camera_lib.camera_clause(
        cast("ViewSpecDict", view),
        cast("ObserverPoseDict | None", obs),
        medium=medium,
        family=family,
    )


def _layout_register_mismatch(body: GenerateBody, view: dict | None) -> bool:
    """expected_layout bins are projected for a SPECIFIC camera (observer
    present -> the synthesized eye-level perspective; absent -> top-down).
    When the deliberate view names a DIFFERENT register, the bins are
    wrong-camera noise — suppress the clause AND grounding rather than steer
    and repair against the wrong camera (V1 must-fix 5; the A2 probe showed
    bins swing wildly with pose)."""
    if view is None or not body.expected_layout:
        return False
    proj = str(view.get("projection") or "")
    sv = body.scene_view
    if sv is not None and sv.observer is not None:
        return proj != "eye_level"
    return proj != "top_down"


def _topdown_clause_for(body: GenerateBody) -> str:
    """Force a flat top-down map render (WORLD_TOPDOWN_MAPS). A genuine overhead
    map makes bbox→world geometry EXACT (the box IS the footprint) instead of
    guessing an oblique camera — the metric path. Only applies to MAP renders (a
    fresh world or an explicit map_crop view); a scene/observer render is left
    alone. Off (default) keeps the model's usual, often-2.5D, map aesthetic."""
    if not env_flag("WORLD_TOPDOWN_MAPS"):
        return ""
    sv = body.scene_view
    is_map = sv is None or (sv.observer is None and sv.level == "map")
    if not is_map:
        return ""
    return (
        "Render this as a FLAT TOP-DOWN overhead map — orthographic, looking "
        "straight down, NO perspective or isometric tilt — so every place sits "
        "at an unambiguous map position."
    )


def _vlm_grounding_on() -> bool:
    """Verify the rendered frame against the expected layout (VLM_GROUNDING).
    Off → no detector call, `final` carries no grounding summary."""
    return env_flag("VLM_GROUNDING")


def _vlm_grounding_repair_on() -> bool:
    """Let the grounding loop attempt a corrective edit (VLM_GROUNDING_REPAIR).
    Off → verify-only: report the diff, never mutate the image."""
    return env_flag("VLM_GROUNDING_REPAIR")


def _grounding_summary(
    report: Any, *, repaired: bool, iterations: int
) -> dict[str, Any]:
    """The compact grounding payload attached to the `final` event. `repaired`
    means the returned image IS a kept corrective edit (not merely that one was
    attempted) — a discarded / no-improvement repair reports False."""
    return {
        "score": round(report.score, 3),
        "mean_iou": round(report.mean_iou, 3),
        "matched": [m.label for m in report.matched],
        "missing": list(report.missing),
        "extra": list(report.extra),
        "repaired": repaired,
        "iterations": iterations,
    }


async def _run_grounding(
    result: Any,
    expected: list[ProjectedEntityDict],
    *,
    repair_on: bool,
    abort: Callable[[str], Awaitable[None]],
    accept_threshold: float = 0.7,
) -> tuple[Any, dict[str, Any] | None]:
    """Verify the render against the expected layout (and optionally repair it),
    returning the best image + a summary. Fully best-effort: ANY failure (detector
    error/429, edit error) degrades to (original image, None) so grounding can
    never break generation. The bounded loop itself is unit-tested in
    test_repair_loop.py; this wires the live detector + edit into it."""
    from providers import detector, geometry_prompt, grounding
    from providers import image as image_provider
    from providers import image_edit as image_edit_provider

    labels = [
        lbl
        for lbl in dict.fromkeys(
            str(e.get("label") or e.get("id") or "") for e in expected
        )
        if lbl
    ]
    if not labels:
        return result, None

    async def _verify(img: Any) -> Any:
        observed = await detector.detect(img.jpeg_bytes, labels)
        if _grounding_sam3_on():
            try:
                from providers.segmenter import refine_detections_with_masks, segment

                segs = await segment(
                    img.jpeg_bytes, labels, boxes=cast("list[dict[str, Any]]", observed)
                )
                observed = cast(
                    "list[Detection]",
                    refine_detections_with_masks(
                        cast("list[dict[str, Any]]", observed),
                        cast("list[dict[str, Any]]", segs),
                    ),
                )
            except Exception:  # best-effort: a SAM3 failure keeps the detector boxes
                pass
        return grounding.diff(expected, observed)

    async def _repair(img: Any, report: Any) -> Any | None:
        misplaced = [m.label for m in report.matched if not m.pos_ok]
        instruction = geometry_prompt.repair_instruction(
            expected, list(report.missing), misplaced
        )
        if not instruction:
            return None
        await abort("grounding-repair")
        data_url = image_provider.encode_data_url(img.jpeg_bytes, img.mime_type)
        return await image_edit_provider.edit_image(data_url, instruction)

    # Verify-only ⇒ inpaint_budget=0 so the loop never even calls the edit model
    # (no fal spend, iterations stays 0). Repair-on uses the default budget.
    budget = grounding.Budget() if repair_on else grounding.Budget(inpaint_budget=0)
    try:
        loop_res = await grounding.run_grounding_loop(
            result,
            verify=_verify,
            repair=_repair,
            accept_threshold=accept_threshold,
            budget=budget,
        )
    except Exception as exc:
        # Grounding is strictly best-effort — a detector 429 or edit failure must
        # never break generation, so any error degrades to (original, no summary).
        from obs import log

        log("info", "grounding.failed", error=f"{type(exc).__name__}: {exc}")
        return result, None
    # `repaired` = the kept image differs from what we rendered (a corrective edit
    # actually survived), not merely that a repair was attempted.
    return loop_res.image, _grounding_summary(
        loop_res.report,
        repaired=loop_res.image is not result,
        iterations=loop_res.iterations,
    )


# The click classifier's `enter_as` → the planner's render mode.
_ENTER_AS_TO_RENDER: dict[str, str] = {
    "scene": "place_scene",
    "submap": "place_submap",
    "explainer": "explainer",
}


def _sse(data: dict, trace_id: str | None = None) -> bytes:
    """Encode an SSE event. Trace ID rides on every payload so the browser
    can stamp it on its perf-HUD timeline without needing a side channel."""
    if trace_id and "trace_id" not in data:
        data = {**data, "trace_id": trace_id}
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode()


async def _with_heartbeat(
    stream: AsyncIterator[bytes], interval_s: float = 15.0
) -> AsyncIterator[bytes]:
    """Keep a long, SILENT SSE generation alive. While the underlying stream is
    mid-await — e.g. a 2-3 min riverflow image gen with no frames — emit an SSE
    keepalive comment every `interval_s` so an intermediary's idle/body timeout
    (the Next proxy's undici 300s UND_ERR_BODY_TIMEOUT, nginx, a load balancer)
    doesn't guillotine the connection. Comment lines (`:`) are ignored by SSE
    clients (the play page parser skips any chunk not starting with `data:`)."""
    pending = _asyncio.ensure_future(stream.__anext__())
    try:
        while True:
            done, _ = await _asyncio.wait({pending}, timeout=interval_s)
            if not done:
                yield b": keepalive\n\n"
                continue
            try:
                item = pending.result()
            except StopAsyncIteration:
                return
            yield item
            pending = _asyncio.ensure_future(stream.__anext__())
    finally:
        if not pending.done():
            pending.cancel()
        aclose = getattr(stream, "aclose", None)
        if aclose is not None:
            with contextlib.suppress(Exception):
                await aclose()


_FRAME_DIMS: dict[str, tuple[int, int]] = {
    "16:9": (1600, 900), "9:16": (900, 1600), "1:1": (1024, 1024),
    "4:3": (1280, 960), "3:4": (960, 1280),
}


def _frame_dims(aspect_ratio: str) -> tuple[int, int]:
    """Pixel (width, height) for an aspect-ratio slug; 16:9 default."""
    return _FRAME_DIMS.get(aspect_ratio, (1600, 900))


def _err_json(exc: Exception, trace_id: str, *, status: int = 502) -> JSONResponse:
    """The endpoint error envelope shared by every handler. The caller still
    record_error()s with its own label before returning this."""
    return JSONResponse(
        {"error": f"{type(exc).__name__}: {exc}", "trace_id": trace_id},
        status_code=status,
        headers={"X-Trace-Id": trace_id},
    )


def _gate_json(message: str, trace_id: str) -> JSONResponse:
    """403 envelope for a disabled feature-flag gate."""
    return JSONResponse(
        {"error": message, "trace_id": trace_id},
        status_code=403,
        headers={"X-Trace-Id": trace_id},
    )


_RECENT_GENERATE_TTL_S = 30.0
_RECENT_GENERATES: OrderedDict[str, float] = OrderedDict()
# Same posture as providers/spend.py: module state stays correct if anyone
# ever runs this app with threaded workers.
_RECENT_GENERATES_LOCK = _threading.Lock()


def _note_duplicate_generate(body: GenerateBody) -> bool:
    """True when an identical generate (same session/node/mode/query and
    click bucket) arrived within the TTL. The web's in-flight guard should
    make this impossible — so it's worth a loud log line when it isn't —
    but a deliberate user retry is legitimate, hence log-only, never a
    block."""
    click = body.click
    bucket = (
        f"{round(click.x_pct * 20)}:{round(click.y_pct * 20)}" if click else "-"
    )
    raw = "|".join(
        [
            body.session_id,
            body.current_node_id,
            body.mode,
            bucket,
            (body.query or "")[:200],
            (body.edit_instruction or "")[:200],
            # A re-run at a different tier/model is a deliberate choice, not
            # a stutter — keep it out of the duplicate bucket.
            body.image_tier or "",
            body.image_model or "",
        ]
    )
    key = hashlib.sha1(raw.encode()).hexdigest()
    now = _time_mod.monotonic()
    with _RECENT_GENERATES_LOCK:
        seen = _RECENT_GENERATES.get(key)
        _RECENT_GENERATES[key] = now
        _RECENT_GENERATES.move_to_end(key)
        while len(_RECENT_GENERATES) > 256:
            _RECENT_GENERATES.popitem(last=False)
    return seen is not None and (now - seen) < _RECENT_GENERATE_TTL_S


async def _event_stream(
    body: GenerateBody,
    trace_id: str,
    is_disconnected: Callable[[], Awaitable[bool]] | None = None,
) -> AsyncIterator[bytes]:
    import time as _time

    from obs import bind_trace, log, record_error
    from providers import image as image_provider
    from providers import image_edit as image_edit_provider
    from providers import llm, model_router, spend

    bind_trace(trace_id)
    started = _time.perf_counter()
    log("info", "sse.generate.start", mode=body.mode, locale=body.output_locale)

    # Observability for client-guard regressions: the web's in-flight ref
    # should make identical back-to-back generates impossible — if one shows
    # up anyway, say so loudly (log-only; never blocks a legitimate retry).
    if _note_duplicate_generate(body):
        log("warn", "sse.generate.duplicate", mode=body.mode)

    # The daily spend gate (MAX_DAILY_SPEND, providers/spend.py): refuse with
    # a clean error frame BEFORE any model call once today's estimate crosses
    # the cap. Absent/0 -> uncapped, byte-identical to before.
    if spend.cap_exceeded():
        log(
            "warn",
            "sse.generate.spend_capped",
            daily=round(spend.daily_total(), 2),
            cap=spend.daily_cap(),
        )
        yield _sse(
            {
                "type": "error",
                "message": (
                    "Daily spend cap reached (≈$"
                    f"{spend.daily_total():.2f} of MAX_DAILY_SPEND=$"
                    f"{spend.daily_cap():.2f}). Raise or unset MAX_DAILY_SPEND "
                    "to continue."
                ),
            },
            trace_id,
        )
        return

    async def _abort_if_disconnected(stage: str) -> None:
        """Raise CancelledError when the client has dropped the SSE socket.

        FastAPI exposes `Request.is_disconnected()` which polls the underlying
        asgi receive channel. Calling it between expensive stages means a
        client `AbortController.abort()` actually halts the planner / image-gen
        path instead of letting it run to completion (and burn fal credits)
        with no one listening.

        Each abort is recorded in obs so /trace/abort-stats can show how
        much wall-time (and $) we save by polling here.
        """
        if is_disconnected is None:
            return
        try:
            if await is_disconnected():
                from obs import record_abort

                elapsed_ms = (_time.perf_counter() - started) * 1000.0
                log(
                    "info",
                    "sse.generate.client_disconnect",
                    stage=stage,
                    elapsed_ms=round(elapsed_ms, 2),
                )
                record_abort(
                    stage,
                    elapsed_ms,
                    trace_id=trace_id,
                    extra={"mode": body.mode},
                )
                raise _asyncio.CancelledError()
        except _asyncio.CancelledError:
            raise
        except Exception:
            # Polling failure shouldn't block the pipeline.
            pass

    # Tap-mode disables web search by default. The planner already has the
    # parent illustration, parent title, and subject_context as constraints,
    # so an online lookup adds 500-2000ms of variance for marginal value and
    # tends to drift the page out of the parent domain. Override with
    # WEB_SEARCH_ON_TAP=true if you want the legacy behaviour back.
    web_search_on_tap = env_flag("WEB_SEARCH_ON_TAP")
    effective_web_search = body.web_search and (body.mode != "tap" or web_search_on_tap)
    try:
        # Edit mode short-circuits the planner: we already have an image, the
        # user just wants to mutate it. Persisted as a child node so the
        # original is preserved in history + world map.
        if body.mode == "edit":
            if not body.image:
                yield _sse({"type": "error", "message": "edit mode requires an image"}, trace_id)
                return
            raw_instruction = (body.edit_instruction or body.query or "").strip()
            if not raw_instruction:
                yield _sse({"type": "error", "message": "edit mode requires an instruction"}, trace_id)
                return
            yield _sse({"type": "status", "stage": "planning"}, trace_id)
            # Style consistency on edits: the web client already sends the session
            # style lock + a "style" condition ref, but the edit path used to drop
            # both. Thread the text lock into the polish and the exemplar image into
            # the edit so an edit can't drift the world's art medium.
            edit_style_lock = (body.session_style_anchor or "").strip() or None
            edit_style_ref = _condition_url_for_role(body, "style")
            # Mask-scoped judged edit (EDIT_REGION, default off): the drag
            # selection arrives as a white=edit mask PNG; flux fill repaints
            # ONLY that region (the 2026-06-10 smoke: outside-mask pixels come
            # back byte-identical) and the edit loop judges by construction —
            # outside stability is a free pixel-diff, the inside gets the
            # alignment + medium critics, one retry folds their rationales
            # back in. Flag off or no mask -> the legacy whole-image path
            # below, byte-identical to today.
            if env_flag("EDIT_REGION") and body.edit_mask:
                from providers import edit_loop, judge
                from providers import inpaint as inpaint_provider
                from providers.render_loop import data_url_bytes

                described = await llm.polish_fill_description(
                    instruction=raw_instruction,
                    page_title=body.parent_title,
                    style_anchor=edit_style_lock,
                )
                yield _sse(
                    {
                        "type": "status",
                        "stage": "generating_image",
                        "page_title": raw_instruction,
                    },
                    trace_id,
                )
                edit_mask: str = body.edit_mask

                async def _render_inpaint(suffix: str) -> Any:
                    instr = described if not suffix else f"{described}\n\n{suffix}"
                    return await inpaint_provider.inpaint_image(
                        image_data_url=body.image or "",
                        mask_data_url=edit_mask,
                        instruction=instr,
                        model_override=body.image_model,
                    )

                source_bytes = data_url_bytes(body.image)
                mask_bytes = data_url_bytes(body.edit_mask)
                region_box = (
                    (
                        body.edit_region.x,
                        body.edit_region.y,
                        body.edit_region.w,
                        body.edit_region.h,
                    )
                    if body.edit_region
                    else None
                )
                verdict: dict[str, Any] | None = None
                if (
                    body.verify is False
                    or source_bytes is None
                    or mask_bytes is None
                ):
                    # Remote refs / undecodable inputs (or the user opted out
                    # of verification): a single un-judged shot (the loop's
                    # no-critic rule) — the result is still mask-scoped by
                    # the model.
                    if body.verify is not False:
                        log(
                            "warn",
                            "edit.loop.unjudged",
                            reason="source_or_mask_not_data_url",
                        )
                    inp_result = await _render_inpaint("")
                else:
                    edit_cfg = edit_loop.edit_loop_config_from_env(body.max_attempts)
                    edit_attempts: list[EditAttempt] = []
                    # The alignment judge checks the inside crop against the
                    # fill DESCRIPTION (the region's expected final content) —
                    # a raw command like "remove the tower" isn't judgeable
                    # against pixels, its described aftermath is.
                    async for edit_att in edit_loop.iter_edit_attempts(
                        _render_inpaint,
                        source_bytes=source_bytes,
                        mask_png=mask_bytes,
                        region_box=region_box,
                        judge_alignment=judge.score_prompt_alignment,
                        judge_medium=judge.score_style_pair,
                        instruction=described,
                        config=edit_cfg,
                        abort=_abort_if_disconnected,
                    ):
                        edit_attempts.append(edit_att)
                        # Stream only verdict-REJECTED attempts (a correction
                        # is coming); a degraded attempt is the final.
                        if (
                            not edit_att.accepted
                            and edit_att.alignment is not None
                            and edit_att.index + 1 < edit_cfg.max_attempts
                        ):
                            frame_b64 = (
                                await _asyncio.to_thread(
                                    base64.b64encode, edit_att.image.jpeg_bytes
                                )
                            ).decode("ascii")
                            yield _sse(
                                {
                                    "type": "progress",
                                    "frame_index": edit_att.index,
                                    "jpeg_b64": frame_b64,
                                },
                                trace_id,
                            )
                    edit_loop_result = edit_loop.conclude_edit(edit_attempts)
                    inp_result = edit_loop_result.image
                    best = edit_loop_result.best
                    verdict = {
                        "alignment": best.alignment.score if best.alignment else None,
                        "medium": best.medium.score if best.medium else None,
                        "outside_change": best.outside_change,
                        "attempts": len(edit_attempts),
                        "accepted": edit_loop_result.accepted,
                    }
                final_frame: dict[str, Any] = {
                    "type": "final",
                    "image_data_url": image_provider.encode_data_url(
                        inp_result.jpeg_bytes, inp_result.mime_type
                    ),
                    "page_title": raw_instruction,
                    "image_model": inp_result.model,
                    "prompt_author_model": llm._text_model(online=False),
                    "session_id": body.session_id,
                    "final_prompt": described,
                    "image_op": "inpaint",
                    "session_spend_estimate": spend.record_generation(
                        body.session_id,
                        inp_result.model,
                        # every loop attempt billed an inpaint; unjudged = one
                        images=len(edit_attempts) if verdict is not None else 1,
                    ),
                }
                if verdict is not None:
                    final_frame["edit_verdict"] = verdict
                yield _sse(final_frame, trace_id)
                return
            polished = await llm.polish_edit_instruction(
                instruction=raw_instruction,
                page_title=body.parent_title,
                style_anchor=edit_style_lock,
            )
            yield _sse(
                {
                    "type": "status",
                    "stage": "generating_image",
                    "page_title": raw_instruction,
                },
                trace_id,
            )
            # Judged whole-image edits (EDIT_JUDGE, default off — E3): the same
            # edit_loop as the mask path, minus the outside gate (no mask = no
            # confinement promise): alignment judged on the full frame against
            # the polished instruction + the medium critic vs the source, one
            # rationale-folding retry, verdict on the final frame. Undecodable
            # source (remote ref) falls through to the legacy un-judged call.
            if env_flag("EDIT_JUDGE") and body.verify is not False:
                from providers import edit_loop, judge
                from providers.render_loop import data_url_bytes

                judge_source = data_url_bytes(body.image)
                if judge_source is not None:

                    async def _render_judged_edit(suffix: str) -> Any:
                        instr = polished if not suffix else f"{polished}\n\n{suffix}"
                        return await image_edit_provider.edit_image(
                            image_data_url=body.image or "",
                            instruction=instr,
                            tier=body.image_tier,
                            model_override=body.image_model,
                            style_ref_url=edit_style_ref,
                        )

                    judge_cfg = edit_loop.edit_loop_config_from_env(body.max_attempts)
                    judged_attempts: list[EditAttempt] = []
                    async for judged_att in edit_loop.iter_edit_attempts(
                        _render_judged_edit,
                        source_bytes=judge_source,
                        mask_png=None,
                        region_box=None,
                        judge_alignment=judge.score_prompt_alignment,
                        judge_medium=judge.score_style_pair,
                        instruction=polished,
                        config=judge_cfg,
                        abort=_abort_if_disconnected,
                    ):
                        judged_attempts.append(judged_att)
                        # Stream only verdict-REJECTED attempts (a correction
                        # is coming); a degraded attempt is the final.
                        if (
                            not judged_att.accepted
                            and judged_att.alignment is not None
                            and judged_att.index + 1 < judge_cfg.max_attempts
                        ):
                            frame_b64 = (
                                await _asyncio.to_thread(
                                    base64.b64encode, judged_att.image.jpeg_bytes
                                )
                            ).decode("ascii")
                            yield _sse(
                                {
                                    "type": "progress",
                                    "frame_index": judged_att.index,
                                    "jpeg_b64": frame_b64,
                                },
                                trace_id,
                            )
                    judged_result = edit_loop.conclude_edit(judged_attempts)
                    judged_best = judged_result.best
                    # The loop types images as the Rendered protocol; this is
                    # the GeneratedImage our render closure returned.
                    judged_image: Any = judged_result.image
                    yield _sse(
                        {
                            "type": "final",
                            "image_data_url": image_provider.encode_data_url(
                                judged_image.jpeg_bytes,
                                judged_image.mime_type,
                            ),
                            "page_title": raw_instruction,
                            "image_model": judged_image.model,
                            "prompt_author_model": llm._text_model(online=False),
                            "session_id": body.session_id,
                            "final_prompt": polished,
                            "session_spend_estimate": spend.record_generation(
                                body.session_id,
                                judged_image.model,
                                images=len(judged_attempts),
                            ),
                            "edit_verdict": {
                                "alignment": (
                                    judged_best.alignment.score
                                    if judged_best.alignment
                                    else None
                                ),
                                "medium": (
                                    judged_best.medium.score
                                    if judged_best.medium
                                    else None
                                ),
                                "outside_change": judged_best.outside_change,
                                "attempts": len(judged_attempts),
                                "accepted": judged_result.accepted,
                            },
                        },
                        trace_id,
                    )
                    return
            edit_result = await image_edit_provider.edit_image(
                image_data_url=body.image,
                instruction=polished,
                tier=body.image_tier,
                model_override=body.image_model,
                style_ref_url=edit_style_ref,
            )
            edit_data_url = image_provider.encode_data_url(
                edit_result.jpeg_bytes, edit_result.mime_type
            )
            yield _sse(
                {
                    "type": "final",
                    "image_data_url": edit_data_url,
                    "page_title": raw_instruction,
                    "image_model": edit_result.model,
                    "prompt_author_model": llm._text_model(online=False),
                    "session_id": body.session_id,
                    "final_prompt": polished,
                    "session_spend_estimate": spend.record_generation(
                        body.session_id, edit_result.model
                    ),
                },
                trace_id,
            )
            return

        # OUTWARD / zoom-out (SCALE_LADDER_NAV + SCALE_OUTWARD): synthesize the
        # CONTAINER that holds the current root and stream it back as `ascend_ready`
        # — the web /ascend route persists the reparent. Isolated like edit/expand:
        # returns early, never touches the tap/query single-`final` path below.
        if body.mode == "ascend":
            from providers.generate_modes.ascend import stream_ascend

            async for frame in stream_ascend(
                body,
                trace_id,
                _sse=_sse,
                _frame_dims=_frame_dims,
                _view_grammar_on=_view_grammar_on,
                _abort_if_disconnected=_abort_if_disconnected,
            ):
                yield frame
            return

        # Expand mode blooms the world AROUND the focal subject: propose a few
        # neighbouring subjects across scales (component/peer/container), then
        # generate their pages concurrently and stream one `neighbor` event per
        # page as it lands. Self-contained like edit — the tap/query single-
        # `final` path below is untouched.
        if body.mode == "expand":
            from providers.generate_modes.expand import stream_expand

            async for frame in stream_expand(
                body,
                trace_id,
                _sse=_sse,
                _frame_dims=_frame_dims,
                _view_grammar_on=_view_grammar_on,
                _abort_if_disconnected=_abort_if_disconnected,
            ):
                yield frame
            return

        # 1. Resolve click → subject phrase + style anchor (style is empty for
        #    text-only queries; only set on tap mode). When the client has
        #    already prefetched on hover, skip the VLM round-trip entirely.
        effective_query = body.query
        # Session-level style lock takes precedence over the per-hop anchor:
        # if the user pinned a page, every new page should match that style
        # regardless of what the click VLM saw on the parent.
        session_lock = (body.session_style_anchor or "").strip() or None
        style_anchor: str | None = session_lock
        # `subject_context` is the VLM's one-sentence disambiguation of what
        # the click subject IS in the parent's domain — fed to the planner
        # to prevent semantic drift on ambiguous phrases like "Memory Bank".
        subject_context: str | None = None
        # World Mode render framing: an explicit request override wins; else the
        # click classifier's `enter_as` (set below) decides; else today's
        # explainer. Empty string = "not yet decided / fall back to explainer".
        effective_world_mode = _world_mode_on(body.world_mode)
        render_mode = (body.render_mode or "").strip().lower()
        if render_mode not in (
            "place_scene",
            "place_submap",
            "place_closeup",
            "explainer",
        ):
            render_mode = ""
        # World Mode spatial anchor — what's around the tapped spot + directions,
        # threaded into the planner so the entered place keeps its neighbours.
        surroundings_for_plan: str | None = None
        surroundings_pov_effective = False
        surroundings_behind_effective: str | None = None
        # View-grammar signals: the classifier's locale-proof place FORM
        # (interior/complex/landscape/generic) and the resolved subject BEFORE
        # the user-hint fold (the policy matches names against it).
        place_form_resolved: str | None = None
        view_subject: str | None = None
        if body.mode == "tap" and body.click and body.image:
            # Trust-but-verify on client-supplied prefetch hints. The web
            # client computes these via the same VLM the backend would call,
            # but the SSE handler will ultimately splice them into LLM
            # prompts — so cap length + strip control chars to keep prompt
            # injection / token-bomb surface small. Any rejection silently
            # falls back to in-band resolution.
            def _sanitize_hint(raw: str | None, max_len: int) -> str:
                if not raw:
                    return ""
                cleaned = "".join(
                    ch for ch in raw if ch == "\n" or ch == "\t" or ch >= " "
                ).strip()
                return cleaned[:max_len]

            cleaned_subject = _sanitize_hint(body.prefetched_subject, 160)
            cleaned_style = _sanitize_hint(body.prefetched_style, 320)
            cleaned_subject_context = _sanitize_hint(
                body.prefetched_subject_context, 400
            )
            cleaned_user_hint = _sanitize_hint(body.click_hint, 240)
            cleaned_surroundings = _sanitize_hint(body.prefetched_surroundings, 240)
            prefetched_ok = bool(cleaned_subject)
            if prefetched_ok:
                effective_query = cleaned_subject
                style_anchor = cleaned_style or None
                subject_context = cleaned_subject_context or None
                surroundings_for_plan = cleaned_surroundings or None
                surroundings_pov_effective = bool(body.surroundings_pov)
                surroundings_behind_effective = (
                    _sanitize_hint(body.surroundings_behind, 240) or None
                )
                yield _sse(
                    {
                        "type": "status",
                        "stage": "click_resolved",
                        "subject": effective_query,
                    },
                    trace_id,
                )
            else:
                await _abort_if_disconnected("pre-click-resolve")
                resolution = await llm.click_to_subject(
                    image_data_url=body.image,
                    x_pct=body.click.x_pct,
                    y_pct=body.click.y_pct,
                    parent_title=body.parent_title or body.query,
                    parent_query=body.parent_query or body.query,
                    output_locale=body.output_locale,
                    user_hint=cleaned_user_hint or None,
                    prior_rejected_subject=body.prior_rejected_subject,
                    world_mode=effective_world_mode,
                    # Clarifiers are surfaced client-side before this generate
                    # call, so the in-band resolve only needs the classification.
                    autonomy="auto",
                )
                # In world mode, let the classifier's read pick the framing
                # unless the request already pinned one.
                if effective_world_mode and not render_mode:
                    render_mode = _ENTER_AS_TO_RENDER.get(
                        resolution.enter_as, "explainer"
                    )
                if resolution.subject:
                    effective_query = resolution.subject
                    yield _sse(
                        {
                            "type": "status",
                            "stage": "click_resolved",
                            "subject": resolution.subject,
                            "groundable": resolution.groundable,
                            "confidence": resolution.confidence,
                            "point": (
                                {"x": resolution.point[0], "y": resolution.point[1]}
                                if resolution.point is not None
                                else None
                            ),
                            "bbox": (
                                {
                                    "x": resolution.bbox[0],
                                    "y": resolution.bbox[1],
                                    "w": resolution.bbox[2],
                                    "h": resolution.bbox[3],
                                }
                                if resolution.bbox is not None
                                else None
                            ),
                        },
                        trace_id,
                    )
                if resolution.style:
                    style_anchor = resolution.style
                if resolution.subject_context:
                    subject_context = resolution.subject_context
                if resolution.surroundings:
                    surroundings_for_plan = resolution.surroundings
                if resolution.place_form:
                    place_form_resolved = resolution.place_form

            # W2 (label-click routing): the resolved subject names a mapped
            # PLACE — the tap landed on the map's baked-in lettering rather
            # than the footprint — but the framing fell through to
            # "explainer", which rides the FRESH path (ignores image refs →
            # invents an unrelated scene). Upgrade to place_scene so the
            # enter edit keeps the place; no geometry needed (observer
            # absent → the view policy picks the camera).
            if effective_world_mode and render_mode in ("", "explainer"):
                label_hit = _match_world_entity(body.world_context, effective_query)
                if label_hit is not None:
                    render_mode = "place_scene"
                    log(
                        "info",
                        "world.label_match",
                        subject=effective_query,
                        entity=label_hit.get("name") or "",
                    )

            # The view policy matches names against the subject BEFORE the
            # hint fold (a hint suffix would break world_context name matches).
            view_subject = effective_query
            # Fold the user's free-form note into the planner query so the next
            # page reflects their angle even when the prefetched-subject path
            # short-circuited the VLM. Em dash separator keeps the subject
            # readable as the page title; planner is instructed to honour both.
            if cleaned_user_hint:
                effective_query = f"{effective_query} — {cleaned_user_hint}"

        # Session-lock always wins over per-hop derivations. Re-applied here
        # so the tap branches (which reassign style_anchor) don't clobber it.
        if session_lock:
            style_anchor = session_lock

        # 2. Plan (with optional style anchor for visual continuity, and
        #    parent + subject_context for semantic continuity — keeps an
        #    ambiguous click subject in the parent page's domain instead of
        #    drifting to whatever interpretation web search likes most).
        #    `world_context` carries recurring-entity appearance descriptors
        #    that the planner injects into the image prompt.
        await _abort_if_disconnected("pre-plan")
        yield _sse({"type": "status", "stage": "planning"}, trace_id)
        world_context_payload = [e.model_dump() for e in body.world_context]
        if world_context_payload:
            log(
                "info",
                "plan.world_context",
                entities=len(world_context_payload),
                first_name=world_context_payload[0].get("name"),
            )
        plan = await llm.plan_page(
            query=effective_query,
            web_search=effective_web_search,
            style_anchor=style_anchor,
            output_locale=body.output_locale,
            parent_title=body.parent_title,
            parent_query=body.parent_query,
            subject_context=subject_context,
            world_context=world_context_payload,
            render_mode=render_mode or "explainer",
            surroundings=surroundings_for_plan,
            label_free=body.suppress_map_labels,
        )

        composed_prompt = plan.prompt
        if style_anchor:
            # Belt + suspenders: prepend the style anchor explicitly so the
            # image model sees it at the front of the prompt even if the
            # planner omitted it.
            composed_prompt = (
                f"Style: {style_anchor}\n\n{composed_prompt}"
            )
        # Stepping INSIDE a place is an immersive scene, not a diagram — rendering
        # the facts as on-image "Labels to include" turns the interior into an
        # annotated diagram (floating captions), breaking the seamless step-in.
        # The scene still carries that content via plan.prompt; maps/explainers
        # keep their labels.
        if (
            plan.facts
            and render_mode != "place_scene"
            and not body.suppress_map_labels
        ):
            composed_prompt += "\n\nLabels to include:\n- " + "\n- ".join(plan.facts)
        if body.suppress_map_labels and render_mode != "place_scene":
            # DOM-labels mode: belt + suspenders at the image-prompt level too
            # (the planner was already asked for a label-free page).
            from providers.prompt_library.style import NO_LETTERING

            composed_prompt += f"\n\n{NO_LETTERING}"
        # MODERATE_PROMPTS (default off): one cheap LLM check on the composed
        # prompt before any image dollars are spent — a public deployment's
        # opt-in. Fail-open inside (providers/moderation.py); a block is a
        # clean error frame, not a 500.
        from providers import moderation

        blocked, block_reason = await moderation.flagged(composed_prompt)
        if blocked:
            yield _sse(
                {"type": "error", "message": f"Blocked by moderation: {block_reason}"},
                trace_id,
            )
            return
        # World Mode sub-map: pixel-continue the click region with a continuation
        # model (Kontext) so the closer map keeps the parent's streets/buildings
        # in place instead of re-planning a fresh image. Needs the region crop.
        # (Hoisted above the prompt assembly: the view grammar needs the
        # render's shape — region presence + op — before clauses compose.)
        region_ref: str | None = None
        if body.condition_image_urls:
            roles = body.condition_roles or []
            for i, url in enumerate(body.condition_image_urls):
                if i < len(roles) and roles[i] == "region":
                    region_ref = url
                    break
            if region_ref is None:
                region_ref = body.condition_image_urls[0]
        # The model router owns the op decision: a place_submap entry with a
        # region crop zoom-continues; a place_scene entry routes through the
        # edit endpoint; everything else is a fresh gen.
        image_op = model_router.select_operation(render_mode, region_ref is not None)
        use_continuation = image_op == "zoom_continue"
        # Spend accounting (providers/spend.py): how many images this
        # generation billed — judged loops overwrite with their attempt count,
        # the draft records itself at emission.
        billed_images = 1

        # The deliberate camera (view grammar): user/persisted pin > policy >
        # None (legacy bytes). Resolved once; consumed by the layout clause,
        # the camera clause, and the enter/zoom instruction builders.
        view_spec = _view_spec_for(
            body,
            render_mode,
            world_mode=effective_world_mode,
            has_region=region_ref is not None,
            subject=view_subject,
            subject_context=subject_context,
            place_form=place_form_resolved,
        )
        if view_spec is not None:
            log(
                "info",
                "view.applied",
                projection=view_spec.get("projection"),
                source=view_spec.get("source"),
                op=image_op,
            )
        layout_suppressed = _layout_register_mismatch(body, view_spec)
        if layout_suppressed:
            log(
                "warn",
                "view.layout_register_mismatch",
                projection=view_spec.get("projection") if view_spec else None,
            )

        # Geometric world: append the engine's deterministic placement clause so
        # the model aims entities at their projected positions. Flag-gated → "".
        # Suppressed when the bins were projected for a DIFFERENT camera than
        # the deliberate view (steering against wrong-camera bins is worse than
        # not steering); extended (depth layers + real heights) under the grammar.
        layout_clause = (
            ""
            if layout_suppressed
            else _layout_clause_for(body, view_grammar=view_spec is not None)
        )
        if layout_clause:
            composed_prompt += "\n\n" + layout_clause
            log("info", "geo.layout_steered", entities=len(body.expected_layout))
        # The camera clause — the A3-proven appended-last slot. NOT on
        # place_scene composed prompts: the enter INSTRUCTION carries the
        # camera there, and the kill-switch fresh path keeps its legacy
        # exterior→interior preamble uncontradicted (V1 should-fix 11). When
        # the grammar produced a clause it SUBSUMES the WORLD_TOPDOWN_MAPS
        # lever (no double-speak); the legacy clause only fires when the
        # grammar stayed silent.
        camera_text = (
            "" if render_mode == "place_scene" else _camera_clause_for(body, view_spec)
        )
        if camera_text:
            composed_prompt += "\n\n" + camera_text
        else:
            # Top-down map lever (WORLD_TOPDOWN_MAPS) — flag-gated, map renders
            # only → "" otherwise.
            topdown_clause = _topdown_clause_for(body)
            if topdown_clause:
                composed_prompt += "\n\n" + topdown_clause

        await _abort_if_disconnected("pre-image-gen")
        yield _sse(
            {
                "type": "status",
                "stage": "generating_image",
                "page_title": plan.page_title,
            },
            trace_id,
        )
        # Enter-via-edit (ENTER_EDIT_REF, default ON — a kill-switch, not an
        # opt-in): the edit endpoint is the only path where the source ref
        # actually bites (research/01: text-to-image accepts-but-IGNORES refs,
        # which made every entered place an unconditioned reinvention). Source
        # = the clean region crop the client already sends in the condition
        # stack; body.image only as a last resort — it is the marker-ANNOTATED
        # parent (play page annotateClickPoint).
        enter_source: str | None = region_ref or body.image
        use_enter_edit = (
            image_op == "enter_scene"
            and env_flag("ENTER_EDIT_REF", "true")
            and enter_source is not None
        )
        # The Kontext zoom keeps the crop's LOOK faithful; feed it the system's
        # KNOWLEDGE too — the planner's named sub-areas (plan.facts) + the
        # geometry placement clause — so it ELABORATES the place in finer detail
        # instead of a dumb pixel-zoom. The crop is the reference; this enhances
        # it through the world model and geometry.
        from providers.prompt_library import camera as camera_lib

        zoom_instruction = image_edit_provider.build_zoom_instruction(
            plan.page_title,
            plan.facts,
            layout_clause,
            style_anchor=style_anchor,
            view=view_spec if use_continuation else None,
            family=camera_lib.model_family(
                body.image_model or model_router.resolve_model("zoom_continue")
            ),
            label_free=body.suppress_map_labels,
            # place_closeup zooms into a PERSPECTIVE scene — the cartographic
            # wording would fight the reference pixels.
            register="view" if render_mode == "place_closeup" else "map",
            # The closeup rung magnifies faithfully: no planner facts, no
            # "elaborate" — the facts channel is how city-wide context leaked
            # into closeups (the invented-riverside-palace failure).
            faithful=bool(body.scene_view and body.scene_view.closeup),
        )
        # The enter edit is a view CHANGE on the SAME place: the region crop
        # carries the look, this text carries the move inside + everything the
        # system knows (identity, neighbours-by-bearing, medium, geometry) —
        # and, under the view grammar, the DELIBERATE camera (eye level /
        # oblique establishing / isometric / closer plan) instead of the old
        # hardcoded "ground level".
        enter_view = view_spec if image_op == "enter_scene" else None
        # Steep transforms route to the gpt family (view-bench A/B: eye_level
        # 8.0 vs the nano family's 2.5 from an aerial source, same-place
        # equal); aerial registers + the legacy no-view enter keep the slot.
        enter_model_slug = body.image_model or model_router.select_enter_model(
            str(enter_view.get("projection")) if enter_view else None
        )
        enter_family = camera_lib.model_family(enter_model_slug)
        if enter_view is not None and enter_family == "kontext":
            # Kontext can't change projection (3.33/10 same-place on view
            # change) — the builder emits its degraded scene-level fallback;
            # deployers who pinned FAL_ENTER_MODEL=kontext should revert.
            log("warn", "view.kontext_enter_fallback", model=enter_model_slug)
        enter_instruction = image_edit_provider.build_enter_instruction(
            plan.page_title,
            plan.facts,
            style_anchor=style_anchor,
            subject_context=subject_context,
            surroundings=surroundings_for_plan,
            layout_clause=layout_clause,
            view=enter_view,
            family=enter_family,
            style_ref=bool(_condition_url_for_role(body, "style")),
            surroundings_pov=surroundings_pov_effective,
            surroundings_behind=surroundings_behind_effective,
        )

        # 3. Image gen — with progressive fast-tier draft.
        #
        # When the user picked balanced/pro the cheap nano-banana model is
        # ~3-5x faster than the requested tier. Firing a fast-tier draft in
        # parallel and emitting it via the existing `progress` event lets
        # the frontend paint a usable page seconds before the final lands.
        # Disabled by env if a deployer wants to save the extra fal call.
        progressive_enabled = env_flag("PROGRESSIVE_DRAFT", "true")
        target_tier = (body.image_tier or "balanced").lower()
        wants_draft = (
            progressive_enabled
            and target_tier != "fast"
            and not body.image_model  # honour explicit model_override
            # The draft race is a fal tier optimisation (cheap fast-tier model
            # in parallel with the requested tier). Non-fal backends collapse
            # tiers to one model, so a draft would just regenerate the same
            # image — skip it.
            and image_provider.active_provider() == "fal"
            # Sub-map continuation is a single Kontext call on the region crop;
            # a nano-banana text draft would just be an unrelated preview.
            and not use_continuation
            # Same for the enter edit: a text-only draft can't preview a
            # conditioned edit — it would be a SECOND unconditioned reinvention
            # flashing before the faithful render (the draft≠final complaint).
            and not use_enter_edit
        )
        draft_task: _asyncio.Task | None = None
        if wants_draft:
            draft_task = _asyncio.create_task(
                image_provider.generate_image(
                    prompt=composed_prompt,
                    aspect_ratio=body.aspect_ratio,
                    tier="fast",
                )
            )
        # Image conditioning (final image only; the fast draft stays a quick
        # text-only preview). Blend the reference stack — region crop → parent →
        # anchor — so the page belongs to the same world. Flag-gated; no refs →
        # text-only exactly as before.
        main_prompt = composed_prompt
        cond_refs: list[str] | None = None
        if env_flag("IMAGE_CONDITIONING", "true") and body.condition_image_urls:
            cond_refs = body.condition_image_urls
            # Entering a place reframes the region ref ("reveal the fuller place
            # within") vs. an explainer tap ("reveal what is inside").
            cond_mode = "place_scene" if render_mode == "place_scene" else body.mode
            main_prompt = (
                image_provider.conditioning_preamble(
                    body.condition_roles or [], cond_mode
                )
                + composed_prompt
            )
        result: Any = None
        main_task: _asyncio.Task | None = None
        if use_continuation and region_ref is not None:
            main_task = _asyncio.create_task(
                image_edit_provider.continue_image(
                    region_ref, zoom_instruction, model_override=body.image_model
                )
            )
        elif use_enter_edit and enter_source is not None:
            # ONE selection for both the instruction's family grammar and the
            # dispatch: explicit per-request model > the steep-aware router
            # pick (enter_model_slug, resolved above with the view).
            enter_style_ref = _condition_url_for_role(body, "style")
            # The render loop (VIEW_LOOP, default ON): EVERY deliberate-camera
            # enter is judged — same-place + medium floors always, conformance
            # per projection. The loop used to arm on steep projections only
            # (eye_level/top_down, the measured ~50% one-shot path); the
            # Ankh-Morpork demo showed an OBLIQUE enter drifting medium and
            # identity with nothing to catch it — the text medium lock is
            # advisory to loose-ref models, so the gate has to be a judge.
            # Legacy (no deliberate view) enters keep the one-shot path.
            view_loop = (
                enter_view is not None
                and env_flag("VIEW_LOOP", "true")
                and body.verify is not False
            )
            log(
                "info",
                "tap.enter_edit",
                model=enter_model_slug,
                source="region" if region_ref else "parent_image",
                style_ref=bool(enter_style_ref),
                projection=(enter_view or {}).get("projection"),
                loop=view_loop,
            )
            if view_loop:
                from providers import judge, render_loop

                async def _render_enter(suffix: str) -> Any:
                    instr = (
                        enter_instruction
                        if not suffix
                        else f"{enter_instruction}\n\n{suffix}"
                    )
                    return await image_edit_provider.edit_image(
                        enter_source,
                        instr,
                        model_override=enter_model_slug,
                        style_ref_url=enter_style_ref,
                    )

                # The richness critic: the named interior features (the
                # planner's facts) must stay articulated across retries — a
                # retry that fixes the camera but seals the bailey under an
                # invented roof is REJECTED, not accepted (the critic gap a
                # live regression exposed).
                detail_features = [f for f in plan.facts if f and f.strip()]
                detail_title = plan.page_title or effective_query

                async def _judge_detail(img_bytes: bytes) -> JudgeResult:
                    return await judge.score_feature_articulation(
                        img_bytes, detail_title, detail_features
                    )

                loop_cfg = render_loop.loop_config_from_env(body.max_attempts)
                loop_attempts: list[Attempt] = []
                async for loop_att in render_loop.iter_attempts(
                    _render_enter,
                    projection=str((enter_view or {}).get("projection") or ""),
                    region_bytes=render_loop.data_url_bytes(enter_source),
                    judge_conformance=judge.score_view_conformance,
                    judge_same_place=_same_place_judge(judge),
                    config=loop_cfg,
                    judge_detail=_judge_detail,
                    # The medium gate: the entered view must look drawn by the
                    # same hand as the tapped region (style_pair vs the crop).
                    judge_medium=judge.score_style_pair,
                    family=enter_family,
                    abort=_abort_if_disconnected,
                ):
                    loop_attempts.append(loop_att)
                    # Stream only verdict-REJECTED attempts (a correction is
                    # coming); a degraded attempt (no critic) is the final.
                    if (
                        not loop_att.accepted
                        and loop_att.conformance is not None
                        and loop_att.index + 1 < loop_cfg.max_attempts
                    ):
                        # Stream the rejected attempt — the user watches the
                        # agent self-correct instead of staring at a spinner.
                        frame_b64 = (
                            await _asyncio.to_thread(
                                base64.b64encode, loop_att.image.jpeg_bytes
                            )
                        ).decode("ascii")
                        yield _sse(
                            {
                                "type": "progress",
                                "frame_index": loop_att.index,
                                "jpeg_b64": frame_b64,
                            },
                            trace_id,
                        )
                result = render_loop.conclude(loop_attempts).image
                billed_images = max(1, len(loop_attempts))
            else:
                main_task = _asyncio.create_task(
                    image_edit_provider.edit_image(
                        enter_source,
                        enter_instruction,
                        model_override=enter_model_slug,
                        style_ref_url=enter_style_ref,
                    )
                )
        else:
            main_task = _asyncio.create_task(
                image_provider.generate_image(
                    prompt=main_prompt,
                    aspect_ratio=body.aspect_ratio,
                    tier=body.image_tier,
                    model_override=body.image_model,
                    reference_urls=cond_refs,
                )
            )
        # Drive both tasks to completion. If the draft finishes first, emit
        # `progress`; if the main finishes first, drop the draft. (When the
        # render loop produced `result` inline, there is no main_task.)
        if main_task is not None and draft_task is not None:
            done, _ = await _asyncio.wait(
                {draft_task, main_task}, return_when=_asyncio.FIRST_COMPLETED
            )
            if main_task in done:
                # Main beat the draft — drop the draft, the user gets the
                # final straight away.
                draft_task.cancel()
                with contextlib.suppress(Exception, _asyncio.CancelledError):
                    await draft_task
                result = main_task.result()
            else:
                # Draft finished first; surface it as a progress frame, then
                # keep waiting for main. If the draft itself errored, just
                # skip the progress and continue — main is still running.
                try:
                    draft_result = draft_task.result()
                except Exception:
                    draft_result = None
                if draft_result is not None:
                    # The draft is a real fal call — bill it as it lands.
                    spend.record(
                        body.session_id, spend.estimate_image(draft_result.model)
                    )
                    # Name the phase honestly: what lands next is a fast-tier
                    # DRAFT the main render will replace — the banner and the
                    # waterfall both label it so the swap isn't a mystery.
                    yield _sse(
                        {
                            "type": "status",
                            "stage": "draft",
                            "image_model": draft_result.model,
                        },
                        trace_id,
                    )
                    # Encode in a thread so the event loop stays free for
                    # main_task progress. Sync b64encode of a 1-3MB JPEG
                    # otherwise stalls the loop for ~5-15ms — small per call,
                    # but it's stalls in the hot path right when the user
                    # cares most about latency.
                    draft_b64 = (
                        await _asyncio.to_thread(
                            base64.b64encode, draft_result.jpeg_bytes
                        )
                    ).decode("ascii")
                    yield _sse(
                        {
                            "type": "progress",
                            "frame_index": 0,
                            "jpeg_b64": draft_b64,
                        },
                        trace_id,
                    )
                result = await main_task
        elif main_task is not None:
            result = await main_task

        # 3b. Geometric grounding (VLM_GROUNDING): verify the render against the
        # expected layout and — when VLM_GROUNDING_REPAIR is also on — attempt one
        # bounded corrective edit, keeping the best-scoring image. Best-effort +
        # flag-gated, so off (the default) is byte-identical to before.
        # Skipped on a layout-register mismatch: verifying (and REPAIRING)
        # against bins projected for a different camera would actively fight
        # the deliberate view (V1 must-fix 5).
        grounding_summary: dict | None = None
        if _vlm_grounding_on() and body.expected_layout and not layout_suppressed:
            await _abort_if_disconnected("pre-grounding")
            yield _sse(
                {
                    "type": "status",
                    "stage": "verifying",
                    "page_title": plan.page_title,
                },
                trace_id,
            )
            result, grounding_summary = await _run_grounding(
                result,
                cast(
                    "list[ProjectedEntityDict]",
                    [e.model_dump() for e in body.expected_layout],
                ),
                repair_on=_vlm_grounding_repair_on(),
                abort=_abort_if_disconnected,
            )

        # Final image is the largest payload (up to 3MB JPEG on the pro
        # tier); offload the b64 encode the same way as the draft so the
        # `final` SSE yield isn't gated on a sync CPU stall.
        data_url = await _asyncio.to_thread(
            image_provider.encode_data_url, result.jpeg_bytes, result.mime_type
        )

        # 4. Final event. Matches GenerateFinalEvent in packages/config.
        text_model = llm._text_model(online=effective_web_search)
        sources_payload = [
            {"url": c.url, "title": c.title}
            for c in (plan.sources or [])
        ]
        final_payload: dict[str, Any] = {
            "type": "final",
            "image_data_url": data_url,
            "page_title": plan.page_title,
            "image_model": result.model,
            "prompt_author_model": text_model,
            "session_id": body.session_id,
            "final_prompt": (
                zoom_instruction
                if use_continuation
                else enter_instruction
                if use_enter_edit
                else composed_prompt
            ),
            "sources": sources_payload,
            "session_spend_estimate": spend.record_generation(
                body.session_id, result.model, images=billed_images
            ),
        }
        # Which non-fresh op actually rendered the image — additive, absent on
        # the fresh path (unchanged wire shape). Lets the demo trace / A-B
        # drivers machine-check the route instead of inferring from the model.
        executed_op = (
            "zoom_continue"
            if use_continuation
            else "enter_scene"
            if use_enter_edit
            else "fresh"
        )
        if executed_op != "fresh":
            final_payload["image_op"] = executed_op
        # Geometric grounding summary rides on `final` only when produced (flag
        # off → key absent → unchanged wire shape).
        if grounding_summary is not None:
            final_payload["grounding"] = grounding_summary
        yield _sse(final_payload, trace_id)
        log(
            "info",
            "sse.generate.end",
            duration_ms=round((_time.perf_counter() - started) * 1000, 2),
        )
    except _asyncio.CancelledError:
        # Client dropped the SSE socket — bail out cleanly without firing
        # an `error` event into the (now-dead) stream and without paging
        # Sentry. The downstream socket is already closed, so any further
        # yield would no-op anyway.
        log(
            "info",
            "sse.generate.cancelled",
            duration_ms=round((_time.perf_counter() - started) * 1000, 2),
        )
        return
    except Exception as exc:
        log(
            "error",
            "sse.generate.end",
            duration_ms=round((_time.perf_counter() - started) * 1000, 2),
            error=f"{type(exc).__name__}: {exc}",
        )
        record_error("sse_generate", exc)
        yield _sse({"type": "error", "message": str(exc)}, trace_id)


@fastapi_app.post("/sse/generate")
async def sse_generate(req: Request):
    from obs import TRACE_HEADER, bind_trace

    limited = _rate_limited(req)
    if limited is not None:
        return limited
    raw = await req.json()
    try:
        body = GenerateBody.model_validate(raw)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    trace_id = bind_trace(req.headers.get(TRACE_HEADER) or body.trace_id)

    return StreamingResponse(
        _with_heartbeat(
            _event_stream(body, trace_id, is_disconnected=req.is_disconnected)
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "X-Trace-Id": trace_id,
        },
    )


class AnimateBody(BaseModel):
    image_data_url: str
    prompt: str
    duration: int = 5
    video_tier: str | None = None
    trace_id: str | None = None


@fastapi_app.post("/animate")
async def animate(req: Request, body: AnimateBody):
    """Cheap-fallback animation: delegate to fal-ai/ltx-video.

    Wraps fal errors into a JSON 502 with the original exception message so
    the frontend can surface the real cause (rate limit, payload too large,
    invalid image format) instead of a generic 500.
    """
    from obs import TRACE_HEADER, bind_trace, log, record_error
    from providers import llm as llm_provider
    from providers import video as video_provider

    limited = _rate_limited(req)
    if limited is not None:
        return limited

    trace_id = bind_trace(req.headers.get(TRACE_HEADER) or body.trace_id)
    img_size_kb = len(body.image_data_url) // 1024
    log(
        "info",
        "animate.request",
        prompt_len=len(body.prompt or ""),
        image_kb=img_size_kb,
        duration=body.duration,
    )
    motion_prompt = await llm_provider.rewrite_motion_prompt(
        page_title=body.prompt or "",
        image_data_url=body.image_data_url,
        duration_seconds=body.duration,
    )
    if motion_prompt and motion_prompt != body.prompt:
        log(
            "info",
            "animate.prompt_rewritten",
            orig_len=len(body.prompt or ""),
            new_len=len(motion_prompt),
        )
    try:
        clip = await video_provider.animate_image(
            image_data_url=body.image_data_url,
            prompt=motion_prompt or body.prompt,
            duration=body.duration,
            tier=body.video_tier,
        )
    except Exception as exc:
        record_error("animate", exc, image_kb=img_size_kb)
        return JSONResponse(
            {
                "error": f"{type(exc).__name__}: {exc}",
                "stage": "fal_animate",
                "image_data_url_kb": img_size_kb,
                "trace_id": trace_id,
            },
            status_code=502,
            headers={"X-Trace-Id": trace_id},
        )
    return JSONResponse(
        {
            "video_url": clip.video_url,
            "content_type": clip.content_type,
            "model": clip.model,
            "duration_seconds": clip.duration_seconds,
            "trace_id": trace_id,
        },
        headers={"X-Trace-Id": trace_id},
    )


class ResolveClickBody(BaseModel):
    image_data_url: str
    x_pct: float = Field(ge=0.0, le=1.0)
    y_pct: float = Field(ge=0.0, le=1.0)
    parent_title: str | None = None
    parent_query: str | None = None
    output_locale: str | None = None
    prior_rejected_subject: str | None = None
    # World Mode: ask the resolver to also classify what was tapped and (in
    # "semi") propose clarifying questions to surface before entering.
    world_mode: bool = False
    autonomy: str = "auto"
    trace_id: str | None = None


@fastapi_app.post("/resolve-click")
async def resolve_click(req: Request, body: ResolveClickBody):
    """Hover-prefetch endpoint.

    Returns the click→subject+style mapping plus groundability + bounding
    box so the frontend can: (a) warm a tap before the user commits, (b)
    render the "we think you tapped this — yes / try again" overlay, and
    (c) suppress page generation when ``groundable`` is false.
    """
    from obs import TRACE_HEADER, bind_trace, record_error
    from providers import llm as llm_provider

    limited = _rate_limited(req)
    if limited is not None:
        return limited

    trace_id = bind_trace(req.headers.get(TRACE_HEADER) or body.trace_id)
    try:
        resolution = await llm_provider.click_to_subject(
            image_data_url=body.image_data_url,
            x_pct=body.x_pct,
            y_pct=body.y_pct,
            parent_title=body.parent_title or "",
            parent_query=body.parent_query or "",
            output_locale=body.output_locale,
            prior_rejected_subject=body.prior_rejected_subject,
            world_mode=_world_mode_on(body.world_mode),
            autonomy=(body.autonomy or "auto"),
        )
    except Exception as exc:
        record_error("resolve_click", exc)
        return JSONResponse(
            {"error": f"{type(exc).__name__}: {exc}", "trace_id": trace_id},
            status_code=502,
            headers={"X-Trace-Id": trace_id},
        )
    return JSONResponse(
        {
            "subject": resolution.subject,
            "style": resolution.style,
            "subject_context": resolution.subject_context,
            "groundable": resolution.groundable,
            "confidence": resolution.confidence,
            "point": (
                {"x": resolution.point[0], "y": resolution.point[1]}
                if resolution.point is not None
                else None
            ),
            "bbox": (
                {
                    "x": resolution.bbox[0],
                    "y": resolution.bbox[1],
                    "w": resolution.bbox[2],
                    "h": resolution.bbox[3],
                }
                if resolution.bbox is not None
                else None
            ),
            "enter_as": resolution.enter_as,
            "clarifiers": resolution.clarifiers,
            "surroundings": resolution.surroundings,
            "trace_id": trace_id,
        },
        headers={"X-Trace-Id": trace_id},
    )


class PrecomputeBody(BaseModel):
    image_data_url: str
    parent_title: str | None = None
    parent_query: str | None = None
    output_locale: str | None = None
    # Frontend now requests 8 by default (was 4) — pairs with the tighter 3%
    # bucket grid on the client to push tap-time cache hit-rate up. Server
    # still caps at 8 to bound VLM cost.
    max_candidates: int = 8
    trace_id: str | None = None


@fastapi_app.post("/precompute-candidates")
async def precompute_candidates(req: Request, body: PrecomputeBody):
    """Pre-resolve the 3-4 most click-worthy regions on a fresh page.

    Frontend fires this once per page-render; results warm the same cache the
    hover-prefetch path uses, so the first click on a salient region skips
    the VLM round-trip entirely.
    """
    from obs import TRACE_HEADER, bind_trace, record_error
    from providers import llm as llm_provider
    from providers import spend

    trace_id = bind_trace(req.headers.get(TRACE_HEADER) or body.trace_id)
    guard = _paid_guard(req, trace_id)
    if guard is not None:
        return guard
    spend.record_vlm_call("_anon")
    try:
        cands = await llm_provider.precompute_click_candidates(
            image_data_url=body.image_data_url,
            parent_title=body.parent_title or "",
            parent_query=body.parent_query or "",
            output_locale=body.output_locale,
            max_candidates=max(1, min(8, body.max_candidates)),
        )
    except Exception as exc:
        record_error("precompute_candidates", exc)
        return JSONResponse(
            {"error": f"{type(exc).__name__}: {exc}", "trace_id": trace_id},
            status_code=502,
            headers={"X-Trace-Id": trace_id},
        )
    return JSONResponse(
        {
            "candidates": [
                {
                    "x_pct": c.x_pct,
                    "y_pct": c.y_pct,
                    "subject": c.subject,
                    "style": c.style,
                    "salience": c.salience,
                }
                for c in cands
            ],
            "trace_id": trace_id,
        },
        headers={"X-Trace-Id": trace_id},
    )


class PriorEntity(BaseModel):
    id: str | None = None
    kind: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    appearance: str = ""


class ExtractEntitiesBody(BaseModel):
    session_id: str
    node_id: str
    image_data_url: str
    # `caption` is the short page title (<= 8 words). `scene_description`
    # is the planner's full image prompt — the rich paragraph the renderer
    # produced from. The extractor needs both; a title alone is too thin.
    caption: str = ""
    scene_description: str | None = None
    # Pre-filtered slice of the current world's entities so the VLM can
    # diff. Web layer selects the relevant ones; we don't want the full
    # registry on every call. Capped server-side regardless.
    prior_entities: list[PriorEntity] = Field(default_factory=list, max_length=40)
    trace_id: str | None = None


class GeoEntityRef(BaseModel):
    """The trimmed geo state the NL editor may target (mirrors the web's
    EditEntitiesRequestBody.entities slice)."""
    id: str
    entity_id: str | None = None
    label: str = ""
    pos: WorldVec2
    height: float = 0.0
    footprint: dict[str, float] = Field(default_factory=dict)
    visual: str = ""


class EditEntitiesBody(BaseModel):
    session_id: str
    instruction: str
    entities: list[GeoEntityRef] = Field(default_factory=list, max_length=120)
    # geo-id → node ids that show it; lets us compute the blast-radius here.
    references: dict[str, list[str]] = Field(default_factory=dict)
    scene_view: SceneView | None = None
    trace_id: str | None = None


@fastapi_app.post("/extract-entities")
async def extract_entities_endpoint(req: Request, body: ExtractEntitiesBody):
    """Run the world-memory extractor on a freshly-rendered page.

    Web-side flow: after /sse/generate emits `final` and the image is
    persisted as a node, the web layer posts here with the node id, image
    data URL, page caption, and a small slice of the existing entity
    registry. We return a diff (`added` + `updated`) which the web layer
    merges into the `world_state` Mongo collection.

    Pure read on the backend — no Mongo, no R2; the diff is just structured
    JSON. Cost: one VLM call per page (default Gemini 3 Flash). Web side
    runs this off the critical path so it doesn't block the next click.
    """
    from obs import TRACE_HEADER, bind_trace, log, record_error
    from providers import llm as llm_provider
    from providers import spend

    trace_id = bind_trace(req.headers.get(TRACE_HEADER) or body.trace_id)
    guard = _paid_guard(req, trace_id, body.session_id)
    if guard is not None:
        return guard
    spend.record_vlm_call(body.session_id)
    img_size_kb = len(body.image_data_url) // 1024
    log(
        "info",
        "extract_entities.request",
        node_id=body.node_id,
        session_id=body.session_id,
        prior_count=len(body.prior_entities),
        caption_len=len(body.caption or ""),
        scene_desc_len=len(body.scene_description or ""),
        image_kb=img_size_kb,
    )
    try:
        result = await llm_provider.extract_entities(
            image_data_url=body.image_data_url,
            caption=body.caption,
            scene_description=body.scene_description,
            prior_entities=[e.model_dump() for e in body.prior_entities],
        )
    except Exception as exc:
        record_error("extract_entities", exc, node_id=body.node_id)
        return _err_json(exc, trace_id)

    # Localize the catalogued entities so the world map can seed and the overlay
    # can draw. The extractor's bbox is best-effort and often empty on dense
    # images; the purpose-built detector reliably returns one box per label.
    # Detector boxes are centre-based → store top-left for the EntityBBox shape.
    # Gated + best-effort: a failure here never blocks the extract response.
    # Decode the image once for both geometry passes (localize + view-estimate).
    geo_img_bytes = b""
    if _geometric_world_on():
        try:
            _, _, _gb64 = body.image_data_url.partition(",")
            geo_img_bytes = base64.b64decode(_gb64) if _gb64 else b""
        except Exception:
            geo_img_bytes = b""

    if geo_img_bytes and (result.added or result.updated):
        try:
            from providers import detector as _detector

            def _box_from_det(d: Detection) -> dict[str, float]:
                # Centre-based → top-left, clipped to the frame on all four edges.
                # A naive `max(0, c - s/2)` leaves w/h unclipped, so an edge box
                # overflows past 1.0 or shifts its recomputed centre.
                cx, cy = float(d["x_pct"]), float(d["y_pct"])
                bw, bh = float(d["w_pct"]), float(d["h_pct"])
                x1, y1 = max(0.0, cx - bw / 2.0), max(0.0, cy - bh / 2.0)
                x2, y2 = min(1.0, cx + bw / 2.0), min(1.0, cy + bh / 2.0)
                return {
                    "x_pct": x1,
                    "y_pct": y1,
                    "w_pct": max(0.0, x2 - x1),
                    "h_pct": max(0.0, y2 - y1),
                }

            # Localize NEW *and* recurring entities: a re-appearance must keep a
            # per-node box or it drops out of geometry + the overlay every time
            # it's seen again. One detector call covers both lists.
            need_added = [e for e in result.added if not e.bbox]
            need_updated = [u for u in result.updated if not u.bbox]
            labels = [e.name for e in need_added] + [
                u.match_name for u in need_updated
            ]
            if labels:
                dets = await _detector.detect(geo_img_bytes, labels)
                by_label = {str(d.get("label", "")).lower().strip(): d for d in dets}

                def _match(name: str) -> dict[str, float] | None:
                    key = name.lower().strip()
                    d = by_label.get(key) or next(
                        (v for k, v in by_label.items() if k and (k in key or key in k)),
                        None,
                    )
                    return _box_from_det(d) if d else None

                for e in need_added:
                    box = _match(e.name)
                    if box:
                        e.bbox = box
                for u in need_updated:
                    box = _match(u.match_name)
                    if box:
                        u.bbox = box

                # SAM3 outline pass (best-effort, flag-gated): one segment call
                # box-prompted with the detector boxes -> a tight border polygon
                # per entity for the overlay. A failure leaves boxes intact.
                if _segment_borders_on():
                    try:
                        from providers.segmenter import segment as _segment

                        segs = await _segment(
                            geo_img_bytes,
                            labels,
                            boxes=cast("list[dict[str, Any]]", dets),
                        )
                        seg_by = {
                            str(s.get("label", "")).lower().strip(): s for s in segs
                        }

                        def _border(name: str) -> list[list[float]] | None:
                            key = name.lower().strip()
                            s = seg_by.get(key) or next(
                                (v for k, v in seg_by.items() if k and (k in key or key in k)),
                                None,
                            )
                            poly = s.get("polygon") if s else None
                            return poly if poly and len(poly) >= 3 else None

                        for e in need_added:
                            b = _border(e.name)
                            if b:
                                e.border = b
                        for u in need_updated:
                            b = _border(u.match_name)
                            if b:
                                u.border = b
                    except Exception as exc:  # outlines are optional
                        log(
                            "info",
                            "extract.segment_failed",
                            error=f"{type(exc).__name__}: {exc}",
                        )
            log(
                "info",
                "extract.localized",
                located=sum(1 for e in result.added if e.bbox)
                + sum(1 for u in result.updated if u.bbox),
                total=len(result.added) + len(result.updated),
            )
        except Exception as exc:  # best-effort — geometry localization is optional
            log("info", "extract.localize_failed", error=f"{type(exc).__name__}: {exc}")

    # Estimate the camera instead of assuming top-down (maps are often 2.5D).
    # Returned on the response so the web side can store it on the node and
    # back-project the localized boxes at the right angle. Best-effort.
    view: ViewEstimate | None = None
    if geo_img_bytes:
        try:
            from providers import view_estimator as _view

            view = await _view.estimate_view(geo_img_bytes, body.caption)
            log(
                "info",
                "extract.view",
                view_level=view["level"],
                projection=view["projection"],
                pitch_deg=view["pitch_deg"],
            )
        except Exception as exc:
            log("info", "extract.view_failed", error=f"{type(exc).__name__}: {exc}")

    def _entity_payload(e: llm_provider.ExtractedEntity) -> dict:
        return {
            "kind": e.kind,
            "name": e.name,
            "appearance": e.appearance,
            "aliases": e.aliases,
            "facts": e.facts,
            "state": e.state,
            "confidence": e.confidence,
            "bbox": e.bbox,
            "border": e.border,
        }

    return JSONResponse(
        {
            "result": {
                "added": [_entity_payload(e) for e in result.added],
                "updated": [
                    {
                        "match_name": u.match_name,
                        "changes": u.changes,
                        "confidence": u.confidence,
                        "bbox": u.bbox,
                        "border": u.border,
                    }
                    for u in result.updated
                ],
            },
            "view": view,
            # C12: the estimator's read as a ViewSpec, ONLY when confident
            # enough to become node truth (>= 0.7). The web extract route
            # PATCHes it onto the node's scene_view.view (never over a user
            # pin) so later zooms/ascends inherit the image's REAL projection.
            "view_spec": (
                _estimate_view_spec(cast("dict[str, object]", view))
                if view is not None and float(view.get("confidence", 0.0)) >= 0.7
                else None
            ),
            "trace_id": trace_id,
        },
        headers={"X-Trace-Id": trace_id},
    )


def _estimate_view_spec(view: dict[str, object]) -> dict[str, object]:
    from providers.prompt_library import policy as view_policy

    return cast("dict[str, object]", view_policy.estimate_to_view_spec(view))


@fastapi_app.post("/edit-entities")
async def edit_entities_endpoint(req: Request, body: EditEntitiesBody):
    """Turn an NL instruction into structured geo edits + a blast-radius (P5).

    Gated by GEOMETRIC_WORLD (403 when off → behaves as if absent). The web
    layer applies the returned edits to the world_map and surfaces the
    blast-radius as a "restage N scenes?" confirm. One text-LLM call; no
    Mongo/R2 here — the edits are just structured JSON.
    """
    from obs import TRACE_HEADER, bind_trace, log, record_error
    from providers import llm as llm_provider
    from providers import spend

    trace_id = bind_trace(req.headers.get(TRACE_HEADER) or body.trace_id)
    if not _geometric_world_on():
        return _gate_json("geometric world disabled (set GEOMETRIC_WORLD=1)", trace_id)
    guard = _paid_guard(req, trace_id, body.session_id)
    if guard is not None:
        return guard
    spend.record_vlm_call(body.session_id)
    log(
        "info",
        "edit_entities.request",
        session_id=body.session_id,
        instruction_len=len(body.instruction or ""),
        entity_count=len(body.entities),
    )
    try:
        plan = await llm_provider.edit_entities_nl(
            instruction=body.instruction,
            entities=[e.model_dump() for e in body.entities],
            references=body.references,
            scene_view=body.scene_view.model_dump() if body.scene_view else None,
        )
    except Exception as exc:
        record_error("edit_entities", exc, session_id=body.session_id)
        return _err_json(exc, trace_id)
    return JSONResponse(
        {
            "plan": {"edits": plan.edits, "blast_radius": plan.blast_radius},
            "trace_id": trace_id,
        },
        headers={"X-Trace-Id": trace_id},
    )


class PlanWorldBody(BaseModel):
    session_id: str
    description: str
    answers: list[str] = Field(default_factory=list, max_length=8)
    trace_id: str | None = None


@fastapi_app.post("/plan-world")
async def plan_world_endpoint(req: Request, body: PlanWorldBody):
    """Describe a place -> a logical object world (B1, WORLD_FROM_DESCRIPTION).

    Parse the description into a SceneGraph (one text-LLM call), then run the pure
    deterministic solver server-side. Returns {graph, solved, trace_id}: `solved`
    is the WorldEntityGeo[] ready for upsertEntityGeos, or null when the graph is
    BLOCKED (hard contradiction / over-pack / empty-region collision) -> the
    client must ASK first. Gated by WORLD_FROM_DESCRIPTION (403 when off). One LLM
    call + pure CPU; no Mongo/R2 here.
    """
    import time
    from dataclasses import asdict

    from obs import TRACE_HEADER, bind_trace, log, record_error
    from providers import llm as llm_provider
    from providers import spend
    from providers.geometry_checks import check_geo_entities
    from providers.layout_solver import solve_layout

    trace_id = bind_trace(req.headers.get(TRACE_HEADER) or body.trace_id)
    if not env_flag("WORLD_FROM_DESCRIPTION"):
        return _gate_json("describe-a-place disabled (set WORLD_FROM_DESCRIPTION=1)", trace_id)
    guard = _paid_guard(req, trace_id, body.session_id)
    if guard is not None:
        return guard
    spend.record_vlm_call(body.session_id)
    log("info", "plan_world.request", session_id=body.session_id,
        description_len=len(body.description or ""), answers=len(body.answers))
    try:
        graph = await llm_provider.plan_world_from_description(body.description, body.answers or None)
        result = solve_layout(graph)
    except Exception as exc:
        record_error("plan_world", exc, session_id=body.session_id)
        return _err_json(exc, trace_id)
    # Union the solver's mechanical questions (Layer B, blocking-first) with the
    # planner's (Layer A), deduped + capped at 2.
    questions = list(dict.fromkeys([*result.clarifiers, *graph.clarifiers]))[:2]
    graph_dict = asdict(graph)
    graph_dict["clarifiers"] = questions
    solved = None
    if not result.blocked:
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        solved = [{**g, "updated_at": now} for g in result.geos]
        # Anchor: the solver is pure + golden-tested, but log any geometry
        # invariant break in its output so a regression surfaces in traces.
        geo_issues = check_geo_entities(solved)
        if geo_issues:
            log("warn", "plan_world.geo_issues", session_id=body.session_id,
                count=len(geo_issues), issues=[str(i) for i in geo_issues][:8])
    return JSONResponse(
        {"graph": graph_dict, "solved": solved, "trace_id": trace_id},
        headers={"X-Trace-Id": trace_id},
    )


@fastapi_app.get("/health")
async def health() -> dict:
    return {"ok": True, "service": APP_NAME}


@fastapi_app.get("/status")
async def status() -> dict:
    from obs import status_payload

    return await status_payload(APP_NAME)


@fastapi_app.get("/models")
async def models() -> dict:
    """The image-model registry (slug + capabilities) for pickers — the dev
    model dropdown reads this through the web's /api/models proxy."""
    from providers import model_router

    return {"models": model_router.registry()}


class ModerateTextBody(BaseModel):
    text: str


@fastapi_app.post("/moderate-text")
async def moderate_text(body: ModerateTextBody) -> dict:
    """Thin wrapper over providers/moderation.flagged for web-side flows
    (gallery publish). MODERATE_PROMPTS off -> instantly allowed; fail-open
    inside the module, same as the generate-path check."""
    from providers import moderation

    blocked, reason = await moderation.flagged(body.text)
    return {"allowed": not blocked, "reason": reason}


@fastapi_app.get("/trace/recent")
async def trace_recent(limit: int = 50) -> dict:
    """Return the in-memory ring buffer of recent completed traces.

    Powers the /admin/trace dashboard. Buffer is bounded (TRACE_BUFFER_MAX,
    default 200) and process-local, so this is for ops/dev visibility, not
    a long-term store.
    """
    from obs import recent_traces

    clamped = max(1, min(int(limit), 200))
    return {"ok": True, "service": APP_NAME, "traces": recent_traces(clamped)}


@fastapi_app.get("/trace/abort-stats")
async def trace_abort_stats(limit: int = 100) -> dict:
    """Return aggregated stale-click stats: counts + wasted ms + $ per stage.

    The bench/audit deliverable from the Bet E plan — confirms or refutes
    the $200-400/month stale-click waste estimate by tracking every
    client-disconnect during the SSE pipeline.
    """
    from obs import abort_stats

    clamped = max(0, min(int(limit), 500))
    return {"ok": True, "service": APP_NAME, **abort_stats(clamped)}


@app.function(secrets=secrets, min_containers=0, timeout=600)
@modal.asgi_app()
def fastapi_ingress():
    return fastapi_app
