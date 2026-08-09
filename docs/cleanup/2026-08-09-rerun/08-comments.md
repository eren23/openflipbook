# Concern 08 — COMMENTS / SLOP — research (rerun 2026-08-09)

Scope: full tree, findings concentrated on `83e3262..HEAD` (325 files, +31,209/−5,961;
interiors #161–166, tap=enter #167–173, coverage #174–186, §4 register #189–209).
Standard: docs/cleanup/08-comments.md + 00-rerun-2026-06-09.md + 2026-06-13-rerun/{00-summary,08-comments}.md.
Tests/fixtures/node_modules exempt per the original doc. RESEARCH ONLY — no repo file touched.

## Sweep results (mechanical classes — all clean)

- Commented-out code: **0** — grep for call-shaped commented lines over the whole delta = 0;
  tree-wide grep for `// const|// return|// if (|// <JSX` etc. = 0 real hits (the 6 Python hits
  are English prose that starts with "if/for/return" as words, e.g. segmenter.py:137
  "# if the centroid sits in a hole (crescent/donut), snap…").
- Disabled JSX (`{/* <…`): **0**.
- `TODO|FIXME|XXX|HACK|WIP` across apps/packages/scripts (ex node_modules): **0**.
- Stub/placeholder prose: **0** new (render_loop.py `_no_judge` "Placeholder" docstring is the
  Jun-13 KEEP — a real positional-slot sentinel, unchanged).
- Phase/plan markers (`FIX A`, `codex #N`, `(P\d)`, `Phase \d`): **0**. `UI_AUDIT #10–13`,
  `V1 must-fix 3`, `should-fix 11`, `research/10 §4.5` are NOT this class — docs/UI_AUDIT.md and
  the research docs exist in-repo; each ref rides a concrete measured failure (see KEEP table).
- scripts/ + packages/ narration sweep: only node_modules noise; packages/config hits are
  present-tense type docs ("used to hydrate" = "is used for", false positive).

Gray zone = the ~49 past-tense `used to`/`legacy`/`no longer` mentions. Each read in context.
Net: **2 safe-auto word-level trims, 2 report-only trim options, everything else KEEP.**

## Findings — proposed edits

### F1 — safe-auto — scripts/record-demo/record-features.ts:308
- Current: `// both ENTER in one hop now (#167).` (full two-line comment: "A concrete place
  (enter_as scene); the geo-mapped and unmapped cases both ENTER in one hop now (#167).")
- The word "now" is pure changelog framing ("since #167, now"); behavior + PR anchor survive
  without it. Original doc's bar: reword to terse present tense.
- Action: trim-to → `// both ENTER in one hop (#167).`
- Re-verify: `grep -n "one hop" scripts/record-demo/record-features.ts` → line 308, no "now".
- Confidence: high. **Verdict: TRIM (safe-auto).**

### F2 — safe-auto — apps/modal-backend/providers/generate_modes/tap.py:406-407
- Current (lines 406–409):
  `# Classic mode included since the world-only debut (#164's noted`
  `# follow-up): classic submap zooms mush identically; without world`
  `# entities the layout/topdown clauses are simply empty and the redraw is`
  `# prompt + region ref + the same two judges.`
- "(#164's noted follow-up)" is a work-tracking parenthetical — the exact class Jun-9 #8
  dropped ("an `(audit follow-up)` parenthetical"); "since the world-only debut" is gate
  history. The trap ("classic submap zooms mush identically" — don't re-gate to world-only)
  and the mechanics stay verbatim.
- Action: trim-to →
  `# Classic mode too, not just world: classic submap zooms mush identically;`
  `# without world entities the layout/topdown clauses are simply empty and`
  `# the redraw is prompt + region ref + the same two judges.`
- Re-verify: `grep -n "world-only debut" apps/modal-backend/providers/generate_modes/tap.py` → empty;
  `grep -n "mush identically" …/tap.py` → present.
- Confidence: medium-high (licensed by the Jun-9 precedent; wording-only). **Verdict: TRIM (safe-auto).**

### F3 — report-only — apps/modal-backend/generate.py:278 and providers/generate_modes/edit.py:58-59
- Current: `# Absent -> the legacy whole-image edit path, byte-identical to today.` (generate.py
  GenerateBody field doc) and `# Flag off or no mask -> the legacy whole-image path below,
  byte-identical to today.` (edit.py).
- "to today" is a dated anchor that ages; but "byte-identical" is the repo's established
  kill-switch-contract vocabulary (instructions.py "BYTE-FOR-BYTE", generate.py:565
  "byte-identical legacy renders, V1 must-fix 3") and the flag-off contract is load-bearing.
- Option: drop the two words "to today" at both sites. Judgment-y (slightly weakens the
  referent) → per charter, report-only. **Verdict: KEEP unless owner wants the 2-word trim.**

## Adjudicated KEEPs (the assignment's candidate list + notable delta hits)

| file:line | Comment (short) | Why KEEP |
|---|---|---|
| providers/ratelimit.py:29 | "A typo'd RATE_LIMIT_RPM used to silently disarm the limiter — say so once…" | Real bug class + explains warn-once-per-container design. |
| providers/llm/planner.py:468 | "Legacy shape: choice.citations = [url,…]" | Labels a LIVE branch parsing an external router's legacy wire shape (docstring :429 names the routers). External-API tolerance = Jun-9 #3 KEEP class. |
| providers/judge.py:113 | "LOUD, not silent: a judge that can't produce a score used to default to 0.0… corrupting every recon/descent cell" | The trap IS the past behavior; why the warn exists. |
| providers/mock.py:234-237 | "BEFORE the click catch-all: … used to fall into the click route — … Wander stopped instantly" | Ordering invariant + the exact failure it prevents (mock steering contract). |
| providers/llm/client.py:586 | "Truncation/garbage used to collapse to {} in total silence here" | The #127 sin class; why the salvage warn exists. |
| providers/segmenter.py:381-385 | "…1400 tokens truncated real replies and the old bare `except: return []` hid it completely" | Explains max_tokens=4000 + retry wrapper; the old-bare-except is the trap. |
| providers/generate_modes/tap.py:807-814 | "The loop used to arm on steep projections only… Ankh-Morpork demo showed an OBLIQUE enter drifting… Legacy (no deliberate view) enters keep the one-shot path." | Why VIEW_LOOP arms on EVERY deliberate-camera enter — measured failure receipt; last line is present-tense contract. |
| providers/generate_modes/edit.py:46-49 | "…the edit path used to drop both. Thread the text lock…" | Names the drift regression the threading fixes. |
| generate.py:1010-1014 | "…Override with WEB_SEARCH_ON_TAP=true if you want the legacy behaviour back." | Env-override contract; actionable, present. |
| generate.py:895 | "The raw exception used to reach the browser verbatim — …ENTIRE prompt echoed back" | The leak `_friendly_error` prevents. |
| prompt_library/instructions.py:36 | "--- Legacy bodies (verbatim moves; the view=None contract) ---" | Section header carrying the file's core contract (view=None ⇒ pre-grammar strings BYTE-FOR-BYTE, per module docstring :3-4). "Legacy" is live kill-switch vocabulary, and `_legacy_*` identifiers (concern-01 territory) depend on it. |
| instructions.py:720, :871; generate.py:203, :232, :277, :301, :565; tap.py:425, :467-470, :549 | assorted "legacy"/"None ⇒ legacy bytes" | All the same live view=None / flag-off contract vocabulary (VIEW_GRAMMAR kill-switch, "V1 must-fix 3"). SACRED per house style. |
| providers/generate_modes/__init__.py:1-5 + the 4 mode-module docstrings | "…extracted from generate._event_stream. …yields the exact same `_sse(...)` frames the inline branch used to… never reaches back into generate.py's module globals" | `generate._event_stream` is the LIVE dispatcher (generate.py:928, called :1143) — topology pointer + frame-parity + no-globals invariant, not history. |
| providers/image.py (diff ~:3772, :11103) | "(verified no-op; PR #109 removed the inert ref-upload) -> supports_refs=False" | Lesson receipt for a surprising False. |
| providers/register.py + packages/config/src/index.ts (~:18043) | "REGISTER_MIN_SCALE (0.40) < the legacy 0.5 clamp: recon Step 2 (#201) showed…" / "Off (default) = legacy behaviour" | §4 receipts + flag contracts (memory: #200/#201 scale-floor 0.40). |
| apps/web/app/play/page.tsx:481, :648, :1726 | Share "used to be a silent right-click-menu action"; auto-localize "used to dead-end"; wander "used to stall the run silently" | Each names the dead-end/stall the code prevents; :648 is the Jun-13 KEEP verbatim precedent. |
| apps/web/app/play/page.tsx:1027, :2574, :3589, :3668, :3912 | "(UI_AUDIT #N)" refs | docs/UI_AUDIT.md exists; each ref carries the measured failure (≤390px overlap, z-10 click-steal, nowrap overflow). Doc anchors, not plan markers. |
| apps/web/hooks/useAscend.ts:21 | "the ascend used to be the ONE generate that didn't send it" | The style-lock drift bug the field closes. |
| apps/web/lib/coach.ts:5-7 | "the PRE hint used to be gated OFF behind NEXT_PUBLIC_ON_RAMP_COACH… Now it shows ONCE" | On-ramp decision rationale; before/after contrast is doing real work (Jun-13 useWorldMode precedent). |
| apps/web/lib/env-flag.ts:2 | "match the spelling that used to be inlined at each call site (…verbatim old expr…)" | Parity contract for flag semantics — the quoted old spelling pins the truthy set against drift. |
| apps/web/components/PlayPage/TapHint.tsx:15 | "buttons … that used to cover the old full-width left-aligned bar" | Explains WHY `justify-center` is test-pinned (collision class); the "used to" half is the trap. |
| apps/web/hooks/usePrefetchCache.ts:46 | "one cheap batched VLM call (8 spots) no longer exhausts the hover budget" | Why PRECOMPUTE gets its own budget — starvation guard rationale. |
| apps/web/lib session-owner (~:17373) | "Legacy sessions (created before this existed) have no owner doc → the first…" | Persisted-data tolerance for real old rows (external-shape class). |
| mock.py/tap.py/llm.py "#161/#127/#184/#153/#129/#185" refs | e.g. "the #184 lesson: one ungated fal entry", "#127 right-sizing" | Lesson receipts anchoring hard-won lessons — SACRED per charter. |

Remaining keyword hits not tabled: "revisit"/"fixed corner"/"fixed basename"/"used to hydrate"
etc. = false positives (product vocabulary or "is used to"), read and dismissed.

## Draft verdict-table row (Jun-13 style)

| # | Concern | Verdict | Action / commit |
|---|---------|---------|-----------------|
| 8 | Comments / slop | 2 word-level trims | ~49 past-tense hits adjudicated individually — all but 2 are trap-documenting (lesson receipts, view=None/flag-off kill-switch contract vocabulary, external wire shapes, UI_AUDIT/doc anchors) = KEEP. Trims: record-features.ts:308 drops the changelog word "now" (keeps "one hop (#167)"); tap.py:406 drops "since the world-only debut (#164's noted follow-up)" (the Jun-9-dropped parenthetical class; the "classic submap zooms mush identically" trap stays). 0 commented-out code / TODO / stubs / disabled JSX across the +31k delta. 1 report-only option: drop dated "to today" from the two "byte-identical to today" flag contracts (generate.py:278, edit.py:58) — lean KEEP. |

## IMPLEMENTED @ bab2a9d
Both safe-auto trims landed (applied by the campaign coordinator from this report&apos;s exact old→new specs; grep receipts + ruff clean). F3 "byte-identical to today" stays report-only.
