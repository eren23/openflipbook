# Cleanup re-run — 2026-06-13 · Concern #5 (weak types) — DELTA over `beedb82..HEAD`

Standard: `docs/cleanup/06-weak-types.md` (the SDK-tolerance/boundary-`Any` = KEEP
doctrine) + the `00-rerun-2026-06-09.md` delta (which added 4 annotations:
`parse_scene_graph`/`plan_world_from_description` → `SceneGraph`). This pass audits
the +7.8k TS / +14k Py added since `beedb82` (PRs #64–#87: closeup / ladder / POV /
edit-loop / render-loop / segmenter / public-deploy safety).

## Assessment (TS vs Python)

**TS is clean — nothing to do.** The delta added **zero** `any`, `as any`,
`as unknown as`, `@ts-*`, or non-null `!.` assertions in source. The only three new
weak-type tokens are *correct* boundary `unknown`: an SSE serializer arg
(`obj: unknown`), a type-guard input (`isKnobs(v: unknown)`), and a
`JSON.parse(...) as unknown` deliberately narrowed before validation — the
exemplary safe pattern. All KEEP.

**Python is also overwhelmingly clean, and the standard holds.** Every added `Any`
in the strict provider layer (`mock`, `llm`, `moderation`, `judge`, `inpaint`,
`segmenter`, `geometry_checks`) is case-(a) boundary: OpenAI-SDK response/messages
read structurally, raw VLM/LLM-JSON validator *inputs*, fal request-arg builders,
or a mock that mirrors the SDK's own loose shapes — these already pass strict mypy
(`warn_return_any`) because they were written honestly. The one place with a
genuinely-knowable strong type is **`generate.py`'s loop plumbing**: three
`list[Any]` accumulators actually hold `render_loop.Attempt` / `edit_loop.EditAttempt`
dataclasses, and one closure typed `-> Any` returns `JudgeResult`. Those are the
only real findings (4 REPORT-ONLY annotations in the loose-gated entry-point file).

## Counts

| | KEEP (boundary/correct) | AUTO | REPORT-ONLY |
|---|---|---|---|
| **TS source** | 3 | 0 | 0 |
| **Python source** | ~20 added `Any` sites | 0 | 4 |

(AUTO = 0 by design: the 4 real findings all live in `generate.py`, which is in the
*loose* mypy override — the standard + this run's mandate both say verify-against-tests
or REPORT-ONLY there, never blind-annotate the framework entry point.)

---

## Findings table

| sev | verdict | file:line | current weak type | researched strong type + evidence | conflicts |
|---|---|---|---|---|---|
| low | **REPORT-ONLY** | `generate.py:2009` | `loop_attempts: list[Any]` | **`list[render_loop.Attempt]`**. The `async for loop_att in render_loop.iter_attempts(...)` yields `Attempt` (`render_loop.py:161` `iter_attempts[ImageT: Rendered] -> AsyncIterator[Attempt]`). The only reads are `.accepted`/`.conformance`/`.index`/`.image.jpeg_bytes` — all real `Attempt` fields (`render_loop.py:86`). `render_loop` is runtime-imported in the enclosing `if view_loop:` block (`generate.py:1980`), so the symbol resolves. REPORT-ONLY: `generate.py` is loose-gated; confirm `make eval` mypy green before landing. | none |
| low | **REPORT-ONLY** | `generate.py:951` | `edit_attempts: list[Any]` | **`list[edit_loop.EditAttempt]`**. `edit_loop.iter_edit_attempts(...)` yields `EditAttempt` (`edit_loop.py:149`→`AsyncIterator[EditAttempt]`, dataclass at `:77`). `edit_loop` imported at the top of the inpaint branch (`generate.py:~895`). Reads (`.accepted`/`.alignment`/`.index`/`.image.jpeg_bytes`) are all `EditAttempt` fields. | none |
| low | **REPORT-ONLY** | `generate.py:1057` | `judged_attempts: list[Any]` | **`list[edit_loop.EditAttempt]`** — identical to `:951` (the whole-image judged-edit twin; `edit_loop` imported at `generate.py:1040`). | none |
| low | **REPORT-ONLY** | `generate.py:2003` | `_judge_detail(img_bytes: bytes) -> Any` | **`-> JudgeResult`**. The body is `return await judge.score_feature_articulation(...)`, whose signature is `-> JudgeResult` (`judge.py:280`). It's also passed as `judge_detail: Callable[[bytes], Awaitable[JudgeResult]]` (`render_loop.iter_attempts`, `:169`), so the return is already pinned by the call site. Cleanest of the four. | none |

### Not promoted — protocol-erasure boundaries (KEEP, with reasoning)

These three look promotable but the `Any` is *load-bearing* and the existing comment
already documents it:

- `generate.py:1944` `result: Any = None` — reassigned across branches to
  `await main_task` (`GeneratedImage`) **and** `render_loop.conclude(...).image`
  (typed `Rendered`, `render_loop.py:101`). Downstream it reads `result.mime_type` /
  `result.model` (`:2160`/`:2173`) — fields that exist on `GeneratedImage` but **not**
  on the minimal `Rendered` protocol (`render_loop.py:37`: only `jpeg_bytes`). Typing
  it `GeneratedImage` is unverifiable (one branch is statically `Rendered`); typing it
  `Rendered` breaks the `.mime_type`/`.model` reads. `Any` is the honest choice. KEEP.
