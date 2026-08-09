# Concern 07 — Defensive code / fail-loud — rerun 2026-08-09

Branch `chore/cleanup-rerun-2026-08-09` @ `e75e3b1`. Delta scope `83e3262..HEAD`
(325 files, +31,209/−5,961 — interiors #161–166, tap=enter #167–173,
coverage #174–186, §4 pose-recovery #189–209). Standard =
`docs/cleanup/07-defensive.md` + Jun-9/Jun-13 reruns (both: **0 removals**,
prior KEEPs are default).

## Verdict up front

- **Removals: 0** (third run in a row). Every handler sits on a boundary
  (network/IO, untrusted VLM/LLM output, base64/image bytes, env coercion,
  browser quirk, observability isolation). Nothing wraps our own deterministic
  logic. The REMOVE bar ("literally zero boundary justification") matched nothing.
- **Silent swallows (the "no error hiding" mandate): 6 findings → log-only
  fixes, identical control flow and return values. 3 more report-only.**
- Scope note on classification: the 07 doc's scope line is removal-framed, but
  its operative KEEP bar is *"(a) wrap a genuine network/IO call and (b) either
  **log the failure** or have an explicit, documented product reason"* — and the
  quoted user directive demands *"clear error handling and no error hiding"*.
  The 6 findings pass (a) and fail (b): removal is unjustifiable, so the minimal
  compliant action is the log line. I classify these **safe-auto** on that
  basis. If the implementer reads the scope line strictly as removals-only,
  demote all six to report-only — the one-liners below stand either way.

House obs idiom (matched by every proposal): `obs.log(level, event, **kv)` with
`error=f"{type(exc).__name__}: {exc}"` (see render_loop.py:224,
edit_loop.py:176, generate.py:770). Inside `providers/llm/client.py` the local
idiom is `_safe_log(...)` (defined :339). `obs.span` logs at error level and
**re-raises** before any enclosing `except` runs — a try that wraps
`async with span(...)` is therefore NOT silent.

---

## SAFE-AUTO findings (log-only; guard + return value unchanged)

### F1. providers/generate_modes/tap.py:753 — zoom judge failure swallowed silently
`except Exception: return first` around `await _verdicts(first)` (VLM judge
calls). Boundary ✓ (network VLM). Silent ✗ — no log in block or caller; the
success path logs `tap.zoom_judge` (info, :755) so a crashed judge is
indistinguishable from "judge disabled". Direct deviation from the sibling
loops, which log `view.loop.judge_failed` / `edit.loop.judge_failed` on the
identical situation. `log` already module-level (tap.py:25).
```python
            except Exception as exc:
                log(
                    "warn",
                    "tap.zoom_judge_failed",
                    attempt=1,
                    error=f"{type(exc).__name__}: {exc}",
                )
                return first
```
Confidence: high. Verdict: **safe-auto**.

### F2. providers/generate_modes/tap.py:789 — zoom retry (render + judge) swallowed silently
`except Exception: return first` around `_render_zoom(retry_instruction)` +
`_verdicts(second)`. Boundary ✓ (fal render + VLM judges). Silent ✗. Sibling
precedent: render_loop logs `view.loop.render_failed` for exactly this retry
class. Same shape as F1, event `"tap.zoom_retry_failed"`, `attempt=2`.
Confidence: high. Verdict: **safe-auto**.

### F3. providers/llm/client.py:497 — `_choice_content` shape failure → silent ""
`except Exception: return ""`. Boundary ✓ (provider-dependent SDK response
shape; prior-run KEEP as a guard). Silent ✗ — and worse: `_parse_choice_json`
turns the "" into `"{}"`, which parses **clean**, so `_safe_json`'s salvage
warn (the #127 fix) never fires. This is precisely the silent-`{}` collapse the
comment at client.py:253–258 names as the failure mode salvage was built to
kill — a shape anomaly today fabricates an empty dict with zero signal.
Salvage-routing does NOT apply here (the failure is an attribute/shape read,
there is no string to salvage; the content path already routes through
`_safe_json`→`salvage_json`). Fix, using the file's own `_safe_log` (:339):
```python
    except Exception as exc:
        _safe_log("warn", "llm.choice_shape_error", error=f"{type(exc).__name__}: {exc}")
        return ""
```
Confidence: high. Verdict: **safe-auto**.
Report-only rider: the non-exception branch `if not response.choices: return ""`
(:494) reaches the same silent-`{}` funnel without an exception; a
`_safe_log("warn", "llm.empty_choices", model=?)` there is the matching fix but
touches a deliberate branch, so it is **report-only**.

### F4. providers/llm/client.py:517 — `_parse_tool_json` shape failure → silent {}
`except Exception: return {}`. Same class as F3 (tool_calls attribute walk;
prior-run KEEP as a guard), same silent-`{}` outcome, same fix:
`_safe_log("warn", "llm.tool_shape_error", error=...)` then `return {}`.
Salvage-routing rejected for the same reason as F3. Confidence: high.
Verdict: **safe-auto**.

### F5. providers/llm/planner.py:478 — `_extract_citations` outer catch → silent citation loss
`except Exception: return out` around the `response.choices[0]` /
annotations/citations walk. Boundary ✓ (SDK response shape — the docstring's
"tolerate both" covers shape *variance*, not a crash). Silent ✗ — called at
:306 AFTER the `planner.plan_page` span closes, so nothing logs; if a provider
changes annotation shape, source chips vanish forever with no signal.
Consequence is cosmetic (citations), so severity low, but the fix is free:
```python
    except Exception as exc:
        from obs import log

        log("warn", "planner.citations_parse_error", error=f"{type(exc).__name__}: {exc}")
        return out
```
(Local import matches the file's inline `from obs import span` style.)
Confidence: medium-high. Verdict: **safe-auto**.

### F6. generate.py:1466 — extract image b64decode failure → silent geo-pass shutdown
`except Exception: geo_img_bytes = b""` on the client-supplied data URL.
Boundary ✓ (untrusted base64 — same class as the KEPT generate.py:1299
posture). Silent ✗ — `b""` is falsy, so the view-estimate task AND detector
localization are silently skipped for the whole request; the nearby
"best-effort" comments (:1457, :1503) document the *degrade*, not the decode
failure. Rare (the same data URL just survived the VLM extract call), but when
it fires, every entity comes back unlocalized with no clue why. `log` is
already in scope (imported :1437, used :1447):
```python
    except Exception as exc:
        log("warn", "extract_entities.image_decode_failed", error=f"{type(exc).__name__}: {exc}")
        geo_img_bytes = b""
```
Confidence: medium. Verdict: **safe-auto**.

### Re-verification (fast)
1. `grep -rn "zoom_judge_failed\|zoom_retry_failed\|choice_shape_error\|tool_shape_error\|citations_parse_error\|image_decode_failed" apps/modal-backend` → 6 hits, one per site.
2. `git diff` shows only added `log`/`_safe_log` lines + `as exc` — no control-flow tokens (`return`, `raise`, values) changed.
3. `cd apps/modal-backend && pytest tests/test_generate_enter.py tests/test_vlm_reply_fixtures.py -q` (zoom-judge section lives at test_generate_enter.py:443+; log-only additions cannot flip these — the degrade behaviour they assert is unchanged).
4. `make eval` (types generate.py + providers, per Jun-13 note).

---

## REPORT-ONLY findings

| # | Site | What | Why not safe-auto | Proposed one-liner |
|---|---|---|---|---|
| R1 | providers/generate_modes/tap.py:1008 | draft race `except Exception: draft_result = None` | Comment-documented ("If the draft itself errored, just skip… main is still running") **and** prior-run KEEP precedent (Jun-7 doc, generate.py:863 — same code before the #124 move). A systematically-broken draft model still burns latency invisibly. | `log("warn", "tap.draft_failed", error=f"{type(exc).__name__}: {exc}")` before `draft_result = None` |
| R2 | providers/segmenter.py:291, :302 | per-label SAM3 fan-out: `_fal_subscribe` / mask-fetch+polygon failure → `return None` (label skipped), no log | Boundary ✓ (paid fal call). Silent per label; an outage degrades to "no borders" with only downstream absence as the clue. But one warn per label could be noisy under a real fal outage (up to `_MAX_SAM3_LABELS` lines/request) — noise-vs-signal is a judgment call. The same function already logs `segmenter.sam3.labels_capped`, so the idiom exists. | `log("warn", "segmenter.sam3.label_failed", label=label, error=...)` in each block |
| R3 | providers/render_loop.py:128 | `data_url_bytes` b64decode → `return None` | Docstring documents the contract ("http(s)/garbage -> None") → passes KEEP bar (b); Jun-13 KEEP. Residual nit: a *corrupt data:* URL (client bug) is indistinguishable from a *remote ref* (by design). Consequence: same-place/medium/interior judge axes silently disarm. | optional `log("warn", "view.loop.region_decode_failed")` inside the except only (http/None path untouched) |

## Charter candidates cleared as KEEP (verified against the bar)

| Site | Verdict | Evidence |
|---|---|---|
| providers/llm/planner.py:445 (`_push` urlparse) | KEEP | untrusted model URL; failure only coarsens the dedupe key from domain→full-URL — zero data loss, a log would be noise |
| providers/llm/planner.py:568 (`rewrite_motion_prompt`) | KEEP — **not silent** | try wraps `async with span("llm.rewrite_motion")`; obs.span logs error-level + records the span, then re-raises into the catch. Docstring documents the degrade ("Strictly additive: failures fall back to the original page_title") |
| providers/llm/planner.py:625 (`polish_edit_instruction`) | KEEP — not silent | same span pattern (`llm.polish_edit`) + documented additive degrade |
| providers/llm/planner.py:697 (`polish_fill_description`) | KEEP — not silent | same (`llm.polish_fill`); docstring: "LLM failure degrades to the raw instruction + the locks". (Residue in all three: the post-span `response.choices[0]` read is span-uncovered — an empty-choices 200 degrades unlogged. Rare; F3's `llm.choice_shape_error` class; not worth a third event name.) |
| providers/edit_loop.py:119 (`inside_crop_bytes`) | KEEP | docstring documents "a decode failure -> the full frame (judging diluted beats not judging)"; Jun-13 KEEP; practically unreachable for undecodable bytes (the mask path's `changed_fraction` raises first and IS logged `edit.loop.diff_failed`) |
| providers/render_loop.py:128 | KEEP (guard) + R3 note | above |
| generate.py:1466 | guard KEEP + F6 log | above |
| providers/llm/client.py:497/:517 | guard KEEP + F3/F4 log | above |

---

## MUST-STAY receipts (all verified present and loud)

- `salvage_json` machinery: client.py:531–591 intact; `_safe_json` logs
  `llm.json_salvage` warn (:588); `tests/fixtures/vlm_replies/` present
  (detector_gemini_pretty_duplicate_keys.txt, detector_minified_clean.txt,
  detector_truncated_length.txt, extraction_truncated.txt, …) +
  tests/test_vlm_reply_fixtures.py. **Now also consumed by judge.py:99–110**
  (salvage-walks truncated judge replies) and segmenter.py (`llm.salvage_json`
  after the polygon call) — the #127 class fix propagated.
- client.py:633 transient retry: logs `llm.retry` warn per attempt, `raise last`
  at exhaustion (:649). ✓
- client.py:741 tier fallback: logs `llm.tier_downgrade` warn per rung, sticky
  `_JSON_SCHEMA_DEMOTED`, `raise last_error` when the ladder exhausts (:758–759). ✓
- obs.py:239 (sentry init→False), :268 (stdout write pass), :344 (trace-id body
  parse), :385 (sentry capture pass) — the logger can't log from itself. ✓
  (obs.span :288 still logs-then-**raises**.)
- generate.py HTTP-handler boundaries: 1109 (SSE `sse.generate.end` error log →
  error event), 1136 (→400), 1206/1274/1350 (record_error → 502 JSON),
  1483 (record_error → `_err_json`), 1710/1761 (record_error → `_err_json`);
  1098 CancelledError → clean bail, logged info. ✓
- providers/breaker.py: **zero** except statements (counter logic — nothing to
  assess). ✓

## Delta survey — everything else (all KEEP)

**Python, new/changed since 83e3262:**

| Site | Class | Loudness |
|---|---|---|
| generate.py:737 (SAM3 refine), :765 (grounding loop) | network best-effort | `grounding.sam3_failed` / `grounding.failed` warn ✓ |
| generate.py:807 `StopAsyncIteration` | generator control flow, not error handling | n/a |
| generate.py:816 `suppress(Exception)` on `stream.aclose()` | generator cleanup in `finally` | correct-silent |
| generate.py:1004/1006 abort poll | re-raises CancelledError; only polling failure swallowed (comment) | prior-run KEEP |
| generate.py:1588/1606/1623 (outlines/localize/view) | network best-effort | `extract.segment_failed` / `extract.localize_failed` / `extract.view_failed` + the `extract.localized` located=0 warn ✓ |
| providers/generate_modes/expand.py:72, :183 | per-tile/per-neighbour fan-out | `expand.pan_failed`/`expand.neighbor_failed` warn + `record_error` ✓ |
| providers/generate_modes/ascend.py:219 | SSE mode boundary | `ascend.failed` warn + record_error + friendly error SSE event ✓ |
| providers/generate_modes/tap.py:717/:723/:882 | env-float coercion | obs.py:66 posture, KEEP |
| tap.py:999 `suppress(Exception, CancelledError)` | reaping a task we just cancelled | correct-silent |
| providers/llm/extraction.py:301/:365, click.py:643, coordinate_scale.py:27, prompt_library/policy.py:237-ish | `float()` of untrusted VLM values → default/skip | established KEEP class (#157–159 ladder) |
| providers/judge.py:47 (env int), :72 (transport recompress → original bytes; judge still runs), :99 (parse → **salvage** → `judge.unparseable` warn + UNPARSEABLE-prefixed 0) | untrusted output | exemplary — the "silent 0" class killed by design |
| providers/segmenter.py:172/:219 (float coercion), :291/:302 (R2 above) | untrusted values / fal fan-out | :385 comment records the old bare `except: return []` was killed |
| providers/image.py:400 (PROVIDER_FALLBACK step — breaker record + warn + `raise last_exc` at exhaustion), :681 (env ValueError) | prior-run KEEP posture unchanged | ✓ |
| providers/llm/client.py:175 (obs must not block client init — commented), :221 (`_log_cache_usage`, obs-internal), :345 (`_safe_log` itself), :545/:554/:574 (JSONDecodeError rungs INSIDE salvage_json — the ladder), :610 (env ValueError) | obs isolation / repair ladder | KEEP |
| **providers/register.py, providers/llm/world.py, providers/inpaint.py, providers/video.py** | the §4 register + world planner: **zero** except statements | fail-loud discipline held on the newest code |
| moderation.py:50, ltx_stream.py:114 suppress | prior-KEEP (fail-open module docstring / optional CUDA offload) | unchanged |

**TypeScript delta (apps/web):** every added catch is boundary + loud, or
comment-documented best-effort. Highlights — several actively IMPROVED loudness:
`ascend/route.ts:187` geo-revert failure → `recordError("ascend.geo_revert_failed")`;
`extract/route.ts:337` geo seeding failure → `recordError("extract.geo_seed_failed")`
(the Jun-7 run's comment-only swallow, now queryable);
`world-map.ts:492` INV-4 scale warn → `recordError("world-map.inv4")` with an
explicit "queryable in prod instead of invisible" comment. The rest:
body-parse → 400 (entity:55), mutation boundary → 400/502 with message
(entity:118, extract:391, bench/rerun:44 dev route → 500 + stdout/stderr),
compensating cleanup inside already-surfaced error paths
(`deleteNode(pId).catch(() => {})`, ascend:168/:180), fire-and-forget
`recordError(...).catch(() => {})` (obs-must-not-break), duplicate-key checks
that **rethrow** non-dup (idempotency.ts:51, session-owner.ts:68 — exemplary),
commented best-effort stamps (extract:204/:332/:360, generate-page:56/:168/:176),
wander step catch with documented re-arm semantics (useWander.ts:142), and
play/page.tsx's new catches all in the localStorage / pointer-capture /
canvas-taint / clipboard(with user-visible degrade note) classes. **0 TS findings.**

## Full-enumeration receipt

Python production (`apps/modal-backend`, tests/scripts excluded), real
`except` statements: **86** across 24 files + **4** `contextlib.suppress` = 90.

generate.py 18 · llm/client.py 11 · obs.py 10 · generate_modes/tap.py 6 ·
llm/planner.py 5 · segmenter.py 4 · render_loop.py 4 · edit_loop.py 4 ·
view_estimator.py 3 · judge.py 3 · spend.py 2 · llm/extraction.py 2 ·
image.py 2 · generate_modes/expand.py 2 · ratelimit.py 1 ·
prompt_library/policy.py 1 · moderation.py 1 · model_router.py 1 ·
llm/click.py 1 · image_edit.py 1 · generate_modes/ascend.py 1 · detector.py 1 ·
coordinate_scale.py 1 · ltx_stream.py 1. (suppress: generate.py, moderation.py,
tap.py, ltx_stream.py — one each.) Zero-handler files of note: breaker.py,
register.py, llm/world.py, grounding.py, geometry.py, heights.py, pixel_diff.py,
geometry_checks.py, local_server.py, ltxf.py, _env.py.

TypeScript production (`apps/web` app/components/hooks/lib, tests excluded):
**117** try/catch blocks + **26** promise `.catch(` chains = 143 across ~60 files.

Accounting: 90 Py + 143 TS = 233 handlers enumerated; 6 safe-auto (log-only),
3 report-only, 0 removals, all others KEEP (prior-run classifications
re-confirmed where line numbers shifted).

## Scope ruling (coordinator, 2026-08-09)

The safe-auto classification of the 6 log-only fixes is licensed by the
campaign's governing mandate for THIS rerun — *"clear error handling and no
error hiding"* — which supersedes the 07 doc's removal-only framing. Removals
stay 0; the 3 report-only items stay report-only; the corrected non-silent
sites (planner span-wrapped blocks, render_loop/edit_loop documented
contracts) stay untouched.

## Draft verdict-table row (Jun-13 style)

| # | Concern | Verdict | Action |
|---|---------|---------|--------|
| 7 | Defensive (fail-loud / no error hiding) | **0 removals; 6 silent swallows made loud** | Third run with zero removable handlers — 233 enumerated (90 Py, 143 TS), every one a real boundary; the §4 register + world planner shipped with ZERO try/except. The "no error hiding" pass found 6 truly-silent swallows and fixed them log-only (control flow + return values byte-identical): tap.py zoom-judge/retry (`tap.zoom_judge_failed`/`tap.zoom_retry_failed` — the siblings already logged), llm/client `_choice_content`/`_parse_tool_json` shape failures (`llm.choice_shape_error`/`llm.tool_shape_error` — the silent-`{}` collapse that bypassed salvage's warn), planner `_extract_citations` (`planner.citations_parse_error`), extract image-decode (`extract_entities.image_decode_failed`). 3 report-only (tap draft race — prior-run KEEP precedent; segmenter per-label SAM3 skips — noise judgment; render_loop data-URL decode — documented contract). salvage_json now also guards judge + segmenter parses; TS delta added recordError routing to three formerly-quiet paths. |

IMPLEMENTED @ 838575d — 6 log-only fixes on 8831cb9 (lines shifted vs research: tap 759/795, generate 1468; client/planner unshifted). Gates: make eval green (832 web tests, madge 0 cycles), pnpm lint 0 err/17 warn (0 added), backend pytest -m "not paid" cov 86.72% >= 85, targeted test_generate_enter+test_vlm_reply_fixtures green, pre-commit ruff clean. Diff receipt: only removed lines are the six bare "except Exception:" headers; +41/-6 across 4 files.
