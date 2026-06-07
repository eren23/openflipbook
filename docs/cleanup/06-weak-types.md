# Cleanup 6 — Strengthen weak types

Workstream 6 of the sequenced code-quality cleanup. Scope: **remove weak types
(`Any` / `dict[str, Any]` in Python, `any` / `unknown` in TS) and replace them
with strong, researched types** — without inventing fake shapes for
genuinely-dynamic JSON. Behaviour-preserving (type-only); zero runtime change.

The witness for every strengthened geometry shape is the TS twin
`apps/web/lib/world-geometry.ts` + the canonical types in
`packages/config/src/index.ts` (`WorldVec2`, `ObserverPose`, `ProjectedEntity`,
`MapCrop`, `ViewEstimate`, `EntityBBox`, …). The two engines are a parity-mirror,
so pinning the Python dict shapes to those field names + value types is safe and
the golden-vector parity gate (`tests/world_bench/test_geometry.py`) still passes
unchanged.

## TL;DR

- **TS production code was already strongly typed.** One real site fixed
  (`scene_view?: unknown` → `SceneView`). Everything else flagged by the grep
  lives in `.next/` generated artifacts or test files (DOM mocks / control-flow
  casts) — left alone.
- **Python providers were the target.** Introduced 8 `TypedDict`s (+ 2 `Literal`
  unions) mirroring the TS shapes, and made the grounding loop generic over the
  image type instead of `Any`. The whole provider layer + `obs.py` + `generate.py`
  type-check clean under the strict mypy override.
- No `pyproject.toml` mypy-strict widening: the strict surface (`providers.*`,
  `obs`) already covers every module touched here. `generate.py` /
  `ltx_stream.py` / `local_server.py` stay loose by design (framework-driven
  FastAPI/Modal handlers); widening them would go red on untyped entry-point defs.

---

## Strengthened sites (file → new type)

### `providers/geometry.py` — 9× `dict[str, Any]` → TypedDicts

The 2.5D projection engine's inputs/outputs were untyped dict bags. Added
TypedDicts at the top of the module mirroring the TS witness exactly:

| TypedDict | mirrors (TS) | fields |
| --- | --- | --- |
| `WorldVec2` | `WorldVec2` | `x, y: float` |
| `ProjectInput` (`total=False`) | `ProjectInput` (`Pick<WorldEntityGeo, …>`) | `id, pos, height, footprint` (+ optional `label, elevation`) |
| `ObserverPose` (`total=False`) | `ObserverPose` | `pos, eye_height, gaze, fov` (+ optional `pitch`) |
| `ProjectedEntity` | `ProjectedEntity` | `id, label, x_pct, y_pct, w_pct, h_pct, depth, h_pos, v_pos, size` |
| `MapCrop` | `MapCrop` | `x, y, w, h: float` |
| `Neighbor` | `Neighbor` (in `world-geometry.ts`) | `id, bearing, dist` |

Signatures retyped:
- `project(entity: ProjectInput, observer: ObserverPose, aspect) -> ProjectedEntity | None`
- `project_scene(entities: list[ProjectInput], observer: ObserverPose, aspect) -> list[ProjectedEntity]`
- `crop_entities(entities: list[ProjectInput], crop: MapCrop) -> list[ProjectInput]`
- `neighbors_of(entities: list[ProjectInput], …) -> list[Neighbor]`

`total=False` on `ProjectInput` / `ObserverPose` is deliberate: it lets callers
omit the same optional fields the TS reads with `?? 0` (`elevation`, `pitch`,
`label`), matching the golden fixtures which pass plain JSON-decoded dicts. The
projector's required-key subscripts (`entity["pos"]`, `entity["height"]`) stay
valid under `total=False`.

### `providers/geometry_prompt.py` — 4× `dict[str, Any]` → `ProjectedEntity`

`layout_constraints`, `repair_instruction`, `_place_phrase`, and the local
`by_label` map all consume projected-layout dicts. Retyped to import and use the
`ProjectedEntity` TypedDict from `geometry.py` (single source of truth).

### `providers/detector.py` — `list[dict[str, Any]]` → `list[Detection]`

