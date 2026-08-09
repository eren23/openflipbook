# Concern 06 — weak types · rerun 2026-08-09 · research report

Branch `chore/cleanup-rerun-2026-08-09` @ `e75e3b1`. Delta audited: `83e3262..HEAD`
(+16k/-4.4k; llm.py dissolved into `providers/llm/`, generate.py carved into
`providers/generate_modes/`, segmenter SAM3 arm, ViewSpec view grammar, §4 register).

**Baseline (verified read-only):** `cd apps/modal-backend && .venv/bin/mypy providers obs.py generate.py`
→ `Success: no issues found in 48 source files`. Density map from the briefing verified
by grep (tap.py resolves to `providers/generate_modes/tap.py`: 12 hits).

**Semantics pre-verified:** every mypy-tricky construct below was probed under the repo
venv's mypy with the providers-strict flags via two throwaway probe scripts —
one asserting the PASS cases (TypedDict `.get(k, default)`, explicit-key TypedDict
literal into `list[Detection]`, typed param + nested-func local shadow, `-> GeneratedImage`
closures binding `ImageT: Rendered` in `iter_attempts`, `Callable[[Any], Callable[[bytes,
bytes], Awaitable[JudgeResult]]]`, unparameterized-`Task` + `result: Any` erasure) and
one asserting the expected FAIL (`**dict[str,float]` spread into a TypedDict literal
errors with `[typeddict-item]` — proves the one refine restructure is required, not gratuitous).

Existing `# type: ignore` inventory (warn_unused_ignores is on): `view_estimator.py:78,83`,
`prompt_library/policy.py:295`, `llm/client.py:129`. **None sit on lines any proposal
touches; no proposal changes the types feeding them.** No ignore becomes redundant.

---

## SAFE-AUTO findings

### Group A — segmenter ⟷ Detection/SegmentEntity: kill the cast round-trip (flagship)

`detector.detect() -> list[Detection]` and `segment() -> list[SegmentEntity]` are already
strong. The segmenter's weak *parameters* force generate.py to cast strong→weak→strong at
every call. Both types exist (`providers/detector.py:20`, `providers/segmenter.py:30`).
Segmenter needs one `TYPE_CHECKING` import: `from .detector import Detection` (no runtime
cycle: detector does not import segmenter; only generate glues them).

| # | file:line | current → proposed | evidence | conf |
|---|---|---|---|---|
| A1 | `providers/segmenter.py:64` | `detector_box_to_sam_box(det: dict[str, Any], …)` → `det: Detection` | Only reads `x_pct/y_pct/w_pct/h_pct` via `.get(k, default)` — all required `Detection` keys (probe 1 green). Only non-test caller is `_segment_sam3` whose `boxes` are detector output (A3/A4). | high |
| A2 | `providers/segmenter.py:93-95` | `refine_detections_with_masks(detections: list[dict[str, Any]], segments: list[dict[str, Any]]) -> list[dict[str, Any]]` → `(detections: list[Detection], segments: list[SegmentEntity]) -> list[Detection]` | Sole caller generate.py:732 passes `observed` (= `detector.detect(...)`, `list[Detection]`) and `segs` (= `segment(...)`, `list[SegmentEntity]`) — today via 2 casts, then casts the result BACK to `list[Detection]` (generate.py:730). Output branches: pass-through `d` (Detection) or `{"label", "score", + 4 coords}` = exactly Detection. **Companion restructure required:** the `{…, **box}` spread at :107 must become explicit keys (`"x_pct": box["x_pct"]`, …4 keys) — spread of `dict[str, float]` into a TypedDict literal is a mypy error (spread_probe), explicit keys pass (probe 2). Runtime-identical: `box_from_polygon` (:79) visibly returns exactly those 4 keys. | high |
| A3 | `providers/segmenter.py:238` | `segment(..., boxes: list[dict[str, Any]] \| None)` → `boxes: list[Detection] \| None` | `boxes` is documented as "the detector's output for these labels"; both non-test callers (generate.py:728, :1565) pass `list[Detection]` through a cast. Only consumed by `_segment_sam3`. Test/bench callers (map_corpus, recon_bench, world_bench) are not mypy-gated; annotations don't enforce at runtime. | high |
| A4 | `providers/segmenter.py:258` | `_segment_sam3(..., boxes: list[dict[str, Any]] \| None)` → `list[Detection] \| None` | Pass-through of A3. `box_by` comprehension + `detector_box_to_sam_box(det, …)` typecheck (probe 3). The inner `one()` reassigns a LOCAL `boxes = result.get("boxes") or []` (:306) — a shadow, stays Any-ish from fal JSON; probe 3 confirms no interference. | high |
| A5 | `generate.py:728` | `boxes=cast("list[dict[str, Any]]", observed)` → `boxes=observed` | Cast exists only because of A3's weak param. Leaving it after A3 would be a type error (list invariance). | high |
| A6 | `generate.py:730-736` | delete outer `cast("list[Detection]", …)` + both inner `cast("list[dict[str, Any]]", …)` → `observed = refine_detections_with_masks(observed, segs)` | After A2 the outer cast is cast-to-same-type → **warn_redundant_casts FAILS if kept**; inner casts become type errors. Mandatory companions. | high |
| A7 | `generate.py:1565` | `boxes=cast("list[dict[str, Any]]", dets)` → `boxes=dets` | `dets = await _detector.detect(...)` at :1539 is `list[Detection]`. Same as A5. | high |

