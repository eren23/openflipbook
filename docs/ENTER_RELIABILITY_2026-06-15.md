# Enter reliability — the "502 / never-appears" investigation (2026-06-15)

**TL;DR — it isn't really a 502, and it isn't a spurious-abort bug. The dominant cause is
view-critic *retry latency*: ~half of enters run TWO sequential ~40s pro edits (≈100s total)
because the critic rejects attempt 0 and retries. The enter completes fine on the backend, but
full completion is ~100s with a static banner, so it feels stuck — and if you tap again
(impatient), the in-flight enter is aborted and nothing new appears. The "502" seen in the
demo was a separate, rarer event (the background extract route under concurrent load).**

## How I proved it
Instrumented all three `abortRef.abort()` sites in `apps/web/app/play/page.tsx` (temporary
`[ABORTDBG]` logs, since reverted) and ran load repros (`scripts/record-demo/repro-502.ts` —
fresh session, 6 then 3 enters, full per-request capture incl. response bodies).

**Repro result (6 enters): `0×502, 0 dropped taps, 2 never-settled`.** The 2 never-settled were
the two enters that hit the critic retry; the 4 that didn't entered in 21–53s.

The `[ABORTDBG]` trace showed **no spurious abort**:
- `generate(tap) aborts prior in-flight` — fires on every tap, but it's aborting the *already-
  completed* previous generate's controller (a no-op). Benign.
- `selectFromMap abort` — the legit breadcrumb reset between iterations.
- The one real `ResponseAborted` per never-settle = the **next tap** (after patience expired)
  aborting the still-in-flight retry. Expected, not a bug.

Backend always completes: every `/sse/generate` → 200, `image.edit.end` with bytes. For a
never-settled enter the backend trace was: `click_to_subject` (9s) → `planner` (4s) →
`image.edit` (41s) → **`view.loop` rejected** → **second `image.edit`** (~40s). The repro's 100s
patience expired mid-second-edit.

## Root cause
`providers/render_loop.py` `LoopConfig`: `max_attempts=2` (one retry), accepts when
`conformance≥7 & same_place≥6 & detail≥6 & medium≥6`. There's a `retry_budget_s` guard ("no
retry if the previous attempt took longer than this") **defaulting to 240s — so high it never
fires at real ~40s edit speeds.** So every rejected attempt-0 triggers a full second pro edit
→ ~100s enters. (Env knobs: `VIEW_LOOP_MAX_ATTEMPTS`, `VIEW_LOOP_RETRY_BUDGET_S`,
`VIEW_LOOP_ACCEPT_*`.)

Mitigation already present: the backend streams the rejected attempt-0 as a `progress` frame
(`generate.py:2036`) and the client renders it (`page.tsx:812`), so the user *does* see the
place at ~50s — but the banner stays up until the retry's `final` at ~100s, and a re-tap before
then aborts it.

## The fix — a latency/quality tradeoff
> **DECISION (2026-06-15, Eren): keep the quality retry as-is; speed it up later.** No change
> made — `VIEW_LOOP_MAX_ATTEMPTS` stays 2. The options below are kept for the future speed-up
> (prefer **B**, faster retry model, since it keeps the quality guard).

The retry exists to protect the committed `enter_same_place` eval baseline (2.33±2.0). Cutting
it is a quality tradeoff. Options, best first:

- **A (recommended, 1-line, reversible): `VIEW_LOOP_MAX_ATTEMPTS=1`** in root `.env`. Enters
  become consistently ~25–40s. Before keeping it, gate on quality:
  `make eval-enter-drift` (or `eval-view`) and confirm `enter_same_place` stays in band. I can
  run that gate (~$ / ~10 min) on your go-ahead and keep-or-revert based on the number.
- **B: speed the retry only.** Keep `max_attempts=2` but run attempt-1 on a faster image model
  (code change in the enter loop). Keeps the quality guard, ~halves retry latency.
- **C: keep quality, improve feel.** Surface the attempt-0 draft as an interactable result with a
  clear "refining the view…" pill instead of a blocking banner (UX-only, quality-neutral).

My pick: **A, eval-gated.** Attempt-0 already looked correct in every hand-driven enter
(Tower of Art, Brass Bridge District, Sto Plains) — the retry's marginal gain probably isn't
worth doubling latency for an interactive toy, but the eval will say for sure.

## The separate, rarer 502
When it does appear it's the **extract route** (`apps/web/app/api/world/[sessionId]/extract`)
returning 502 because the background `/extract-entities` VLM call fails under concurrent load
during a long enter. It's *background* (populates the geo overlay) — it does not block the enter.
If you want it gone: add retry/backoff to that route's upstream fetch, or debounce extract so it
doesn't pile onto the enter's VLM burst. Low priority.

## State after this session
Instrumentation reverted; web rebuilt clean. **No app/test code changed in the final tree** —
only added `scripts/record-demo/repro-502.ts` + `record-ankh-tour.ts` + docs. `make eval` was
green before this work and is unaffected.