Added a `Detection` TypedDict (`label: str` + `x_pct/y_pct/w_pct/h_pct/score:
float`) — the centre-based box shape `parse_detections` emits and `grounding.diff`
consumes (mirrors `ProjectedEntity`'s box fields + the docstring contract).
- `parse_detections(payload: Any) -> list[Detection]`
- `detect(...) -> list[Detection]`

`payload` stays `Any` (raw VLM JSON reply, validated field-by-field) — see below.

### `providers/grounding.py` — `dict[str, Any]` + `Any` images → strong + generic

- `diff(expected: list[ProjectedEntity], observed: list[Detection], …)` — the two
  inputs now carry their real shapes; the internal `best` tuple is
  `tuple[int, float, Detection]`.
- The verify→repair loop was `image: Any` / `initial_image: Any` because it's
  decoupled from the concrete image type (production passes
  `image.GeneratedImage`; the unit tests pass a sentinel `str`). Replaced `Any`
  with a **PEP 695 type parameter** `ImageT` — honest about "whatever image type
  the injected callbacks agree on", and `str` still satisfies it so the tests
  don't churn:
  - `class LoopResult[ImageT]` (was `Any` field)
  - `run_grounding_loop[ImageT](initial_image: ImageT, *, verify, repair, …) -> LoopResult[ImageT]`

### `providers/view_estimator.py` — `dict[str, Any]` → `ViewEstimate` TypedDict

Mirrors the TS `ViewEstimate` + its `ViewLevel` / `ViewProjection` `Literal`
unions in `packages/config`:
- `ViewLevel = Literal["map","building","street","eye"]`
- `ViewProjection = Literal["top_down","oblique","perspective"]`
- `class ViewEstimate(TypedDict): level: ViewLevel; projection: ViewProjection; pitch_deg: float`
- `DEFAULT_VIEW: ViewEstimate`, `parse_view(payload: Any) -> ViewEstimate`,
  `estimate_view(...) -> ViewEstimate`.

`LEVELS` / `PROJECTIONS` are typed as `tuple[ViewLevel, ...]` /
`tuple[ViewProjection, ...]`, so the `value in LEVELS` membership checks narrow
the validated string straight back to its Literal (no cast needed at the return).

### `generate.py` — propagate the strong types across the geometry boundary

`generate.py` is in the *loose* mypy override, but `check_untyped_defs = true` is
global, so call sites are still checked. Strengthening the providers surfaced
these (latent) boundary types, now fixed:
- `view: ViewEstimate | None` (was `dict[str, Any] | None`) — `view["level"]` etc.
  are now typed.
- `_box_from_det(d: Detection)` (was `dict[str, Any]`).
- `_run_grounding(expected: list[ProjectedEntityDict], …)` (was `list[dict[str, Any]]`).
- The three `[e.model_dump() for e in body.expected_layout]` boundaries
  `cast(...)` to the TypedDict: `model_dump()` legitimately erases the static type,
  but a Pydantic `ProjectedEntity` (this module's wire model) dumps to exactly the
  `ProjectedEntity` TypedDict shape. The geometry TypedDict is imported under
  `TYPE_CHECKING` as `ProjectedEntityDict` to avoid clashing with the Pydantic
  class of the same name (and to keep the providers lazy-imported at runtime for
  Modal cold-start cost).

### `apps/web/app/api/world/[sessionId]/edit-entities/route.ts` — `unknown` → `SceneView`

`scene_view?: unknown` on the request body → `scene_view?: SceneView | null`. The
field is opaque pass-through (forwarded to the backend as `body.scene_view ??
null`), but the canonical `SceneView` type exists and the Python witness body
declares `scene_view: SceneView | None`, so this tightens the contract end-to-end.

---

## Left as `Any` (with reason)

### `providers/llm.py` (~59 `Any`) — genuinely dynamic, kept

This module is the cross-provider LLM client. Its `Any` is mostly unavoidable;
forcing types would be dishonest or break tolerance:

- **`response: Any`** (`_choice_content`, `_parse_choice_json`, `_parse_tool_json`,
  `_extract_citations`, `_log_cache_usage`) — the OpenAI SDK returns a typed
  `ChatCompletion`, but the code reads it *structurally* (`.choices[0].message
  .content`, `getattr(msg, "tool_calls", None)`) to absorb cross-provider wire
  quirks (OpenRouter / qwen / Gemini). Pinning `ChatCompletion` would break the
  `getattr` fallbacks.
- **`messages: list[Any]`** — OpenAI chat messages are heterogeneous (system /
  user / tool; `content` is a `str` *or* a content-part list). The SDK's own param
  type is a deep union; `list[Any]` is the pragmatic, idiomatic choice.
- **`schema: dict[str, Any]`** + the `*_SCHEMA` constants (`CLICK_SCHEMA`,
  `PLAN_SCHEMA`, `EXTRACTION_SCHEMA`, `ENTITY_EDIT_SCHEMA`, …) — these *are*
  JSON-Schema documents: arbitrarily-nested dynamic JSON by definition.
- **`extra_body` / `span_ctx` / `**kv` / `response_sink`** — opaque provider
  pass-through bags / logging kwargs / out-params.
- **`_parse_*` / `_coerce_*(... : Any)`** (`_coerce_scale`, `_coerce_unit`,
  `_parse_point`, `_parse_bbox`, `_coerce_extracted_entity`,
  `_coerce_entity_update`, `_coerce_bbox`, `parse_entity_edits`) — each takes a
  raw decoded-JSON value of unknown shape and validates it field-by-field. The
  *input* must stay `Any`; where the *output* had a known shape it was strengthened
  elsewhere (e.g. `detector.parse_detections -> list[Detection]`).
- **`EditPlan.edits: list[dict[str, Any]]` / `parse_entity_edits -> list[dict[str,
  Any]]`** — these build the `EntityGeoEdit` **discriminated union** (TS:
  `add | move | set_height | set_appearance | remove`, each with different fields).
  It's constructed incrementally per-op with optional keys
  (`edit["height"] = …` after the base dict). Modeling it as 5 TypedDicts fights
  mypy on the incremental mutation and adds surface without real safety — the web
  side re-validates against the TS union. The `_is_vec2` guard already returns a
  precise `TypeGuard[dict[str, Any]]`. Kept as-is.

### `providers/image.py`, `image_edit.py`, `video.py`, `_common.py`

The remaining `dict[str, Any]` here are fal/HTTP request-arg builders and decoded
JSON responses (`_edit_args_for`, the seedream/nano-banana arg dicts,
`resp.json()`) — genuinely provider-shaped dynamic payloads. Out of this
workstream's high-confidence scope; left untouched.

### `providers/grounding.py`, `generate.py` — `result: Any`

`_run_grounding(result: Any, …)` / the live `_verify`/`_repair` closures keep
`Any` for the image: at that call site the value is `image.GeneratedImage`, but
threading the generic through the surrounding generator + the best-effort
try/except adds noise for no checker gain (the loop itself is now generic and
type-safe). The honest strengthening (the `ImageT` parameter) lives where it pays
off — on `run_grounding_loop` / `LoopResult`.

### TS — `.next/` + test files

Everything else the grep
(`: any | as any | as unknown as | Record<string, any> | : unknown`) turned up is:
- `.next/types/**` — Next.js generated route validators (not source).
- `app/admin/trace/page.tsx` `... as unknown as T` — a control-flow cast in a
  thin server-action helper (acceptable, not production data modeling).
- `*.test.ts(x)` — DOM mocks + `import()`-type test shims. Out of scope (don't
  churn tests).

---

## Green confirmation

`make eval` (repo root):
- `pytest -m "not paid"` — **all pass** (2 paid-gated skips).
- `ruff check .` — **All checks passed!**
- `mypy providers/geometry.py geometry_prompt.py model_router.py grounding.py
  detector.py generate.py` — **Success: no issues found in 6 source files**.
- web `vitest` — **404 passed (53 files)**; `tsc --noEmit` clean; `check:circular`
  — no circular dependency.

Explicit gates:
- `cd apps/modal-backend && .venv/bin/mypy providers/ obs.py generate.py` —
  **Success: no issues found in 14 source files** (whole strict surface).
- `cd apps/web && pnpm exec eslint . --max-warnings=20` — **0 errors, 16
  warnings** (all pre-existing `<img>` / test-import warnings; none introduced
  here).

Parity / behaviour: `tests/world_bench/test_geometry.py` +
`test_geometry_fuzz.py` + `test_grounding_diff.py` + `test_repair_loop.py` +
`test_view_estimator.py` + `test_generate_geometry.py` all pass — the golden-vector
projection parity gate is unchanged (type-only edits).