Net: 4 signatures strengthened, **5 casts deleted**, 1 provably-identical dict-literal
restructure. generate.py already imports `Detection` under TYPE_CHECKING (:36).

### Group B — ViewSpec chain: the second cast round-trip (existing type `providers/prompt_library/types.ViewSpec`)

`policy.default_view() -> ViewSpec | None` is strong at the source; generate.py DOWNCASTS
it to `dict | None` (`cast("dict | None", …)`) and every strict-provider consumer casts
back UP (`cast("_ViewSpec | None", view)`). All bridged with the existing TypedDict.
Imports needed: TYPE_CHECKING `from providers.prompt_library.types import ViewSpec` (alias
`ViewSpecDict`) in generate.py's existing TYPE_CHECKING block, tap.py's (:30), image_edit.py
(add block), ascend.py (has function-level runtime import already). `ViewSpec.projection`
is a required key → `.get("projection")` returns `str` everywhere it's read.

| # | file:line | current → proposed | evidence | conf |
|---|---|---|---|---|
| B1 | `providers/image_edit.py:127` | `build_zoom_instruction(view: dict \| None)` → `view: ViewSpec \| None` + delete internal `cast("_ViewSpec \| None", view)` (:144 block) + the now-unused function-local `from typing import cast` / `_ViewSpec` imports (ruff F401 otherwise) | The body immediately casts to `_ViewSpec | None` to call `instructions.build_zoom_instruction(view: ViewSpec | None)` — the cast IS the missing annotation. Callers: tap.py:522 passes `view_spec if use_continuation else None` (ViewSpec | None after B4); instructions.py:727 internal (already typed); tests not gated. | high |
| B2 | `providers/image_edit.py:166` | `build_enter_instruction(view: dict \| None)` → `view: ViewSpec \| None` + delete internal cast (:192) + local-import cleanup | Same delegate pattern; target `instructions.build_enter_instruction(view: ViewSpec | None = None)` (instructions.py:797). Caller tap.py:597 passes `enter_view` (B4). | high |
| B3 | `generate.py:553-562` | `_view_spec_for(...) -> dict \| None` → `-> ViewSpecDict \| None`; wrap :570 `return sv.view.model_dump(exclude_none=True)` in `cast("ViewSpecDict", …)`; **delete** the :586 `cast("dict \| None", view_policy.default_view(...))` downcast | `default_view -> ViewSpec | None` (policy.py:132) — the current cast throws the type away. The model_dump cast is the established Jun-7 doctrine (Pydantic wire model `ViewSpec` dumps to exactly the TypedDict; parity-locked per types.py docstring + tests/test_geo_schema.py). Net casts: unchanged (one deleted, one added), but the type survives the function. | high |
| B4 | `providers/generate_modes/tap.py:95,96,98` | `_view_spec_for: Callable[..., dict \| None]` → `Callable[..., ViewSpecDict \| None]`; `_layout_register_mismatch: Callable[[GenerateBody, dict \| None], bool]` → `… ViewSpecDict \| None …`; `_camera_clause_for: Callable[[GenerateBody, dict \| None], str]` → `… ViewSpecDict \| None …` | tap's `view_spec`/`enter_view` locals then carry ViewSpec. All reads verified: `.get("projection")` (:440, :449, :550 — required key → `str`), pass-through to B1/B2/B5/B6. No key mutation (`view_spec[` grep: zero hits). Wire types unchanged (annotation-only). | high |
| B5 | `generate.py:606` | `_camera_clause_for(body, view: dict \| None)` → `view: ViewSpecDict \| None` + **delete** `cast("ViewSpecDict", view)` at :624 + the then-unused function-local `from providers.prompt_library.types import ViewSpec as ViewSpecDict` (:612) | The cast becomes cast-to-same-type → warn_redundant_casts fails if kept. `camera_lib.camera_clause` takes `ViewSpec` (typed). | high |
| B6 | `generate.py:630` | `_layout_register_mismatch(body, view: dict \| None)` → `view: ViewSpecDict \| None` | Body reads only `view.get("projection")` (:640) → `str`. | high |
| B7 | `providers/generate_modes/ascend.py:77-79,85-87` | `src_view: dict \| None = None` → `src_view: ViewSpecDict \| None = None`; move the cast from the consumer (`outward_clause(cast("ViewSpecDict \| None", src_view))`) to the producer (`src_view = cast("ViewSpecDict", body.scene_view.view.model_dump(exclude_none=True))`) | Same model_dump erasure as B3; `instructions.outward_clause` takes `ViewSpec | None` (that is what the existing cast targets). Cast count unchanged; the local carries the real type. The existing function-level `ViewSpecDict` import stays used. | high |
| B8 | `generate.py:1670-1673` | `_estimate_view_spec(view: dict[str, object]) -> dict[str, object]` → `-> ViewSpecDict` + delete the `cast("dict[str, object]", …)` return downcast | `policy.estimate_to_view_spec(est: dict[str, object]) -> ViewSpec` (policy.py:286). Input param deliberately stays `dict[str, object]` (tolerant-reader twin of the target). Sole consumer (:1660) drops the result into a JSONResponse payload — any dict shape serializes. | high |

