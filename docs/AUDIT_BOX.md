# openflipbook — audit box (open backlog, in order)

How to use this: go top to bottom. For each item, confirm scope with the user, propose a small
additive plan, implement behind a flag (default OFF) with tests, prove it with `make eval`
(+ the relevant paid gate only if asked), check the box, then move on.

## 0. Diagnostic preflight (do this before "fixing" any reported breakage)
Run the **SUSPECT THIS FIRST** list in `.cursor/rules/openflipbook.mdc`. Most "regressions"
across past sessions were env/.env traps (qwen 429, fal model pin, docker build-time vars),
not code. Rule out env before touching code.

## 1. On-ramp milestone  — priority: HIGH (only remaining roadmap milestone)
**Goal:** make openflipbook approachable for a first-time user without changing anything for
existing users.
- Sane default flags for a fresh clone / `make demo` (what's ON by default, what stays OFF).
- A guided first session (passive, additive — a coach hint, not a gate). Existing
  `FirstRunCoach` is the hook; do not add interstitials.
- BYO-keys story: tighten `docs/BYO-KEYS.md` + `.env.example` so a newcomer gets to a
  generated page with the fewest steps.
**Files:** `docs/BYO-KEYS.md`, `apps/modal-backend/.env.example`, `Makefile` (`demo`),
`apps/web/components/PlayPage/FirstRunCoach.tsx`, README's "why this exists" paragraph.
**Acceptance:** a clean machine reaches a first generated page following only the docs;
existing flow byte-identical; voice stays chill/first-person.

## 2. ✅ Wire `expected_layout` → render  — DONE (the doc lagged the code)
`projectScene`/`projectTopDown` (web `lib/world-geometry.ts`) ride
`GenerateBody.expected_layout` and steer the prompt via `_layout_clause_for` →
`geometry_prompt.layout_constraints`, gated by `WORLD_GEOMETRY_GEN` (default ON under an
active world mode). Measured +0.33 layout fidelity in the A/B; the VLM-grounding verify
checks the render against it. Suppressed only on a camera-register mismatch
(`_layout_register_mismatch` — surfacing that suppression is UI_AUDIT debt #11).

## 3. ✅ Harden silent failures  — DONE (PR #119)
**Goal:** several degradation paths fail silently — surface a signal and add tests so they stop
hiding. Each is small and independent; do them as separate flagged/observable changes.
- Geometry localization best-effort drop (`generate.py:~2567-2650`): detector/view-estimate
  failures keep empty bbox / null view with no signal.
- Grounding loop swallow (`generate.py:~673`): returns original image, no feedback.
- Rate-limit env parse (`providers/ratelimit.py`): malformed `RATE_LIMIT_RPM` silently → off;
  validate at startup.
- Streaming resume (`apps/web/lib/stream-client.ts`): corrupt/out-of-order packet → closes
  stream with no retry; add unit tests for the dedup/sequence path.
- Click-annotation fallback (`apps/web/lib/image-click.ts:~143,199`): canvas/stroke failure
  silently drops the visual hint.
**Acceptance:** each failure emits an observable signal (trace/log/HUD) without changing the
happy path; new unit tests cover the corrupt/missing-input branches; `make eval` green.

## 4. Register drift / metric fidelity  — priority: LOW / R&D (hard, open-ended)
**Goal:** the #1 reconstruction failure — `pos_raw ≈ 0.05` vs `pos_aligned ≈ 0.7–0.84`:
generated→coords stays *relative*, not metric. Honest limitation today. Explore metric pose
recovery from arbitrary generated images. Treat as research, not a quick fix.
**Files:** `apps/modal-backend/providers/view_estimator.py`,
`apps/modal-backend/providers/geometry.py`, `tests/recon_bench/`,
`estimateGeoFromBBox` (TS). Lever today: `WORLD_TOPDOWN_MAPS` (strict top-down for maps only).
**Acceptance:** measurable `pos_raw` lift on `make eval-recon` over the committed 0.69±0.12
baseline; no regression elsewhere.

## Smaller debt (pick up opportunistically)
- ~~**In-session expand connectors**~~ — DONE (2026-07-03): `relation` now rides the in-session
  `Page` (lib/session-pages.ts), the ?continue= hydration, and the `WorldMap`/`SessionMinimap`
  mappings; minimap tints expand tiles teal. Note the persistNode half was stale: expand
  (useExpandBloom) and edit already sent `relation`; ascend inserts server-side.
- ~~**mypy coverage split (CI hygiene)**~~ — already aligned: both `make eval` and CI run
  `mypy providers obs.py generate.py` (verified 2026-07-02).
- **UI discoverability** (`docs/UI_AUDIT.md`): `⊞ geo` / entity-chip toggles are buried — add a
  `G` shortcut + hint. Hover-prefetch + suppressed layout steering have no debug surface.
- **Mobile pass**: ≤390px audit for breadcrumbs, codex panel, geo inset.
- ~~**Cost**: stop uploading the inert fresh-gen reference image~~ — DONE (PR #109).
