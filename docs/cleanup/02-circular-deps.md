# Cleanup 2 — Circular dependencies (madge)

Workstream 2 of the sequenced code-quality cleanup. Scope: **verify there are no
import cycles in the TypeScript workspaces, and add a guard so they can't creep
back.** Dedup, type-strengthening, dead-code and comment cleanups belong to other
workstreams and were left untouched. No source files were changed — the tree was
already cycle-free.

## Tooling added

- `madge@8.0.0` as a devDependency in `apps/web` (pnpm).

## The commands

madge resolves the `@/*` and `@openflipbook/config` path aliases via the web
`tsconfig.json`, so the `--ts-config` flag is required for the import graph to be
followed correctly.

```bash
# apps/web — the Next.js TS/TSX app (run from apps/web)
madge --circular --extensions ts,tsx --ts-config tsconfig.json \
  app components hooks lib instrumentation.ts instrumentation-client.ts

# packages/config — the shared-types package (single module)
madge --circular --extensions ts \
  --ts-config packages/config/tsconfig.json packages/config/src
```

The `apps/web` check is scoped to the real source roots (`app`, `components`,
`hooks`, `lib`, plus the two root `instrumentation*.ts` files) instead of pointing
at the whole `apps/web` directory. This keeps it **fast and deterministic**: it
processes 156 source files and never has to walk `node_modules`, `.next`,
`coverage`, `test-results`, or the e2e/Playwright scaffolding. (madge ignores
`node_modules` by default, so pointing at the bare `apps/web` directory also
reports clean — 183 files — but it is slower and scans build artifacts. Both
variants agree: zero cycles. The scoped form is what the guard runs.)

Note: `apps/web/public/theme-init.js` is the only non-config JavaScript file under
the app; it is a static browser asset, not part of the module graph, so the
`ts,tsx` extension scope is complete.

## The result — CLEAN

Both workspaces are cycle-free. No source changes were needed.

```
# apps/web
Processed 156 files (~0.5s) (1 warning)
✔ No circular dependency found!

# packages/config
Processed 1 file
✔ No circular dependency found!
```

The single madge "warning" on the web run is an informational skip counter (a
non-resolvable reference such as a JSON data import pulled in via
`resolveJsonModule`). It is **not** a cycle and does not affect the circular
analysis or the guard's exit code.

`packages/config/src` is a single file (`index.ts`, the shared type surface that
the Python backend mirrors by hand), so a cycle there is structurally impossible —
the check is run anyway for completeness and as future-proofing if the package
ever grows more modules.

### Python backend (out of scope, not gated)

`apps/modal-backend` is Python and outside madge's reach. A quick grep of
`providers/*.py` internal imports showed only a couple of shallow cross-imports
(`.image`, `._common`) with no obvious cycle. This is noted for completeness only;
it is **not** part of the `make eval` gate.

## The guard

Two pieces, so a newly-introduced cycle fails the green gate:

1. **`apps/web/package.json`** — a `check:circular` script (runs with cwd =
   `apps/web`, so the relative source paths resolve):

   ```json
   "check:circular": "madge --circular --extensions ts,tsx --ts-config tsconfig.json app components hooks lib instrumentation.ts instrumentation-client.ts",
   ```

   madge exits non-zero when it finds a cycle, so the script does too.

2. **Root `Makefile`** — wired into the always-on `eval` target, appended to the
   web TS line right after the `tsc --noEmit` step:

   ```make
   cd apps/web && pnpm exec vitest run && pnpm exec tsc --noEmit && pnpm run check:circular
   ```

   `make eval` is the deterministic, no-spend gate run between phases, so any
   import cycle now fails it before the next commit.

## Verification

- `pnpm run check:circular` on the clean tree → exit 0,
  `✔ No circular dependency found!`
- Sanity check that the guard actually gates: a throwaway `lib/__cycle_a__.ts` ⇄
  `lib/__cycle_b__.ts` pair was injected; `check:circular` reported
  `✖ Found 1 circular dependency!` and exited 1. The throwaway files were removed
  and the tree re-confirmed clean.
- `make eval` (now including the circular guard) green.
- `cd apps/web && pnpm exec eslint . --max-warnings=20` passes.
