# PLAN — editing tools: select-an-area, right-click, and the old manual edits grown up

The next milestone after the view grammar + render loop: make EDITING a
first-class, judged, geometry-aware interaction — "select this area, fix this
and that" — and revisit the manual editing features that already exist but
predate everything we now know.

> **STATUS (2026-06-10): SHIPPED, E1–E5 all merged.** PRs #36 (mask smoke +
> pixel-diff — fill is the primary, gpt's mask is decorative), #37 (E1
> backend: inpaint + edit_loop behind `EDIT_REGION`), #38 (E5 bench +
> committed baseline: alignment 10.0 / outside 0.0000 / medium 10.0 first
> run), #39 (E1 frontend: drag-select behind `NEXT_PUBLIC_EDIT_REGION`),
> #40 (E3: `EDIT_JUDGE` + the verdict chip with revert), #41 (E2: the
> geo-aware context menu), #42 (E4: apply-to-image + removal that sticks),
> #43 (the EDIT_JUDGE bench arm, `EDIT_REGION_BENCH_WHOLE=1`). All judged
> flags default OFF; flip after live play: backend `EDIT_REGION=1
> EDIT_JUDGE=1`, web `NEXT_PUBLIC_EDIT_REGION=1`.

## Where editing stands today (honest inventory)

| Feature | State | Gap |
|---|---|---|
| Full-image instruct edit (`mode:"edit"` + the page's edit box) | Shipped. `polish_edit_instruction` + `edit_image`, medium-locked since the style fix. | Whole-image only; un-judged (no verification the edit did what was asked or didn't wreck the rest); no region scope; history only implicitly via nodes. |
| NL entity editor (codex → "move the lighthouse north") | Shipped (`/edit-entities`, GeoEditPanel, blast radius). | Edits the WORLD MODEL (coordinates) only — never the pixels. The two systems don't talk. |
| Grounding repair (auto `add a X / move the Y`) | Shipped, flag-gated, system-driven. | Never user-triggerable; its `repair_instruction` machinery is exactly a "fix this" primitive going unused by humans. |
| Inpaint | SMOKE-VERIFIED (2026-06-10, `tests/edit_bench/mask_smoke.py`): `fal-ai/flux-pro/v1/fill` is a true compositor — inside 0.395 changed, outside 0.0000, white=inpaint, dims kept. It is the PRIMARY. `openai/gpt-image-2/edit` accepts `mask_url` but repaints the whole canvas under every convention (outside 0.28/0.999/1.0; no-mask churn floor 0.089) — not an inpaint fallback. | Provider function + UI still to wire (E1). |
| Region machinery | `cropRegion` (TS) / `crop_box` (py) ship for enter-conditioning. | Not exposed as a selection tool. |
| The new assets (reuse these, don't rebuild) | `providers/judge.py` (5 judges incl. `score_prompt_alignment` + `score_feature_articulation`), `providers/render_loop.py` (critic-guided retries, keep-best, feedback clauses), `prompt_library` (medium locks, registers), `routeClick` (geo hit-test: we KNOW what you clicked). | — |

## E1 — Select area → "fix this and that" (the headline)

Drag a rectangle (or lasso later) on the page → an instruction box anchored to
the selection → a MASK-scoped edit:

- Frontend: selection overlay on the image (the `objectContainRect` +
  crop math already handle the coordinate mapping); build a mask PNG (white =
  selected) + send `mask_url` + the region crop + the instruction.
- Backend: a real `inpaint` op — primary `fal-ai/flux-pro/v1/fill` (the
  smoke settled it: a true compositor, outside-mask pixel-identical; gpt's
  mask_url is decorative). Fill takes a DESCRIPTION of what fills the mask,
  not an edit command — its own instruction register, + the medium lock.
  No mask-honoring fallback exists; on fill failure degrade to the
  whole-image edit path.
- **Judged by construction**: outside-mask pixels stable (that's what masks
  are for — assert it with a cheap pixel-diff, no VLM needed), inside judged
  with `score_prompt_alignment` (did the asked change land?) + the medium
  critic; one render-loop retry on failure, verdict logged (`edit.loop`).

## E2 — Right-click: the geo-aware context menu

`routeClick` already resolves what's under the cursor, so the menu is
target-aware (additive — plain left-tap behavior untouched):

- On an entity: **fix/redraw this** (a one-click repair-style edit scoped to
  its bbox), **remove**, **move/resize** (prefills the NL entity editor),
  **enter** (the existing tap), **re-roll just this** (regional regenerate).
- On empty ground: **add something here…** (the `repair_instruction` add-path
  with bins derived from the click), **edit this area** (opens E1 with a
  default region).
- Desktop right-click / long-press on touch. The menu is the discoverability
  layer for everything below it — no new backend concepts, just routing to
  E1/E3/E4 primitives.

## E3 — The manual edit box, revisited

Today's edit box gets the treatment the enter path got:

- **Judged edits**: prompt-alignment + medium critics on every manual edit,
  with one loop retry folding the critic's rationale back in (the proven
  pattern — and `score_feature_articulation` guards against "fixed the ask,
  simplified everything else").
- **Region-scoped when a selection exists** (E1 plumbing), whole-image
  otherwise.
- **History you can feel**: every edit is already a node — surface it
  (an edits strip / revert-to chip) instead of leaving undo implicit.
- A small verdict chip in the UI ("edit verified 9/10 · medium held") so the
  user sees what the judges saw.

## E4 — Pixels ↔ world model, finally talking

- After any pixel edit (E1/E2/E3): re-run extraction on the affected region
  (the extract route + view estimator already exist) so geo/codex stay
  truthful — an edited-away tower should leave the world model too.
- After an NL entity edit ("move the lighthouse north"): offer **apply to
  image** — the geo delta becomes a `repair_instruction` move/add edit on the
  page. One button closes the oldest open loop in the repo (coordinates
  moving without pixels).
- Blast radius already computes which neighbours an edit ripples to; reuse it
  to decide the re-extraction region.

## E5 — The edit bench (before/after, like everything else now)

`eval-edit-region`: cases of (page, mask, instruction) → score (a) the asked
change landed (`score_prompt_alignment`), (b) outside-mask stability
(pixel-diff, free), (c) medium held (style judge). Committed baseline +
the band, same `eval_baselines.json` pattern; rides the existing
`EDIT_BENCH_RUN` marker family. The first paid run doubles as the
gpt-image-2 `mask_url` behavior smoke.

## Order + rules

E1 → E3 → E2 → E4, E5 built alongside E1 (the smoke gates everything).
Per-feature kill-switch flags (the `ENTER_EDIT_REF`/`VIEW_LOOP` precedent),
byte-identity for untouched paths, `make eval` green per commit, judged
features get a bench before they get a default-on flag. Known unknowns:
~~gpt-image-2 `mask_url` real behavior~~ (RESOLVED 2026-06-10: decorative —
fill is primary, see the inventory row), mask coordinate mapping under
object-contain letterboxing (solved by the existing `objectContainRect`
math), and flux fill DOES need its own instruction register — it's now the
primary, so describe-what-fills-the-mask is the main path.
