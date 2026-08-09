# Cleanup rerun 2026-08-09 — Concern 02: Circular dependencies

Branch `chore/cleanup-rerun-2026-08-09`, HEAD `e75e3b1`. Standard:
`docs/cleanup/02-circular-deps.md` + the Jun-09/Jun-13 rerun docs. Delta since the
Jun-13 run includes the `providers/llm.py` → `providers/llm/` package split (#124,
`6e8e8e4`), `providers/generate_modes/*`, `providers/register.py`,
`providers/coordinate_scale.py`, and prompt_library growth. Research only — no
repo file touched.

## Verdict: CLEAN — 0 actionable cycles. One by-design static SCC to record (report-only, KEEP).

## 1. Clean-scan receipts

### TypeScript — apps/web (the repo guard)

```bash
cd apps/web && pnpm run check:circular
# = madge --circular --extensions ts,tsx --ts-config tsconfig.json \
#     app components hooks lib instrumentation.ts instrumentation-client.ts
```

```
Processed 256 files (666ms) (1 warning)
✔ No circular dependency found!
```

- **256 files** (218 at Jun-13; +38 from the world/tap/register/preview work) — **0 cycles**, exit 0.
- The 1 "warning" is the same informational non-resolvable-reference skip counter
  documented in the standard (resolveJsonModule import), not a cycle.

### TypeScript — packages/config

```bash
cd apps/web && pnpm exec madge --circular --extensions ts \
  --ts-config ../../packages/config/tsconfig.json ../../packages/config/src
```

```
Processed 2 files (166ms)
✔ No circular dependency found!
```

- **2 files** (index.ts + index.test.ts; was 1 at the original run) — **0 cycles**.

### scripts/* — out of scope per standard

The 02 doc's method covers `apps/web` + `packages/config` only; `scripts/`
(ab-proof, bakeoff, perfbudget, record-demo, ux-bench) has never been in the
madge guard. Not scanned; noted for the record, no action.

### Python — apps/modal-backend (mechanized DAG audit)

Prior runs did this by hand (`rg -n "^(from |import )"` + manual layering). This
run mechanized the same standard with an AST-based checker (module-body imports =
hard edges; function-local = lazy non-edges; `if TYPE_CHECKING:` = erased
non-edges — the exact conventions the Jun-13 doc records):

```bash
apps/modal-backend/.venv/bin/python3 docs/cleanup/2026-08-09-rerun/pydag.py --edges
```

```
production modules scanned: 54
hard (import-time) edges: 92
lazy (call-time) edges:   96
TYPE_CHECKING-only edges: 13
HARD-EDGE CYCLES: 6   (all 6 are the one providers.llm SCC + 1 convention artifact, see below)
```

Runtime proof (output, not process — fresh interpreter, every suspect entry
point, incl. the FastAPI entrypoint that pulls the whole production graph):

```bash
cd apps/modal-backend && .venv/bin/python3 -c "
import importlib
for m in ['providers.llm.world','providers.prompt_library.instructions',
          'providers.generate_modes.ascend','providers.register','local_server']:
    importlib.import_module(m); print(f'import {m}: OK')"
# → all OK, exit 0
```

## 2. Findings

### F1 — providers/llm package: deliberate static SCC (NEW since Jun-13, by design)

| | |
|---|---|
| **file:line** | `apps/modal-backend/providers/llm/__init__.py:20-103` (name-imports click/client/extraction/planner/world) ⇄ `providers/llm/click.py:13`, `client.py:31`, `extraction.py:13`, `planner.py:15`, `world.py:14` (each: `from providers import llm as _llm`) |
| **claim** | The #124 split (`6e8e8e4`, post-Jun-13 delta) created a real static import cycle: package `__init__` name-imports all 5 submodules; each submodule imports the package module object back at module level. A madge-equivalent for Python flags a 6-module SCC. |
| **evidence** | Edge list from the mechanized scan (above). It is **deliberate and documented**: the `__init__` docstring says "this __init__ re-exports the entire surface so `providers.llm` resolves exactly as before, and tests keep monkeypatching attributes here (submodules call the patchable seams through this namespace)"; all 5 submodule docstrings repeat the seam rationale. It is **runtime-safe by construction**: the back-edge only binds the module object (`_llm`); `rg "^\S.*_llm\.|def .*=\s*_llm\."` finds **zero** module-level or default-arg attribute reads (only docstring mentions), so nothing reads the partially-initialized package at import time — attribute access is all call-time (Python ≥3.7 sys.modules fallback makes the partial bind well-defined). **Runtime-proven**: fresh-interpreter imports all OK (receipt above); exercised on every backend boot + CI since #124 (~2 months). |
| **confidence** | High (static graph mechanized; runtime import verified; design intent written in the source). |
| **verdict** | **report-only — KEEP.** No mechanical break exists: removing the `_llm` back-edges (direct sibling imports) would defeat the stated monkeypatch-seam design and silently un-intercept test patches; moving the 5 imports function-local would churn 5 hot files purely to appease a graph shape with zero behavior gain. Not safe-auto by the charter's own bar. |

