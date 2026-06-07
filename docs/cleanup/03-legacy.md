# Cleanup 3 — Deprecated / legacy / fallback paths

Workstream 3 of the sequenced code-quality cleanup. Scope: **collapse dual
old/new code paths to a single current path; remove genuinely dead back-compat
branches and obsolete env-var escape hatches.** Dedup, type-strengthening,
try/catch-swallow and comment cleanups belong to other workstreams and were left
untouched.

Method: grep `deprecated|legacy|back-compat|fallback|no longer|superseded|TODO|
FIXME|HACK|XXX` across `apps/web`, `apps/modal-backend`, `packages/config`
(excluding `.next/`, `node_modules/`, tests). Every hit was classified
**REMOVE** (dead/superseded) / **KEEP** (live feature or external-API tolerance)
/ **borderline** (documented contract — leave, note here).

The bar for removal was high: a candidate had to have **no documentation surface
(.env.example / docker-compose / docs), no test surface, and no live call
surface** before it was cut. Exactly one candidate cleared that bar.

## What I removed

### `USE_LTX_PRO` legacy toggle — `apps/modal-backend/providers/video.py:67-69`

```python
# Legacy USE_LTX_PRO toggle still honored when no explicit tier is passed.
if tier is None and os.environ.get("USE_LTX_PRO", "").lower() in ("1", "true", "yes"):
    return PRO_ANIMATE_MODEL
```

**Verdict: REMOVE (dual path → singular).** This is the pre-tier boolean escape
hatch for "use the pro animate model," fully superseded by the per-tier video
system: the `pro` tier already maps to `PRO_ANIMATE_MODEL` in `TIER_VIDEO_MODELS`,
and `FAL_ANIMATE_MODEL` is the wholesale override. `USE_LTX_PRO` had **zero**
surface anywhere else:

- Not in `apps/modal-backend/.env.example`, root `.env.example`, any
  `docker-compose*.yml`, or `docs/`.
- Not in the user's live `apps/modal-backend/.env`.
- Not in `tests/conftest.py`'s scrub list, and no test exercises
  `_animate_model` / `USE_LTX_PRO` / `animate_image` at all.
- Only reference in the entire repo was its own definition site.

`_animate_model` now has a single, linear resolution: explicit
`FAL_ANIMATE_MODEL` override → per-tier env (`FAL_VIDEO_TIER_{FAST,BALANCED,PRO}`)
→ built-in tier default. No env/doc updates needed (the var was never
documented). Green gate confirmed after removal (see below).

## What I assessed and KEPT (with reasoning)

### `FAL_IMAGE_MODEL` legacy env — `providers/image.py:105-106`

```python
legacy = os.environ.get("FAL_IMAGE_MODEL")  # backwards-compat for old setups
return os.environ.get(env_key) or legacy or TIER_MODELS[resolved_tier]
```

**Verdict: KEEP (documented contract + live user dependency + test-guarded).**
This is the prior-art analogue of `USE_LTX_PRO` and was the brief's lead removal
candidate, but it is the *opposite* situation on every axis:

- **Documented**: `apps/modal-backend/.env.example:44` (`FAL_IMAGE_MODEL=fal-ai/nano-banana`).
- **Live**: the user's own `apps/modal-backend/.env:7` sets it.
- **Test-guarded**: `tests/test_image_provider.py:56-62`
  (`test_resolve_model_legacy_env_used_for_unset_tier`) asserts it wins over the
  built-in default when no per-tier env is set; `:50-53` asserts fall-through.
  It's also in `tests/conftest.py:37`'s scrub list.

