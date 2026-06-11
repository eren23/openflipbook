# PLAN — speed/budget/model controls in the UI, with live cost projection

> **Status: shipped** (June 2026). All four steps landed, plus the concurrent
> judges (step 4 was promoted from optional — it was the demo's wall-clock
> pain). Names settled as **fast / balanced / quality**; the chip shows real
> dollar ranges (`lib/cost-estimate.ts`, vitest-pinned to `docs/COSTS.md`);
> the 3-stop preset sits inline next to the tier toggle with the granular
> knobs (attempts, verify) behind the ⚙ popover. One deviation from the text
> below: `max_attempts` clamps to a hard server cap of 4 rather than the env
> ceiling (the env default of 2 would have made Quality's 3 attempts
> unreachable), and the preset store is global localStorage, not per-session
> (it drives the global image tier — per-session would desync).

## Context

The Ankh-Morpork re-shoot made the problem visible: the default path is
heavy (an enter fires up to 13 sequential model calls + judged retries + a
full-res re-upload), and the user has **no way to say "I just want it fast and
cheap right now"** beyond the existing `fast/balanced/pro` image-tier toggle —
which only changes the image model, not the judging or the retries. And there
is **no cost feedback at all**: you can't tell that one tap costs ~$0.16 and a
2-attempt enter ~$0.32 until the bill arrives. `docs/COSTS.md` is the
accounting; this plan surfaces it as a control you can turn, with the number
shown before you spend it.

Goal: one **Economy ↔ Balanced ↔ Quality** preset that bundles
{image model, retry attempts, verification on/off, judge model} and shows the
**projected cost per action** live — plus an advanced expander for granular
control. Additive, per-session, flag-free (it's user preference, not a kill
switch).

## What already exists (reuse, don't rebuild)

- **Image tier** (`fast/balanced/pro`) already flows per-request:
  `useImageTier()` (localStorage `openflipbook.tier`) → toolbar toggle
  (`QueryToolbar.tsx:113-137`) → `image_tier` on every `generate()` call →
  backend `_resolve_model` (`providers/image.py`). `pro` already warns once
  ("slower + pricier"). This is the exact pattern to extend.
- **Persisted-preference hook pattern**: `usePersistedTier.ts` (SSR-safe,
  hydration-deferred, `[value, setter]`) — mirror it for the new preset.
- **Per-request model override** `image_model` exists on the wire but is never
  set from the UI — the budget-alternative slugs (`docs/COSTS.md`) can ride it.
- **`world_mode` / `autonomy`** already flow per-request (the toggle pattern).
- **`docs/COSTS.md`** — the cost source of truth (prices + per-op + token
  counts). The TS projection table mirrors its numbers.

## The gaps to close

1. **Retry attempts are env-only.** `VIEW_LOOP_MAX_ATTEMPTS` /
   `EDIT_LOOP_MAX_ATTEMPTS` are read from `os.environ` in `render_loop.py` /
   `edit_loop.py`. No per-request control → a user can't pick "one shot, no
   retries" for a fast pass.
2. **Verification is all-or-nothing by env flag.** `VIEW_LOOP` / `EDIT_JUDGE`
   are deployer kill-switches, not per-request. Economy mode wants "skip the
   judges this time" without flipping a server flag.
3. **No cost feedback.** Nothing shows the projected spend of the current
   config before you act.

## The design — one preset, three stops

A **Speed/Quality preset** in the toolbar (next to the image-tier toggle),
persisted per session, that sets a bundle and projects cost:

| Preset | Image | Retries | Verify (judges) | Judge model | ≈ per tap / per edit |
|---|---|---|---|---|---|
| **Economy** | fast (`nano-banana` $0.039) | 1 | off | — | **~$0.04 / ~$0.04** |
| **Balanced** (default) | balanced (`nano-banana-pro` $0.15) | up to 2 | on | flash | **~$0.16–0.32 / ~$0.11–0.21** |
| **Quality** | pro (`riverflow` $0.24) | up to 3 | on | flash | **~$0.25–0.5 / ~$0.2–0.4** |

The projection number is computed, not hard-coded — `lib/cost-estimate.ts`
holds the price constants (mirrored from `docs/COSTS.md`) and a
`projectCost(preset, action)` that returns a `{low, high}` range. The toolbar
renders a small chip: **"≈ $0.04 per tap · fast, no verify"** that updates as
the preset (or the advanced knobs) change. Honest ranges, not false precision.