Net: 8 signatures/locals strengthened, **4 casts deleted**, 2 casts relocated
producer-side, 2 dead function-local imports removed.

### Group C — render closures `-> Any` → `-> GeneratedImage` (the Jun-13 REPORT batch, now due)

Jun-13 adjudicated the `_render_*(suffix) -> Any` family "stricter-and-correct →
fold in when a maintainer touches this block". The block WAS touched: it moved from
loose-gated generate.py into **strict** `providers.generate_modes.*`. All render
providers are typed (`image_edit.edit_image/continue_image -> GeneratedImage`
(image_edit.py:74/:202), `inpaint.inpaint_image -> GeneratedImage` (inpaint.py:47)), so
`warn_return_any` is satisfied. `Attempt.image`/`EditAttempt.image` stay `Rendered`
(non-generic dataclasses) → the `result`/`img`-erasure locals are untouched (probes 4-5).
Imports: TYPE_CHECKING `from providers.image import GeneratedImage` in tap.py/ascend.py/edit.py.

| # | file:line | current → proposed | evidence | conf |
|---|---|---|---|---|
| C1 | `tap.py:677` | `_render_zoom(instr: str) -> Any` → `-> GeneratedImage` | Returns `continue_image(...)`. Consumers: `first.jpeg_bytes` (:707), `_verdicts(first)`, returned from `_judged_zoom`. | high |
| C2 | `tap.py:687` | `_judged_zoom() -> Any` → `-> GeneratedImage` | Every return is `first`/`second` from C1. `create_task(...)` lands in `main_task: _asyncio.Task | None` (unparameterized) → `result = await main_task` stays Any — **no cascade into the :658 erasure** (probe 5). | high |
| C3 | `tap.py:730` | `_verdicts(img: Any)` → `img: GeneratedImage` | Called only with `first`/`second` (C1). Reads `img.jpeg_bytes`. Return already typed `tuple[JudgeResult, JudgeResult | None]`. | high |
| C4 | `tap.py:837` | `_render_enter_attempt(suffix, attempt_index) -> Any` → `-> GeneratedImage` | Returns `edit_image(...)`. Feeds `iter_attempts(render_for_attempt=…)` — `ImageT: Rendered` binds `GeneratedImage` (has `jpeg_bytes`); probe 4 green. | high |
| C5 | `tap.py:855` | `_render_enter(suffix) -> Any` → `-> GeneratedImage` | Returns C4. Primary `render=` arg of the same loop. `loop_attempts: list[Attempt]` and `conclude(...).image` (`Rendered`) unchanged → `result` erasure intact. | high |
| C6 | `ascend.py:167` | `_render_ascend(suffix) -> Any` → `-> GeneratedImage` | Returns `edit_image(source_url, instr)`. Sole consumer `iter_edit_attempts`. The `img = cast("Any", asc_res.best.image)` erasure at :192 is independent (`EditAttempt.image: Rendered`) and stays. | high |
| C7 | `edit.py:220` | `_render_judged_edit(suffix) -> Any` → `-> GeneratedImage` | Returns `edit_image(...)`. Sole consumer `iter_edit_attempts`; the downstream erasure is already explicit (`judged_image: Any` :268, KEEP per binding). No cascade. | high |
| C8 | `edit.py:80` + `edit.py:117` | `_render_inpaint(suffix) -> Any` → `-> GeneratedImage` **paired with** `inp_result: Any = await _render_inpaint("")` at :117 | :117 (if-branch, lexically first) would otherwise pin `inp_result` to GeneratedImage while :163 assigns `edit_loop_result.image` (`Rendered`) → incompatible-assignment. The explicit `: Any` is the same protocol-erasure idiom as tap.py:658 / edit.py:268 (reads `.mime_type`/`.model` at :175/:178/:185, not on `Rendered`). Apply as a pair or not at all. | high |