Removing it would break a documented env contract, the user's running config,
and two passing tests. Per the guardrail ("if it's a real escape hatch users
rely on, leave it and note in the doc rather than break the contract"), this
stays. The resolution order (`override > per-tier > legacy > default`) is
already singular and correct — `FAL_IMAGE_MODEL` is just the lowest documented
rung, not a competing code path.

### `OPENROUTER_VLM_MODEL` back-compat — `providers/llm.py:319-325`

```python
# LLM_VLM_MODEL (provider-native slug) wins; OPENROUTER_VLM_MODEL is the
# back-compat path; then the built-in default.
return (
    os.environ.get("LLM_VLM_MODEL")
    or os.environ.get("OPENROUTER_VLM_MODEL")
    or DEFAULT_VLM_MODEL
)
```

**Verdict: KEEP (live, widely-referenced, documented env var).** Despite the
"back-compat path" comment, this is not dead. `OPENROUTER_VLM_MODEL` is:

- The default-provider knob for the openrouter path (the project default).
- Referenced live across `providers/detector.py:20`, `providers/view_estimator.py:23`,
  every bench runner (`click_bench`, `world_bench`, `continuity_bench`).
- Documented in `docs/BYO-KEYS.md` (×3), root `.env.example:31`,
  `apps/modal-backend/.env.example:9`, `docker-compose.demo.yml:8`.
- Set in the user's live `.env:4`.

The two-rung chain (`LLM_VLM_MODEL` provider-native slug → `OPENROUTER_VLM_MODEL`
openrouter slug) is the live multi-provider selection contract (M1, "provider
freedom," done), not a superseded openflipbook-internal path. KEEP.

### OpenRouter legacy `citations` key handling — `providers/llm.py:1291, 1330-1339`

**Verdict: KEEP (external-API shape tolerance for a live feature, not internal
legacy).** `_extract_citations` reads two response shapes: the current
`message.annotations[].url_citation`, and the older `choice.citations` list that
"different routers occasionally use." This is **defensive tolerance of genuine
external API variance**, not a dual path within openflipbook's own evolution.
Multi-provider/router freedom is a live shipped feature; some OpenRouter-compatible
routers still emit the `citations` shape. Removing it would silently drop
citations on those routers — a real (if narrow) regression of the web-search
grounding feature. This falls under the "genuine graceful-degradation" guardrail.
Borderline by keyword, clear KEEP on substance.

### `WEB_SEARCH_ON_TAP` — `generate.py:382-390`

**Verdict: KEEP (documented active product toggle).** The comment says "if you
want the legacy behaviour back," but the flag is not a dead branch — it gates a
*current* product decision (tap-mode disables `:online` web search by default
because the parent image/title/subject already constrain the page). It is
documented in `apps/modal-backend/.env.example:57-61` with rationale. This is an
active operator toggle, not legacy code; removing it would delete a documented,
deliberate degradation knob. KEEP.

### `fallbackVideoUrl` path — `apps/web/app/play/page.tsx` (state @392, ~15 uses)

**Verdict: KEEP (this *is* the live video graceful-degradation feature).** The
name reads like a dead "fallback," but it is the cheap-via-fal video URL state
that powers the explicitly-protected product degradation: when the self-hosted
WS LTX stream isn't deployed (`getWSUrl()` empty), `connectStream` generates a
clip via `/api/animate`, stores the URL in `fallbackVideoUrl`, and drives the
"Replay clip" affordance + the figure's video/still toggle. The guardrail names
"the LTX video stream → static image degradation" as a real product feature to
keep. It is woven into render logic and behavior throughout the file. KEEP.

### `route.ts:31` world_context "fall back to raw text"

**Verdict: KEEP (graceful enrichment, not legacy).** `app/api/generate-page/route.ts`
parses the body to inject `world_context`, and falls back to forwarding the raw
text if parsing/enrichment fails so the enrichment can "never block generation."
Genuine product graceful-degradation around an optional enrichment. KEEP.

### `_resolve_structured_tier` / `_TOOL_CALL_FAMILIES` — `providers/llm.py:344-408`

**Verdict: KEEP (model-swap robustness for live multi-provider feature).** The
"Back-compat is load-bearing" comment here means the *openrouter default path is
byte-unchanged* while direct/custom providers get tool/prompt rungs — it is a
forward-compat substring ladder for the provider-freedom feature, not dead code.
The two families tuples and the JSON/tool/prompt ladder are all reachable on the
custom/direct providers. KEEP.

### Misc keyword-only hits (no action)

- `apps/web/hooks/useContainRect.ts:11`, `useExpandBloom.ts:92`,
  `lib/world.ts:356,401,795`, `lib/db.ts:113-118,233` — "no longer / superseded /
  backwards-compatible / forward-compat" all appear inside **explanatory comments
  about current behavior** (soft-delete rationale, optional+defaulted Mongo
  fields, stream-supersede guards). No dual code path; comment-cleanup is
  workstream 8's concern, not mine.
- `lib/world-layout.ts:228`, `lib/trace-types.ts:67`, `packages/config/src/index.ts:387,539`,
  `providers/llm.py` click-resolution `fallback_subject` (`734,844,874,933,961,984`),
  `providers/image_edit.py:8` — all genuine product fallbacks/defaults (overlap
  push-out, default trace color, name→alias resolution, crosshair-as-subject,
  the documented reason the standalone qwen-edit slug is unused). KEEP.
- `lib/world.ts:401,795` "whack-a-mole" + the only two `TODO|FIXME|HACK|XXX` hits
  in real source are both the soft-delete design note — not actionable markers.

## Net change

One dual path collapsed to singular (`USE_LTX_PRO` removed from `_animate_model`).
No env vars removed → no `.env.example` / `docker-compose` / docs edits required.
Everything else flagged by the keyword sweep is either a live feature, an
external-API tolerance, or a documented contract, and was deliberately retained.

## Green gate

Verified **after** the removal (baseline was also green before):

- `make eval` — Python `pytest -m "not paid"` all pass (2 pre-existing paid
  skips), `ruff check .` clean, `mypy` on the gated files clean, web `vitest`
  **395 passed / 51 files**, `tsc --noEmit` clean, `check:circular` clean.
- `cd apps/web && pnpm exec eslint . --max-warnings=20` — **0 errors, 16
  warnings** (unchanged from baseline; all pre-existing `<img>` / type-import
  warnings, under the 20 cap).