### F2 — prompt_library "cycle" = scanner-convention artifact, not a finding

| | |
|---|---|
| **file:line** | `apps/modal-backend/providers/prompt_library/instructions.py:18` (`from providers.prompt_library import camera`) vs `providers/prompt_library/__init__.py:21-35` |
| **claim** | The strict scanner counts instructions → package-`__init__` as an edge, closing a 2-node loop. Under the established Jun-13 convention (`from pkg import submodule` resolves to the *submodule* target), there is no edge and no cycle. |
| **evidence** | The import's target is the `camera` module, not `__init__` names; `camera` is imported before `instructions` in `__init__` (line 21 vs 27), so the bind is against a fully-loaded module either way. The line dates to `d69898d` (2026-06-10) — it was already in the tree the Jun-13 run audited and recorded as **clean** (`instructions → camera, style, types`, no back-edge). Zero delta. |
| **confidence** | High. |
| **verdict** | not-a-finding (consistent with prior clean; conventions note only). |

### F3 — generate ⇄ providers/generate_modes: call-time-only mutual reference (by-design extraction seam)

| | |
|---|---|
| **file:line** | `apps/modal-backend/providers/generate_modes/ascend.py:25` (TYPE_CHECKING-only `from generate import GenerateBody`; same in edit.py:26, expand.py:23, tap.py:31), `ascend.py:226` (function-local `from generate import _friendly_error`); generate.py's imports of the mode handlers are function-local too |
| **claim** | The only generate↔modes references are `if TYPE_CHECKING:` (erased at runtime) or function-local (resolved at call time). Zero import-time edges either direction. |
| **evidence** | Scanner buckets (hard: none between them; lazy: both directions); `sed -n '20,32p' ascend.py` shows line 25 inside the TYPE_CHECKING block; the package docstring states the design: handlers get generate.py's stream helpers "threaded explicitly so this package never reaches back into generate.py's module globals". Prior runs' standard treats lazy imports as non-edges (generate.py itself has used this pattern since before Jun-09). |
| **confidence** | High. |
| **verdict** | clean — no change (same class the Jun-13 doc already documented for generate.py). |

### Delta files named in the charter — all accounted for

- `providers/register.py:19-22` — **leaf**: stdlib only (`dataclasses`, `math.hypot`). Clean.
- `providers/coordinate_scale.py` — new leaf; imported downward by `detector`, `llm/click`, `llm/extraction`. Clean.
- `providers/generate_modes/*` — F3 above; `__init__` imports edit/expand/tap only (ascend imported lazily by generate). All hard edges point downward (`providers.image`, `image_edit`, `llm`, `model_router`, `spend`, `obs`, `_env`). Clean.
- `providers/llm/world.py` growth — module-level edges: `providers.llm` (F1 seam), `.client` (downward), TYPE_CHECKING extras. Clean.
- prompt_library additions — F2; `geometry_prompt → prompt_library.layout` downward. Clean.

## 3. Re-verification (fast path)

1. `cd apps/web && pnpm run check:circular` → expect `Processed 256 files`, exit 0.
2. `cd apps/web && pnpm exec madge --circular --extensions ts --ts-config ../../packages/config/tsconfig.json ../../packages/config/src` → 2 files, 0 cycles.
3. `apps/modal-backend/.venv/bin/python3 docs/cleanup/2026-08-09-rerun/pydag.py` → exits 1 only on hard-edge cycles outside the documented providers.llm SCC (today: the 6 listed SCC paths only).
4. The one-liner fresh-import proof above → all OK.

(Optional, NOT proposed as a change: pydag.py mechanizes the doc's manual audit
and could be adopted as a Python-side guard someday; the 02 standard explicitly
keeps Python out of the `make eval` gate, so this stays a note.)

## 4. Draft verdict-table row (Jun-13 00-summary style)

| # | Concern | Verdict | Action / commit |
|---|---------|---------|-----------------|
| 2 | Circular deps (madge + Python DAG) | **clean** | 256 TS files (apps/web) + 2 (packages/config), 0 cycles. Python 54 production modules, 92 import-time edges: a DAG except the **#124 providers/llm aggregator SCC (6 modules)** — deliberate, docstring-documented monkeypatch-seam pattern (`from providers import llm as _llm` binds the module object only; zero import-time attribute reads; fresh-interpreter imports of all members + local_server verified OK). Report-only KEEP — no mechanical break exists that preserves the test seams. generate⇄generate_modes is TYPE_CHECKING/lazy only. No change. |