### Group D — `_same_place_judge` pair (existing callable shape from `render_loop.iter_attempts`)

| # | file:line | current → proposed | evidence | conf |
|---|---|---|---|---|
| D1 | `generate.py:445` | `_same_place_judge(judge_mod: Any) -> Any` → `-> Callable[[bytes, bytes], Awaitable[JudgeResult]]` (param stays `Any` — lazily-imported module, attr-read honesty) | Both returns: `judge.score_step_in(region_crop: bytes, candidate: bytes) -> JudgeResult` (judge.py:271) and `judge.score_continuation(region_crop: bytes, candidate: bytes) -> JudgeResult` (judge.py:246). The spelling is `iter_attempts`'s own `judge_same_place` param type (render_loop.py:185). generate.py is loose (no warn_return_any) → returning the Any attr into the declared type is legal. Needs TYPE_CHECKING `from providers.judge import JudgeResult` in generate.py (Callable/Awaitable already imported :25). | high |
| D2 | `tap.py:100` | `_same_place_judge: Callable[[Any], Any]` → `Callable[[Any], Callable[[bytes, bytes], Awaitable[JudgeResult]]]` | `step_in = _same_place_judge(judge)` (:725) is awaited with `(region_bytes, img.jpeg_bytes)` — `region_bytes: bytes` guarded non-None at :713; passed as `judge_same_place=` (:905) where `iter_attempts` demands exactly this type. `JudgeResult` already in tap's TYPE_CHECKING (:33). Probe 4 green. | high |

### Group E — generate.py: the 8 missing public return annotations (verified; the briefed "~8")

AST scan confirms exactly 8 top-level defs without return annotations, all framework
entry points (the pyproject override stays untouched; these are in-module annotations).
**Implementation guard (verified in the installed FastAPI 0.136.3,
`fastapi/routing.py:847-867`):** a return annotation that is a **Response subclass** sets
`response_model = None` — byte-identical to today's no-annotation behavior
(`get_typed_return_annotation` maps empty → None). A **union** (`StreamingResponse |
JSONResponse`) is NOT a Response subclass under `lenient_issubclass` → FastAPI would take
it as a response_model and **crash at import** (`Invalid args for response field`). So
sse_generate gets the base class, never the union.

