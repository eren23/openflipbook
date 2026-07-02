# Session audit — the consistency + worlds work

_Honest, code-grounded review of everything shipped in this run, same discipline as
`GEOMETRIC_WORLD_AUDIT.md`: what's solid, what's a deliberate simplification, what's deferred.
Written so the next session can pick up without re-discovering the gaps._

## What shipped (merged to `main`)

| # | Area | PR | State |
|---|---|---|---|
| 1 | **Cleanup** — purge demo artifacts from history | — | merged; `.git` 68 MB → 9.3 MB |
| 2 | **A2 style medium-lock** + **A3 size↔map** | #15 | merged |
| 3 | **Eval** — style A/B + size regression | #16 | merged |
| 4 | **B1 — describe → logical object world** | #17 | merged |
| 5 | **B1 centre-region fix** (caught by the live demo) | #18 | merged |
| 6 | **B2 keystone** — the scale ladder | feat/scale-nav | banked (this PR) |

Verification: `make eval` green on `main` (backend pytest/ruff/mypy + web vitest/tsc + no
circular deps). Proof artifacts (style A/B, size overlay, image_urls null result, B1 demo) in
`~/Desktop/ofb-consistency-proof/`.

## Per-area assessment

### 1. Cleanup — solid
History rewritten (`git-filter-repo`) + force-pushed; 3 merged origin branches deleted; a CI
guard + broadened `.gitignore` prevent regression. **Open:** `origin/backup/pre-purge` still
holds the old blobs (kept as a recovery net — delete once a fresh clone is confirmed lean).

### 2. A2 style medium-lock — solid, with one honest nuance
- The **MEDIUM LOCK** text clause (`llm.py` plan_page) is the universal workhorse — it works
  on every model incl. seedream, and the edit-path fix was dramatic in the A/B (photoreal 3D
  dragon → engraving). The edit path used to drop the style **entirely**; it now threads the
  text anchor + the style ref.
- **Honest nuance:** the *fresh-gen* style REF image is a **no-op** — verified that fal's
  text-to-image nano-banana(-pro) accept-but-ignore `image_urls` (a photoreal prompt + an
  engraving ref came back photoreal). So on the tap "fresh" + expand paths the **text** does
  the work; the ref image only bites on the **edit/continue** endpoints. Documented in
  `providers/image.py`. The screenshot's *hard* drift was largely the **qwen-429 env**, not
  pure code; the real code wins are the edit + stroke-tap paths.
