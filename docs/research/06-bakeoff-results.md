# 06 — Paid bakeoff results

Run 2026-06-09 from the live `apps/modal-backend/.env` (FAL_KEY + OPENROUTER_API_KEY present).
Judge = Gemini 3 Flash (pinned in `layout_runner._load_env` + the env already sets
`OPENROUTER_VLM_MODEL=google/gemini-3-flash-preview`, not qwen). Render = `nano-banana-pro`
(balanced — the env already sets `FAL_IMAGE_MODEL_BALANCED=fal-ai/nano-banana-pro`, so the
nano-banana label-garble pin is not in effect). Both gotcha-guards from memory were already
satisfied by the live config. Spend: 4 nano-banana-pro generations + 4 Gemini judges ≈ **<$1**
of the ~$25 budget.

## S5 — do the layout bins steer the render? (the #1 gated question) → **YES**

`tests.world_bench.layout_runner` at **balanced tier** (the real nano-banana-pro render path),
each scene generated WITH vs WITHOUT the geometry layout clause
(`geometry_prompt.layout_constraints`), Gemini-judged for layout fidelity against the expected
`h_pos/v_pos/size` bins:

| scene | without | with | lift |
|---|---|---|---|
| lighthouse-coast | 0.37 | 0.98 | **+0.60** |
| market-square | 0.92 | 0.98 | +0.05 |
| **mean** | 0.645 | **0.977** | **+0.33** |

**Verdict:** the coarse bins genuinely steer `nano-banana-pro` — strongly when the base prompt
under-determines placement (lighthouse 0.37→0.98) and harmlessly when the scene is already
well-placed (market near-ceiling, +0.05). This **confirms the Branch-2 call to wire
`expected_layout` into the fresh render** (`00-overview`, `02`): a clear win at ~zero downside.
Matches the literature prior (Gemini-class structured prompting reports >90% relative-position
compliance — `02`).

**Caveats** (per `05`, VLM-judge-is-a-ranker): N=2 scenes, single run, Gemini judge
(Spearman ~0.6, under-penalizes misalignment) — treat **+0.33 as a directional lift, not a
calibrated metric**. The hard-case jump (+0.60) is strong enough to act on; a larger scene set
at N≥3 would tighten the estimate and is the natural follow-up once Branch 2 wires the clause in
(the `05` baseline-drift guard would then pin it).

## Not run (needs Branch-2 code, or re-confirms a known result)

- **S4 — OUTWARD ref no-op fix.** The proposed fix (route `scale_parent_fresh` through the
  *edit* endpoint, which honours refs) is itself a Branch-2 change; the existing `outward_runner`
  only A/Bs BRIA-outpaint vs fresh-rerender, not the edit-endpoint path. Run it once that route
  lands.
- **Style medium-lock (S1/S3).** Already measured +8.5 (`style_runner`, `SESSION_AUDIT.md §5`);
  re-running re-confirms a known result, so skipped to conserve budget.

Budget remaining: **~$24**. The single decision-relevant unknown (do the bins steer?) is
resolved positively; the rest of `01`'s bakeoff grid can run cheaply when its Branch-2
counterparts exist.
