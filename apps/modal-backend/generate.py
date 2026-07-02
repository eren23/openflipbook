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
    from providers.geometry import ProjectedEntity as ProjectedEntityDict
    from providers.view_estimator import ViewEstimate
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from _env import env_flag

APP_NAME = "openflipbook-generate"

# Modal kills the container at this wall-clock limit — the render/edit loops
# derive their cumulative deadline from it so a long critic-retry enter always
# finishes with its best attempt instead of dying at the edge as a 502.
INGRESS_TIMEOUT_S = 900

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
            except Exception as exc:  # best-effort: a SAM3 failure keeps the detector boxes
                from obs import log

                log("warn", "grounding.sam3_failed", error=f"{type(exc).__name__}: {exc}")
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

        log("warn", "grounding.failed", error=f"{type(exc).__name__}: {exc}")
        return result, None
    # `repaired` = the kept image differs from what we rendered (a corrective edit
    # actually survived), not merely that a repair was attempted.
    return loop_res.image, _grounding_summary(
        loop_res.report,
        repaired=loop_res.image is not result,
        iterations=loop_res.iterations,
    )


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
    from providers import spend

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
            from providers.generate_modes.edit import stream_edit

            async for frame in stream_edit(
                body,
                trace_id,
                _sse=_sse,
                _abort_if_disconnected=_abort_if_disconnected,
                _condition_url_for_role=_condition_url_for_role,
            ):
                yield frame
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

        # Tap/query single-`final` path: click resolution, planning, the
        # enter_scene / zoom_continue / fresh op split, the judged render loop
        # on deliberate-camera enters, grounding, and final assembly.
        from providers.generate_modes.tap import stream_tap

        async for frame in stream_tap(
            body,
            trace_id,
            started=started,
            effective_web_search=effective_web_search,
            ingress_timeout_s=INGRESS_TIMEOUT_S,
            _sse=_sse,
            _abort_if_disconnected=_abort_if_disconnected,
            _condition_url_for_role=_condition_url_for_role,
            _world_mode_on=_world_mode_on,
            _match_world_entity=_match_world_entity,
            _view_spec_for=_view_spec_for,
            _layout_register_mismatch=_layout_register_mismatch,
            _layout_clause_for=_layout_clause_for,
            _camera_clause_for=_camera_clause_for,
            _topdown_clause_for=_topdown_clause_for,
            _same_place_judge=_same_place_judge,
            _vlm_grounding_on=_vlm_grounding_on,
            _vlm_grounding_repair_on=_vlm_grounding_repair_on,
            _run_grounding=_run_grounding,
        ):
            yield frame
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
    # Decode the image once for both geometry passes (localize + view-estimate)
    # and start the camera estimate NOW — it needs only pixels + caption, so it
    # overlaps the whole extract→detect→segment chain instead of tailing it
    # (the geo overlay used to lag the image by the full sequential sum).
    geo_img_bytes = b""
    if _geometric_world_on():
        try:
            _, _, _gb64 = body.image_data_url.partition(",")
            geo_img_bytes = base64.b64decode(_gb64) if _gb64 else b""
        except Exception:
            geo_img_bytes = b""
    view_task: _asyncio.Task[ViewEstimate] | None = None
    if geo_img_bytes:
        from providers import view_estimator as _view

        view_task = _asyncio.create_task(
            _view.estimate_view(geo_img_bytes, body.caption)
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
        if view_task is not None:
            view_task.cancel()
        return _err_json(exc, trace_id)

    # Localize the catalogued entities so the world map can seed and the overlay
    # can draw. The extractor's bbox is best-effort and often empty on dense
    # images; the purpose-built detector reliably returns one box per label.
    # Detector boxes are centre-based → store top-left for the EntityBBox shape.
    # Gated + best-effort: a failure here never blocks the extract response.
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
            located = sum(1 for e in result.added if e.bbox) + sum(
                1 for u in result.updated if u.bbox
            )
            total = len(result.added) + len(result.updated)
            # Zero located out of a non-empty catalogue means the overlay and
            # the world map get nothing this pass — that's a warn, not a stat.
            log(
                "warn" if total and not located else "info",
                "extract.localized",
                located=located,
                total=total,
            )
        except Exception as exc:  # best-effort — geometry localization is optional
            log("warn", "extract.localize_failed", error=f"{type(exc).__name__}: {exc}")

    # Estimate the camera instead of assuming top-down (maps are often 2.5D).
    # Returned on the response so the web side can store it on the node and
    # back-project the localized boxes at the right angle. Best-effort.
    view: ViewEstimate | None = None
    if view_task is not None:
        try:
            view = await view_task
            log(
                "info",
                "extract.view",
                view_level=view["level"],
                projection=view["projection"],
                pitch_deg=view["pitch_deg"],
            )
        except Exception as exc:
            log("warn", "extract.view_failed", error=f"{type(exc).__name__}: {exc}")

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


@app.function(secrets=secrets, min_containers=0, timeout=INGRESS_TIMEOUT_S)
@modal.asgi_app()
def fastapi_ingress():
    return fastapi_app
