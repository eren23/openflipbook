"""Tap/query single-`final` SSE stream, extracted from generate._event_stream.

The default path: resolve the click to a subject (unless prefetched), plan the
page, split the op via model_router.select_operation (enter_scene /
zoom_continue / fresh), render — judged render loop on deliberate-camera
enters, draft+main dual-task drive on the fresh path — then ground and stream
the single `final` frame. Behaviour is byte-identical to the former inline
block; generate.py's stream helpers and view/geometry/grounding helpers
(`_sse`, `_abort_if_disconnected`, `_condition_url_for_role`, `_view_spec_for`,
`_run_grounding`, ...) are threaded in as parameters, and the cumulative loop
deadline derives from the caller's `started` + `ingress_timeout_s`.
"""

from __future__ import annotations

import asyncio as _asyncio
import base64
import contextlib
import time as _time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TYPE_CHECKING, Any, cast

from _env import env_flag
from obs import log
from providers import image as image_provider
from providers import image_edit as image_edit_provider
from providers import llm, model_router, spend

if TYPE_CHECKING:
    from generate import GenerateBody, WorldContextEntity
    from providers.geometry import ProjectedEntity as ProjectedEntityDict
    from providers.judge import JudgeResult
    from providers.render_loop import Attempt


# The click classifier's `enter_as` → the planner's render mode.
_ENTER_AS_TO_RENDER: dict[str, str] = {
    "scene": "place_scene",
    "submap": "place_submap",
    "explainer": "explainer",
}

# Classic-mode twin (TAP_ZOOM_CONTINUE): a tap on a concrete place/thing
# zoom-continues the tapped pixels (Kontext) instead of fresh-generating a
# lookalike — the region crop the client already sends finally BITES (the
# fresh path's fal nano ignores refs). Register split on purpose: `submap`
# rides the cartographic zoom register; `scene` rides place_closeup's "view"
# register ("from the SAME viewpoint the reference shows") so a tapped castle
# in a watercolor scene doesn't get map wording. `explainer` maps to nothing —
# concepts/diagram parts keep today's fresh labelled explainer.
_CLASSIC_ENTER_AS_TO_RENDER: dict[str, str] = {
    "scene": "place_closeup",
    "submap": "place_submap",
}


def _classic_zoom_mode(enter_as: str | None) -> str | None:
    """The classic tap's zoom render mode, or None to stay fresh."""
    if not env_flag("TAP_ZOOM_CONTINUE", "true"):
        return None
    return _CLASSIC_ENTER_AS_TO_RENDER.get((enter_as or "").strip().lower())


async def stream_tap(
    body: GenerateBody,
    trace_id: str,
    *,
    started: float,
    effective_web_search: bool,
    ingress_timeout_s: float,
    _sse: Callable[..., bytes],
    _abort_if_disconnected: Callable[[str], Awaitable[None]],
    _condition_url_for_role: Callable[[GenerateBody, str], str | None],
    _world_mode_on: Callable[[bool], bool],
    _match_world_entity: Callable[[list[WorldContextEntity], str | None], dict | None],
    _view_spec_for: Callable[..., dict | None],
    _layout_register_mismatch: Callable[[GenerateBody, dict | None], bool],
    _layout_clause_for: Callable[..., str],
    _camera_clause_for: Callable[[GenerateBody, dict | None], str],
    _topdown_clause_for: Callable[[GenerateBody], str],
    _same_place_judge: Callable[[Any], Any],
    _vlm_grounding_on: Callable[[], bool],
    _vlm_grounding_repair_on: Callable[[], bool],
    _run_grounding: Callable[..., Awaitable[tuple[Any, dict[str, Any] | None]]],
) -> AsyncIterator[bytes]:
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
            # Classic warm tap: the prefetch cache carried the classifier's
            # enter_as — route zoomable taps to the faithful Kontext zoom
            # without a second resolve. Needs a region ref to bite (else
            # select_operation falls back to fresh anyway).
            if (
                not effective_world_mode
                and not render_mode
                and body.condition_image_urls
            ):
                mapped = _classic_zoom_mode(body.prefetched_enter_as)
                if mapped:
                    render_mode = mapped
                    log(
                        "info",
                        "tap.zoom_route",
                        enter_as=body.prefetched_enter_as,
                        render_mode=mapped,
                        source="prefetched",
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
            elif (
                not effective_world_mode
                and not render_mode
                and body.condition_image_urls
            ):
                # Classic cold tap: the in-band resolve just classified it.
                mapped = _classic_zoom_mode(resolution.enter_as)
                if mapped:
                    render_mode = mapped
                    log(
                        "info",
                        "tap.zoom_route",
                        enter_as=resolution.enter_as,
                        render_mode=mapped,
                        source="resolved",
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
    # A JUDGED path that degraded (judge failure → the kept attempt shipped
    # with no critic verdict) flags the final so the UI can mark the render.
    # Paths that are unjudged BY DESIGN (fresh, zoom_continue) never set it.
    render_unjudged = False

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
            # Leave 180s for the final attempt's judge tail + post-loop
            # grounding/encode; floor of 60s so one slow planner can't
            # zero the render budget.
            loop_deadline = _time.monotonic() + max(
                60.0,
                ingress_timeout_s - 180.0 - (_time.perf_counter() - started),
            )
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
                deadline_s=loop_deadline,
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
            kept = next((a for a in loop_attempts if a.image is result), None)
            render_unjudged = kept is not None and kept.conformance is None
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
    if render_unjudged:
        # Additive: only when a judged path degraded (critics unavailable) —
        # the UI shows an "unverified render" chip so flap-era style drift
        # is visible instead of silent.
        final_payload["render_unjudged"] = True
    if layout_suppressed:
        # Additive (UI_AUDIT #11): layout steering was dropped because the
        # bins were projected for a different camera register — the debug
        # HUD counts these so suppression frequency is finally observable.
        final_payload["layout_suppressed"] = True
    yield _sse(final_payload, trace_id)
    log(
        "info",
        "sse.generate.end",
        duration_ms=round((_time.perf_counter() - started) * 1000, 2),
    )