| # | file:line | proposed | evidence (all return exprs traced by AST) | conf |
|---|---|---|---|---|
| E1 | `generate.py:1127` `sse_generate` | `-> Response` (+ add `Response` to the `fastapi.responses` import) | returns `limited` (JSONResponse), 400 `JSONResponse`, `StreamingResponse` — both ⊆ Response. Union forbidden (above). | high |
| E2 | `generate.py:1163` `animate` | `-> JSONResponse` | 3 returns, all JSONResponse. | high |
| E3 | `generate.py:1246` `resolve_click` | `-> JSONResponse` | 3 returns, all JSONResponse. | high |
| E4 | `generate.py:1326` `precompute_candidates` | `-> JSONResponse` | `guard` = `_paid_guard(...)` → `JSONResponse | None` narrowed; success/error JSONResponse. | high |
| E5 | `generate.py:1424` `extract_entities_endpoint` | `-> JSONResponse` | top-level returns: guard, `_err_json` (→JSONResponse, :831), success JSONResponse. (Inner defs at :1516/:1548/:1578/:1627 are separate functions.) | high |
| E6 | `generate.py:1677` `edit_entities_endpoint` | `-> JSONResponse` | `_gate_json`/`guard`/`_err_json`/success — all JSONResponse. | high |
| E7 | `generate.py:1730` `plan_world_endpoint` | `-> JSONResponse` | same four shapes as E6. | high |
| E8 | `generate.py:1851` `fastapi_ingress` | `-> FastAPI` | returns `fastapi_app` (`FastAPI(...)` :71); `FastAPI` imported :39. `@modal.asgi_app()` calls the function, ignores annotations. | high |
| E9 | `generate.py:75` `_shared_token_gate(request, call_next: Any) -> Any` | `call_next: Callable[[Request], Awaitable[Response]]`, `-> Response` | Starlette http-middleware contract (`RequestResponseEndpoint`); returns 401 `JSONResponse` or `await call_next(request)`. Middleware is not an APIRoute — no response-model introspection. Depends on E1's `Response` import. | high |

---

## REPORT-ONLY

| # | file:line | issue | why not auto |
|---|---|---|---|
| R1 | `providers/segmenter.py:114` | `polygon_from_mask(mask_img: Any)` — honest type is `PIL.Image.Image` (Pillow ships `py.typed`; both callers pass `Image.open(...)`) | Pillow 12 stubs: `Image.load() -> core.PixelAccess \| None` (Image.py:969) → annotating surfaces a REAL Optional deref at :129 `px[x, y]`; going green needs a runtime None-guard (`if px is None: return []`). Type-only rule says hand it over — the guard is arguably a genuine robustness fix, maintainer's call. |
| R2 | `providers/llm/client.py:185` | `_system_message(text) -> Any` could be `-> dict[str, Any]` (both branches return dicts) | Marginal: the value feeds the deliberately-loose `messages: list[Any]` family (doc-06 KEEP doctrine). Not worth standalone churn. |
| R3 | `apps/web/components/waterfall-hud.tsx:199,201` | `window.setTimeout(loop, 90) as unknown as number` — `window.setTimeout` already returns `number` in the DOM lib; cast likely redundant | Pre-delta (f98332f), cosmetic, needs a tsc run to confirm the lib resolution; zero safety gain. |
| R4 | SSE wire dicts: `tap.py:1101 final_payload`, `:1139 sv_stamp`, `edit.py:101 verdict`, `:172 final_frame`, `ascend.py:242 ascend_payload` | `dict[str, Any]` wire bags; a typed twin would be a `GenerateFinalEvent`-mirror TypedDict parity-locked to packages/config | **Concern-04 jurisdiction** — needs a NEW shared cross-boundary type (+ a parity gate like test_geo_schema.py). Reported as a need, not minted. KEEP meanwhile. |
| R5 | `providers/llm/world.py:323-325` `edit_entities_nl(entities: list[dict[str, Any]], scene_view: dict[str, Any] \| None)` | raw wire dicts from the web layer; a provider-side `SceneView`/entity TypedDict twin would type them | Same **concern-04** class (new shared twin of the Pydantic wire models). Bodies read tolerantly via `.get` — boundary-correct today. |

