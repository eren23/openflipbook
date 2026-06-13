# Cleanup re-run 2026-06-13 — Concern #4 Circular dependencies (madge + Python DAG)

DELTA verification over the 157 commits added since `beedb82` (closeup / ladder /
POV; PRs #64–#87). Standard: `docs/cleanup/02-circular-deps.md`. The prior
re-run (`docs/cleanup/00-rerun-2026-06-09.md`) recorded **Clean**; that is the
default and the bar to re-confirm. This pass is verification-only — no source or
config was changed.

## Verdict: CLEAN (no change)

Both the TypeScript madge guard and a manual Python import-graph audit confirm the
tree is still cycle-free. No back-edge was introduced by the new code.

## 1. TypeScript — madge (verbatim)

Command (the repo's `check:circular`, run from `apps/web`):

```bash
pnpm exec madge --circular --extensions ts,tsx --ts-config tsconfig.json \
  app components hooks lib instrumentation.ts instrumentation-client.ts
```

Result:

```
Processed 218 files (660ms) (1 warning)

✔ No circular dependency found!
```

- 218 files (up from 179 at the 2026-06-09 re-run; +39 from the closeup/ladder/POV
  work) — **zero cycles**.
- The single "warning" is the same informational non-resolvable-reference skip
  counter documented in the standard (a JSON/`resolveJsonModule` import), not a
  cycle; it does not affect the exit code. madge exits 0.

## 2. Python backend — manual DAG audit (no cycle-checker installed)

`apps/modal-backend` is outside madge's reach and has no Python cycle-checker
installed (none was installed for this pass, per scope). I mapped the
intra-package import graph of the production source with
`rg -n "^(from |import )"` and confirmed it is a DAG.

**Modules audited (production source):** `generate.py`, `obs.py`, `_env.py`,
`local_server.py`, and all of `providers/*.py` + `providers/prompt_library/*.py`
— including the task-named `model_router.py` and `image.py`. (`ltx_stream.py`,
`ltxf.py` are standalone Modal entrypoints; `providers/video.py` imports only
`._common`/`.image`.)

### Layering (top-level / module-scope edges only)

Every top-level intra-package import points *downward* toward leaves — no
upward/back-edge exists:

- **Leaves (no intra-package top-level imports):** `_env`, `_common`,
  `prompt_library.types`, `prompt_library.style`, `geometry`, `pixel_diff`,
  `judge`, `model_router`, `detector`, `breaker`, `spend`, `ratelimit`,
  `view_estimator`, `geometry_checks`, `heights`, and `layout_solver`
  (stdlib-only: `math`, `dataclasses`, `typing`).
- `image` → `_common`. `inpaint` / `image_edit` / `video` → `_common`, `image`,
  `model_router`.
- `prompt_library`: `types` ← `style` ← `camera`(→`geometry`,`types`) ←
  `policy`(→`types`) ← `layout`(→`geometry`) ← `instructions`(→`camera`,`style`,
  `types`) ← `feedback`(→`camera`) ← `__init__` (aggregator) ← `geometry_prompt`
  (→`prompt_library.layout`). Acyclic.
- `render_loop` → `judge`, `prompt_library.feedback`.
- `edit_loop` → `judge`, `pixel_diff`, `prompt_library.feedback`, `render_loop`.
- `grounding` → `detector`, `geometry`.
- **`generate.py`**: its only *top-level* intra-package import is
  `from _env import env_flag`. All other references to `obs`, `providers.*`, and
  `prompt_library.*` are **function-local (lazy) imports** resolved at call time,
  not import time. Nothing imports `generate` except `local_server` (the FastAPI
  entrypoint) and tests — `generate` is a top-of-graph sink.
- **`obs.py`**: module-level imports are stdlib + `fastapi` only — **zero** edges
  into `providers`/`generate`. Providers reach it via lazy `from obs import …`
  inside function bodies, so it is a clean sink with no return edge.

### Suspect edge checked: `llm` ↔ `layout_solver`

`providers/llm.py` lazily imports `EmptyRegion, PlannedEntity, PlannedRelation,
SceneGraph` from `.layout_solver` (function-local, under `TYPE_CHECKING`/at call
sites). `layout_solver.py` imports **only stdlib** (`math`, `dataclasses`,
`typing`) — no edge back to `llm`. **No cycle.**

### New files since `beedb82` — spot-check for back-edges

`git diff --name-only beedb82..HEAD -- 'apps/modal-backend/**/*.py'` lists the new
production modules `heights.py`, `geometry_checks.py`, `geometry_prompt.py`,
`image_edit.py`, `inpaint.py`, `view_estimator.py`, `render_loop.py`,
`edit_loop.py`, and the `prompt_library/*` split. Checked each one's top-level
imports:

- `heights`, `geometry_checks`, `view_estimator`, `layout_solver` → **leaves** (no
  intra-package top-level edges).
- `geometry_prompt` → `prompt_library.layout` (downward).
- `image_edit` → `_common`, `image` (downward).
- `render_loop` / `edit_loop` → `judge` / `pixel_diff` / `prompt_library.feedback`
  / `render_loop` (all downward).

No new top-level edge points upward. The new code is a DAG; the providers package
remains a DAG, consistent with the 2026-06-09 finding.

## Summary

| Check | Files | Cycles |
|---|---|---|
| madge (`apps/web`, `check:circular`) | 218 | 0 — `✔ No circular dependency found!` |
| Python `apps/modal-backend` (manual DAG audit) | full production source | 0 — DAG, all top-level edges downward; lazy imports only at call time |

**CLEAN — no change.** No HIGH (or any) finding. The `check:circular` guard wired
into `make eval` continues to gate the TS side; the Python graph was verified by
hand and is a DAG.