- `generate.py:1094` `judged_image: Any = judged_result.image` — same erasure, and the
  code **already carries the comment** "The loop types images as the Rendered protocol;
  this is the GeneratedImage our render closure returned." Deliberate. KEEP.
- `generate.py:911/1046/1982` `_render_*(suffix) -> Any` — each returns `GeneratedImage`
  and is passed as `render: Callable[[str], Awaitable[ImageT: Rendered]]`. `-> GeneratedImage`
  *would* be stricter-and-correct (GeneratedImage satisfies `Rendered`: has `jpeg_bytes`).
  Left KEEP/REPORT-adjacent rather than AUTO: it's the same loose-gated file, and the
  payoff is marginal (the loop's generic `ImageT` already gives the binding its strength —
  the honest-generic pattern the prior run shipped on `grounding.py`). Could fold into the
  same REPORT batch if a maintainer touches this block.

### Provider-layer added `Any` — all KEEP (case-(a) boundary, already mypy-strict-green)

| file:line | weak type | why KEEP |
|---|---|---|
| `geometry_checks.py:57/114/133/163/183/197` | `list[dict[str, Any]]` / `dict[str, Any]` params | **Validator inputs of UNTRUSTED dicts.** The module docstring: these "NEVER raise" and emit `geo.not_dict` for non-dicts; they exist to validate raw solver/VLM/wire JSON *before* it's trusted. Same doctrine as the prior run's `parse_detections(payload: Any)`/`parse_view(payload: Any)`. Typing them as the `geometry.py` TypedDicts (`ProjectInput`/`ProjectedEntity`/`ObserverPose`/`MapCrop`) would assert validity the function is paid to *check*, and defeat the `isinstance(e, dict)` guards. KEEP — and retyping would **conflict with #4** (forces a wire↔checker coupling the checker deliberately avoids). |
| `geometry_checks.py:46/54` | `_num(v: Any)`, `_vec2_ok(v: Any)` | Numeric/shape coercers over raw values inside the above validators. Boundary by construction. |
| `segmenter.py:37/46/68` | `_clamp01(v: Any)`, `_parse_vertices(raw: Any)`, `parse_segments(payload: Any)` | Raw VLM-JSON coercers; **output is already the strong `SegmentEntity` TypedDict** (`segmenter.py:18`). Mirrors the prior run's `detector.parse_detections -> list[Detection]` pattern exactly. KEEP. |
| `segmenter.py:125`, `judge.py:73` | `messages: list[Any]` | OpenAI chat-messages list (heterogeneous system/user/content-part). The exact pattern doc-06 documented as KEEP in `llm.py`. |
| `llm.py:145/152` | `_coerce_json_dict(parsed: Any) -> dict[str, Any] \| None` + `cast(dict[str, Any], parsed)` | Decoded-JSON coercer; input is `Any` by definition, output is the JSON dict it validates. Established `llm.py` `_coerce_*`/`_parse_*` family. |
| `moderation.py:34` | `resp: Any = await client.chat.completions.create(...)` | OpenAI SDK response read structurally (`.choices[0].message.content`) for cross-provider tolerance — doc-06's canonical `response: Any`. |
| `inpaint.py:38` | `_inpaint_args_for(...) -> dict[str, Any]` | fal request-arg builder (per-model arg shapes). Twin of `image.py`'s `_edit_args_for`, explicitly out-of-scope in doc-06. |
| `mock.py:91/92/166` | `annotations/tool_calls: list[Any]`, `create(**kwargs: Any) -> _Response` | A mock OpenAI client that *mirrors the SDK's own loose param/return shapes*. Pinning types here would diverge the fake from the real SDK it stands in for. |

### TS source — all KEEP (correct boundary `unknown`)

| file:line | token | why KEEP |
|---|---|---|
| `app/api/session/[sessionId]/events/route.ts:33` | `send = (obj: unknown) => …` | SSE serializer; `JSON.stringify`s an arbitrary payload. `unknown` is the correct serialization-boundary type. |
| `hooks/useSpeedPreset.ts:81` | `function isKnobs(v: unknown): v is LoopKnobs` | A user-defined type guard — `unknown` is the canonical input type for a guard. |
| `hooks/useSpeedPreset.ts:105` | `const parsed: unknown = JSON.parse(stored)` | Deliberately narrows `JSON.parse`'s `any` to `unknown`, then validates via `isKnobs`. The textbook safe pattern; promoting it would be a regression. |

---

## Green-bar note

No edits made (research-only pass). The 4 REPORT-ONLY annotations are
behavior-preserving and provably correct from the source types above, but live in
`generate.py` — which `make eval` *does* mypy-check (`Makefile:40`
`mypy providers obs.py generate.py`) yet under the loose override
(`pyproject.toml`: `[generate]` sets `disallow_untyped_defs=false`, and crucially does
**not** set `warn_return_any`). Global `check_untyped_defs=true` means the loop bodies
are already inferred correctly today, so these annotations are documentation-grade
tightening, not bug fixes. Recommend landing them as a single small batch behind one
`make eval` run if a maintainer is already in that file; not worth a standalone churn PR.