---

## KEEP (adjudicated against the doc-06 / Jun-13 doctrine — no action)

- **`providers/llm/` package (client 35 · click 8 · planner 7 · extraction 10 · world 16 Any):**
  the #124 split transplanted the adjudicated llm.py families intact — SDK responses read
  structurally (`_choice_content`, `_parse_choice_json`, `_parse_tool_json`,
  `_extract_citations`, `_log_cache_usage`, `moderation.resp`), `messages: list[Any]`,
  JSON-Schema constants (`CLICK/CANDIDATES/PLAN/EXTRACTION/NEIGHBORS/ENTITY_EDIT/PLAN_WORLD_SCHEMA`),
  raw-JSON validator inputs (`_coerce_*`, `_parse_*`, `salvage_json`, `_safe_json`,
  `_validate_candidates(items: Any) -> list[ClickCandidate]` — strong output ✓),
  `parse_entity_edits -> list[dict[str, Any]]` (discriminated-union, explicit KEEP),
  `client: Any` (+`**kwargs`) in `_create_with_retry` — mock client injection
  (`mock.mock_llm_client()` rides a `type: ignore[return-value]` at client.py:129),
  `extra_body/span_ctx/response_sink/**kv`. New-in-delta members (`salvage_json`,
  `_strictify_schema`/`walk(node: Any)`/`_schema_strictifiable`/`_rung_kwargs`,
  `coordinate_scale.coerce_unit(value: Any)`) are the same families.
- **`obs.py` (18):** zero delta since 83e3262; logging/trace payload bags (`**kv: Any`,
  record dicts) — canonical KEEP.