**Advanced expander** (a small popover, mirror the existing tier-toggle
markup): granular control over the four axes above, for power users — the
preset is just a shortcut that sets all four. Changing an advanced knob shows
"Custom" as the preset and re-projects.

## Wire changes (additive, backwards-compat)

`packages/config/src/index.ts` `GenerateRequestBody`:
```ts
// Per-request loop control (absent → today's env defaults). Economy sets
// max_attempts:1 + verify:false for a fast, un-judged pass.
max_attempts?: number;   // clamps to [1, env max] server-side
verify?: boolean;        // false → skip the judged loop this request
```
`image_model` already exists — Economy/Quality can set the budget/premium slug
through it (or keep using `image_tier`; the preset decides).

Backend threading (small, localized):
- `generate.py` reads `body.max_attempts` / `body.verify`, passes them into
  `render_loop.loop_config_from_env()` / `edit_loop.edit_loop_config_from_env()`
  as overrides (the configs already centralize attempts — add an optional
  `max_attempts_override` param, clamp to the env ceiling so a deployer cap
  still wins).
- `verify:false` → skip the loop branch entirely (the existing one-shot path
  the loop already falls back to when `enter_view is None`), so it's the
  proven zero-overhead route, just user-chosen.
- Byte-identity: absent fields → exactly today's behavior.

## UI surface

- `components/PlayPage/SpeedPreset.tsx`: the 3-stop segmented control + the
  cost chip + the advanced popover. Presentational; the page owns state.
- `hooks/useSpeedPreset.ts`: persisted per session (mirror `useWorldMode`),
  returns `{preset, custom, setPreset, setCustom}` where `custom` holds the
  four advanced axes.
- `lib/cost-estimate.ts`: pure price table + `projectCost()` — vitest-pinned
  against the `docs/COSTS.md` numbers so they can't silently drift.
- `app/play/page.tsx`: read the preset, spread `{max_attempts, verify}` (and
  `image_tier`/`image_model` per the preset) into every `generate()` body —
  the same spots `image_tier` already goes.

## Build sequence (PR-sized)

1. **Backend per-request loop control**: `max_attempts` + `verify` on the wire
   + the config overrides in `generate.py`/render_loop/edit_loop, clamped to
   env ceilings. Tests: a request with `max_attempts:1 verify:false` takes the
   one-shot path (no judge calls); absent → env default (byte-identity).
2. **`lib/cost-estimate.ts`** + vitest: the price table mirrored from
   `docs/COSTS.md`, `projectCost(preset, action)` ranges, a test that fails if
   the constants drift from the doc's headline numbers.
3. **`useSpeedPreset` + `SpeedPreset.tsx`** + the cost chip, wired into the
   toolbar and the `generate()` bodies. Vitest on the pure preset→bundle map.
4. (optional) **Concurrent judges** — the latency win named in `docs/COSTS.md`:
   run the 4 enter judges with `asyncio.gather` instead of sequentially. Pure
   backend, no UI; cuts an enter's judge time ~4×. Worth doing alongside.

## Verification

- Free: `make eval` — the new wire fields' byte-identity test, the cost-table
  drift test, the preset→bundle map test.
- Manual: pick Economy → the chip reads ~$0.04, a tap does one un-judged fast
  render (confirm in the backend log: no `view.loop` markers, `fast` model);
  pick Quality → the chip jumps, the log shows judged retries. Confirm the
  projection range brackets the real per-action spend over a few actions.
- The cost numbers trace to `docs/COSTS.md`; if fal/OpenRouter prices move,
  update the doc and the test catches the drift.

## Open questions for you

- **Preset names**: Economy/Balanced/Quality, or Fast/Default/Best, or a
  literal "$ / $$ / $$$"? (I'd lean Fast/Balanced/Quality — verbs, not money.)
- **Show dollars or relative?** A real "$0.04" chip is honest but ties the UI
  to live prices; a "~3× cheaper" relative chip ages better. (I'd show the
  dollar range with a tooltip linking the breakdown.)
- **Where**: in the always-visible toolbar (one more control) vs behind a
  small ⚙ settings popover (keeps the toolbar clean). (I'd put the 3-stop
  preset inline and the advanced axes in the popover.)