- **Cleanup candidate (deferred):** stop uploading the inert fresh-gen ref to save the fal
  upload cost (it's currently harmless but wasted).

### 3. Harden — solid
`negative_prompt` verified-dead for every in-use model (`scripts/verify-fal-models.py`, the one
`model_router.py` referenced but never had) → removed. The `image_urls` no-op is now documented.

### 4. A3 size↔map — solid, honestly scoped
- **FIX A** (oblique footprint from box width, clamped) is wired for the top-level oblique map
  and **proven live** (the overlay showed footprints `8.0 → 35.4` wide vs the old flat `6×6`).
- **FIX C** (carry footprint/height in `world_context` + a prompt size hint) done.
- **FIX B intentionally NOT done:** the seeding gate is correct as-is; force-seeding focus-less
  oblique scenes would inject unframed noise. Generated→coords geometry stays **relative, not
  metric** — the exact path remains the `WORLD_TOPDOWN_MAPS` lever (honest, per the audit).

### 5. Eval — solid
`style_runner.py` (paid A/B, reuses `score_style_pair`) measured the medium lock at
**0.5 → 9.0 (+8.5), pass**; `world-geometry-size.test.ts` guards FIX A free in CI. The pass/fail
brain (`summarize`) + the parser are unit-tested free; the paid run is `make eval-style`
(matches the other paid evals — manual targets, free gates in CI).

### 6. B1 describe → world — works end-to-end, with two known simplifications
- Proven live: *"a cozy wizard's study…"* → a logical top-down woodcut map (desk on the back
  wall, hearth left, centre kept open) + the seeded geo plane; a contradictory description →
  `solved:null` + a clarifier. Logical placement ✓, empty-stays-empty ✓ (solve + render + the
  grounding extras-penalty), asks-when-illogical ✓, no x/y from the LLM ✓ (parse-boundary guard).
- **Simplification 1 — `expected_layout` is NOT wired into the render.** The first render is a
  description gen styled as a top-down plan (`render_mode:"place_submap"`); the **logical layout
  lives in the seeded `world_map` geos** (tap-routable, overlay-visible), not necessarily in the
  rendered pixels. Wiring `projectScene → expected_layout` to *steer* the render is a clean
  follow-up.
- **Simplification 2 — `inside` is flat v1.** A prop "inside" a container sits within its
  footprint, same frame (exempt from de-overlap); true sub-frame nesting (`parent_id` + learned
  `scale`) is deferred (the broken placeholder was removed in the solver audit).
- `updated_at` is stamped by the endpoint (the solver stays deterministic). The centre-region
  bug (a "centre" empty region mapping to a corner) was caught by the live demo and fixed (#18).

### 7. B2 keystone — solid, foundation only
The scale ladder + `tierStep`/`tierMetricMultiplier`/`tierTransitionValid` (INV-2), 5 golden
tests. **Everything else in B2 is unbuilt** — see `PLAN_OUTWARD.md`.

## Deferred / tech-debt (carry forward)

1. **`origin/backup/pre-purge`** — delete once a fresh clone is confirmed lean.
2. **B1 `expected_layout` steering** — ~~wire `projectScene` so the render reflects the solved
   positions~~ **DONE since**: `projectScene`/`projectTopDown` output rides
   `GenerateBody.expected_layout` and steers the prompt via `_layout_clause_for` →
   `geometry_prompt.layout_constraints` (+0.33 layout fidelity in the A/B; on iff world mode /
   `WORLD_GEOMETRY_GEN`).
3. **B1 `inside` flat-nesting** — sub-frame nesting deferred.
4. **A2 fresh-gen ref upload** — ~~inert (fal ignores it); stop uploading to save cost~~
   **DONE** (PR #109 dropped the upload; the text medium-lock still carries style).
5. **Flagged Kontext-scene path** — not built (intentional; the audit cautions it for map→scene).
6. **B2 integration** — ~~OUTWARD / AROUND / DEEPER / UI + the `scale_tier` plumbing~~
   **DONE** (PRs #20–#26 shipped the whole ladder: OUTWARD/ascend now lives in
   `providers/generate_modes/ascend.py`; see `PLAN_OUTWARD.md` Phase E notes).
7. **Merged local branches** — `feat/consistency-fixes`, `feat/eval`, `feat/world-from-description`,
   `fix/centre-empty-region` are merged; tidy locally.
8. **mypy coverage split (CI hygiene)** — `make eval` type-checks `generate.py` + 5 provider
   files; CI type-checks `providers` but **not** `generate.py`. The union is covered, but neither
   gate alone is complete (a `generate.py` type error passes CI; a `layout_solver.py` one passes
   `make eval`). Cheap follow-up: align the two file lists.
9. **Style ref on non-default edit paths** — the `pro`/`flux-pro/kontext` edit tier drops the
   style exemplar (singular `image_url`), and `continue_image` (World-Mode submap zoom) takes no
   style ref at all. Default edit tier is `balanced`=nano-banana-pro (which *does* use the ref),
   so default behaviour is fine; these two paths lean on text-only medium lock.
10. **B1 realism nits** — a `facing` subject's heading isn't recomputed if de-overlap later
    relocates it; residual *item-item* overlap after the 20-iter cap isn't asserted away (only
    reserved-region collisions block). Cosmetic, non-blocking.

**Resolved by the audit (no change needed):** the top-down `estimateGeoFromBBox` footprint is
left **un-clamped on purpose** — it's the exact metric bridge (bbox = footprint under
`WORLD_TOPDOWN_MAPS`); clamping would cap legitimately-large entities. The oblique clamp guards
monocular-depth blowups, which top-down doesn't have.

## Flag posture (prod safety)

Everything new is **off by default** in prod: `WORLD_FROM_DESCRIPTION` (B1 backend),
`SCALE_LADDER_NAV` (B2), `IMAGE_NEGATIVE_PROMPT` (removed entirely). The style + size fixes are
always-on but additive (no behaviour change when no style/geo is present). Tap/edit/atlas stay
byte-identical with the flags off.

## Independent audit

_An independent agent re-derived every file:line claim, ran `make eval` on `main`, and reviewed
all merged diffs. Verdict: **CONCERNS — ship-able**, off-by-default and honestly documented. The
"concerns" (not "pass") are about scope-labelling and a few openly-deferred no-ops, **not**
correctness regressions. `make eval` is **green**: backend `392 passed, 2 skipped` (the 2 are the
paid bench markers) + ruff/mypy clean; web `446 passed` + `tsc` clean + no circular deps._

What it **confirmed** (matches this doc): the style image-REF is a no-op on every fresh-gen path
(query / tap-new / **and the expand bloom** — `generate.py` calls the text-to-image
`generate_image` there too, so the parent/style refs are sent-but-ignored; only the MEDIUM-LOCK
text holds style); `expected_layout` is not wired into the B1 render (the seeded geos carry the
logical layout, the pixels are description-driven); `inside` is flat-nesting v1; schema parity
(`test_geo_schema`) holds field-for-field; everything new is correctly off-by-default (B1 is
**double-gated** — backend `WORLD_FROM_DESCRIPTION` 403 + client `worldEnabled`).

New items it surfaced (folded into the deferred list below): the **mypy coverage split** (#8), the
**`pro`/Kontext edit tier dropping the style exemplar** and **`continue_image` taking no style
ref** (#9), and two minor B1 realism nits (#10).

**One finding I adjudicated rather than applied** — the auditor flagged that the **top-down**
branch of `estimateGeoFromBBox` floors footprint at 0.5 but (unlike oblique) applies no
`MAX_FOOTPRINT` cap, and offered "clamp it too **or** document the intentional exemption." The
exemption is **intentional and the clamp would be wrong**: top-down is the *exact metric bridge*
(`WORLD_TOPDOWN_MAPS`, bbox **is** the footprint) — a building that genuinely spans 80% of the
frame must seed an ~80 footprint; capping it at 40 would corrupt the one honest metric path. The
oblique clamp exists only to tame unreliable *monocular-depth* blowups, which don't occur on a
top-down map. So: no code change; documented here as a deliberate design decision.

**Scope note:** the auditor was checked out on `feat/scale-nav`, so it read the B2 keystone in
`git log` and (correctly) observed it is **not on `main`**. That's not a doc error — this audit
lists the keystone as "banked (this PR)," and both this doc and `PLAN_OUTWARD.md` state the rest
of B2 is unbuilt. This PR is exactly that bank.