- **`providers/geometry_checks.py` (9):** zero delta; Jun-13 table verbatim (validator
  inputs of UNTRUSTED dicts; typing them would assert what they're paid to check).
- **`providers/segmenter.py` residue:** `_clamp01(v: Any)`, `_parse_vertices(raw: Any)`,
  `parse_segments(payload: Any)` (strong `SegmentEntity` output ✓), `arguments: dict[str,
  Any]` (fal args), `messages: list[Any]` — Jun-13 KEEP rows.
- **Protocol-erasure (BINDING):** `tap.py:658 result: Any = None` (conclude().image is
  `Rendered`; reads `.mime_type/.model` at :1092/:1105/:1117), `edit.py:268 judged_image:
  Any` (carries the comment), `ascend.py:192 cast("Any", asc_res.best.image)`,
  generate.py `_run_grounding(result: Any) -> tuple[Any, …]` + `_verify(img: Any)` /
  `_repair(img, report) -> Any | None` + `_grounding_summary(report: Any)` (doc-06 explicit
  KEEP), and tap.py:103's mirroring `_run_grounding: Callable[..., Awaitable[tuple[Any,
  dict[str, Any] | None]]]`.
- **model_dump boundaries:** `tap.py:321 world_context_payload`, `_match_world_entity` /
  `_focus_world_entry -> dict | None` (they return `e.model_dump()`; a model return type
  would break the downstream `.get` readers — refactor, not annotation),
  `planner.world_context: list[dict[str, Any]]` + `_world_size_hint(entry)` (isinstance-
  guarded tolerant reads), `sv_stamp`/`obs` dumps.
- **`providers/mock.py` (5):** mirrors the SDK's own loose shapes (Jun-13 row). `image.py`
  (6): fal arg-builders + `resp.json()` (doc-06 out-of-scope class). `judge.py:142` /
  `view_estimator.py:124` / `detector.py:111` `messages: list[Any]`; `detector._clamp01` /
  `parse_detections(payload: Any)` (in-code KEEP comments); `view_estimator.parse_view
  (payload: Any)` (in-code KEEP comment).

## TS — delta adds ZERO weak types; briefed hits adjudicated

- `app/play/page.tsx:1815`, `e2e/share-continue.spec.ts:44`, `lib/world-helpers.test.ts:329`
  — the word "any" in **comments**; grep false-positives. Not findings.
- `lib/trace.test.ts:81` `@ts-expect-error force the missing-API branch` — canonical
  control-flow test shim (self-erroring if the suppression goes stale). KEEP.
- `app/admin/trace/page.tsx:16,24,28` `as unknown as T` — Jun-7-adjudicated server-action
  error-envelope casts (same helper, same pattern). KEEP.
- All other `as unknown as` = test mocks / deliberate malformed-wire injections
  (`1 as unknown as boolean` world.test/world-helpers.test), all `: unknown` = type-guard
  inputs / `JSON.parse` narrowing / event-bus payloads (waterfall-hud, debug-hud, hooks) —
  the exemplary boundary pattern per Jun-13. KEEP. `: any` in source: **0**. eslint
  no-explicit-any warning budget untouched (all proposals are Python; R3 is a cast, not `any`).

---

## Re-verification recipe (for the implementation pass)

1. Apply groups A-E (A and B are each all-or-nothing: the companion cast deletions are
   mandatory — warn_redundant_casts turns a leftover cast into a FAILURE, and a leftover
   weak cast into an arg-type error).
2. `cd apps/modal-backend && .venv/bin/ruff check . && .venv/bin/mypy providers obs.py generate.py`
   → expect `Success: … 48 source files` again (baseline identical).
3. `python3 -m pytest tests -q -m "not paid"` — behavior-preserving check (only runtime-
   adjacent edits: refine's dict-literal restructure (A2), cast moves (B3/B7), the E-group
   FastAPI annotations — Response-subclass-only, verified inert against routing.py:849).
4. Semantics probes were session-scratch scripts (not committed); their assertions are
   listed in the header above — re-derive from there if a construct needs re-proving.
5. E-group runtime smoke: `local_server` import (or the e2e-mock stack) proves no
   FastAPI response-field crash: endpoints annotated with Response subclasses only.

## Draft verdict-table row (Jun-13 style)

| # | Concern | Verdict | Action |
|---|---------|---------|--------|
| 6 | Weak types | 30 safe-auto annotations, TS: 0 | Two cast-round-trips dissolved with EXISTING types: segmenter pinned to `Detection`/`SegmentEntity` (4 sigs, −5 generate.py casts) and the ViewSpec view-grammar chain de-`dict`ed end-to-end (`_view_spec_for`/`_camera_clause_for`/`_layout_register_mismatch`/tap callables/`build_zoom+enter_instruction`/ascend `src_view`, −4 casts +2 relocated); the Jun-13 `_render_* -> Any` REPORT batch landed as `-> GeneratedImage` now that the closures live in strict `generate_modes` (8 sites; `result`/`judged_image`/`inp_result` erasures stay explicit `Any` per binding); `_same_place_judge` typed to `iter_attempts`' own callable shape; generate.py's 8 framework defs annotated (`-> JSONResponse`/`-> Response`/`-> FastAPI` — union return would crash FastAPI 0.136 at import, verified in routing.py; Response-subclass form verified inert) + middleware. 5 report-only (PIL `load() -> …\|None` guard, `_system_message`, waterfall-hud cast, 2 concern-04 needs: GenerateFinalEvent twin + provider-side SceneView twin). ~130 boundary `Any` re-adjudicated KEEP per doc-06/Jun-13 doctrine; llm.py→`llm/` split carried the families intact. TS delta: 0 new weak tokens (3 briefed "hits" were comment-text false positives; trace.test.ts is a canonical `@ts-expect-error`). Baseline mypy green (48 files) at e75e3b1; all tricky constructs pre-probed under the strict flags. |

---

IMPLEMENTED @ 8831cb9 — all 30 safe-auto sites landed at HEAD 089f7d4+1; gates: ruff clean, mypy 48 files green, backend 1015 passed/2 skipped, cov TOTAL 86.81% (floor 85), web vitest 832/832, eslint 17 warnings (cap 20, +0), madge 0 cycles. No site failed re-verification (generate.py anchors shifted +4 lines only).
