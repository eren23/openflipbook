# openflipbook — local demo stack shortcuts.
#
#   cp .env.example .env   # add FAL_KEY (+ OPENROUTER_API_KEY)
#   make demo              # → http://localhost:3000/play
#
.PHONY: demo demo-local demo-down demo-clean demo-logs

# Local stores (Mongo + Minio) + backend + web, with cloud AI.
# Needs FAL_KEY + OPENROUTER_API_KEY in .env (see .env.example).
demo:
	docker compose up --build

# Adds Ollama so the planner + click VLM run locally too — only FAL_KEY needed
# (images stay on fal). First run pulls multi-GB models; CPU-slow.
demo-local:
	docker compose -f docker-compose.yml -f docker-compose.local.yml up --build

# Stop + remove containers (keeps the mongo / minio / ollama data volumes).
demo-down:
	docker compose -f docker-compose.yml -f docker-compose.local.yml down

# Stop + wipe volumes too — fresh slate (empty DB + blob store + models).
demo-clean:
	docker compose -f docker-compose.yml -f docker-compose.local.yml down -v

# Tail logs from the running stack.
demo-logs:
	docker compose logs -f --tail=100

# ── Eval gates (geometric world model) ───────────────────────────────────────
# Free gates run always (deterministic, no spend). Paid gates spend fal/openrouter
# and only run when their *_BENCH_RUN flag is set — `make eval` excludes them.
PY := apps/modal-backend/.venv/bin/python
.PHONY: eval eval-geometry eval-layout eval-grounding eval-repair eval-edit eval-paid

# The always-on gate: every free phase gate + lints + typechecks. Run between
# phases — must be green before the next phase's commit.
eval:
	cd apps/modal-backend && .venv/bin/python -m pytest -m "not paid" -q
	cd apps/modal-backend && .venv/bin/ruff check . && .venv/bin/mypy providers obs.py generate.py
	cd apps/web && pnpm exec vitest run && pnpm exec tsc --noEmit && pnpm run check:circular

# P1 — pure 2.5D projection parity (TS golden + Py golden + cross-lang fuzz).
eval-geometry:
	cd apps/modal-backend && .venv/bin/python -m pytest -m geometry -q
	cd apps/web && pnpm exec vitest run lib/world-geometry.test.ts lib/world-geometry.fuzz.test.ts

# P3 layout-fidelity A/B: generate each scene with vs without the geometry layout
# clause + VLM-judge both → the lift. PAID (~4 fal gens + judge calls). Needs
# FAL_KEY + OPENROUTER_API_KEY (auto-loaded from apps/modal-backend/.env).
eval-layout:
	cd apps/modal-backend && .venv/bin/python -m tests.world_bench.layout_runner
# P4 grounding-verify: generate from the layout clause, detect the expected
# entities, diff vs intent → the grounded confirmation signal. PAID (fal + VLM).
eval-grounding:
	cd apps/modal-backend && GROUNDING_BENCH_RUN=1 .venv/bin/python -m tests.world_bench.grounding_runner
# B2 segmenter smoke: VLM polygon borders + anchored absolute heights over a
# few existing report JPGs — eyeball the output. PAID (~$0.05, Gemini only,
# zero fal). Override images: SEGMENT_SMOKE_IMAGES=/path/a.jpg,...
eval-segment-smoke:
	cd apps/modal-backend && SEGMENT_BENCH_RUN=1 .venv/bin/python -m tests.world_bench.segment_smoke
# Ground-truth map corpus: fetch the public-domain scans (free, a few MB;
# --pin on first run records sha256s into the manifest) and VLM-draft a
# description for human verification (PAID ~$0.015/map, Gemini only):
#   make corpus-fetch
#   make corpus-draft id=fantasy-treasure-island   (or id=all)
corpus-fetch:
	cd apps/modal-backend && .venv/bin/python scripts/fetch_corpus.py --pin
corpus-draft:
	cd apps/modal-backend && CORPUS_DRAFT_RUN=1 .venv/bin/python -m tests.map_corpus.draft $(or $(id),all)
# Reconstruction bench: regenerate each VERIFIED corpus map from its authored
# description (graph = product planning path, direct = ground-truth layout),
# extract + score vs ground truth + VLM judges. Rides the matrix chassis:
# cached, budget-capped, dry-run without the flag. PAID (~$0.40 first run,
# cached after):  make eval-recon   (preview: make eval-recon-dry)
eval-recon-dry:
	cd apps/modal-backend && .venv/bin/python -m tests.recon_bench.runner
eval-recon:
	cd apps/modal-backend && RECON_BENCH_RUN=1 .venv/bin/python -m tests.recon_bench.runner
eval-repair:
	cd apps/modal-backend && .venv/bin/python -m pytest -m repair -q
eval-edit:
	cd apps/modal-backend && .venv/bin/python -m pytest -m edit -q
# B3 sub-part coherence A/B: ENTER each place WITH vs WITHOUT region-conditioning
# (+ the B2 faithful preamble) → judge faithfulness vs the parent map crop → the
# lift. PAID (fal gens + judge). Needs a live session + the web app running:
#   COHERENCE_BENCH_SESSION=session_xxx make eval-coherence
eval-coherence:
	cd apps/modal-backend && COHERENCE_BENCH_RUN=1 .venv/bin/python -m tests.continuity_bench.coherence_runner
# Style medium-consistency A/B: edit a styled source WITH vs WITHOUT the medium
# lock → judge how faithfully each edit keeps the source's medium → the lift + a
# pass threshold. Guards the edit-path style fix. PAID (fal edits + Gemini judge);
# self-contained, no session needed:  make eval-style
eval-style:
	cd apps/modal-backend && STYLE_BENCH_RUN=1 .venv/bin/python -m tests.continuity_bench.style_runner
# B2 OUTWARD-drift A/B: synthesize each container TWICE — the default zero-drift
# BRIA outpaint vs the SCALE_OUTWARD_RERENDER fresh path — and judge how faithfully
# each keeps the source's medium → the drift number + a trust threshold. Run before
# enabling SCALE_OUTWARD_RERENDER. PAID (fal gens + Gemini judge); no session:
#   make eval-outward-drift
eval-outward-drift:
	cd apps/modal-backend && OUTWARD_BENCH_RUN=1 .venv/bin/python -m tests.continuity_bench.outward_runner
# ENTER-consistency A/B: tap a landmark on a styled map and render the entered
# scene the OLD way (fresh text-to-image, refs ignored) vs the NEW way (edit
# endpoint on the region crop) → "same place?" judge vs the tapped region → the
# LIFT. THE metric for cross-hop visual consistency. Optional extra arms:
#   ENTER_BENCH_MODELS=fal-ai/flux-pro/kontext,openai/gpt-image-2/edit \
#     make eval-enter-drift
# PAID (fal gens + Gemini judge); self-contained, no session needed.
eval-enter-drift:
	cd apps/modal-backend && ENTER_BENCH_RUN=1 .venv/bin/python -m tests.continuity_bench.enter_runner
# VIEW-conformance bench: render the enter five ways (legacy + the four
# deliberate projections) → judge "is it ACTUALLY that projection?" + the
# same-place floor; plus a positioning probe (layout clause + top_down camera
# clause → detector → grounding.diff on correct-register bins). The view
# grammar's gate. PAID (~$2.5; fal gens + Gemini judge); no session needed.
eval-view:
	cd apps/modal-backend && VIEW_BENCH_RUN=1 .venv/bin/python -m tests.continuity_bench.view_runner
# Same bench with the PRODUCTION render loop on the steep arms (judged retries
# with critic feedback, max 3 attempts) — measures what users actually get.
eval-view-loop:
	cd apps/modal-backend && VIEW_BENCH_RUN=1 VIEW_BENCH_LOOP=1 .venv/bin/python -m tests.continuity_bench.view_runner
# E1's gating probe: does gpt-image-2/edit honor mask_url, and with which mask
# convention? 4 gpt arms (3 conventions + no-mask churn control) + the dormant
# flux-pro/v1/fill slot, scored by pixel-diff only. PAID (~$0.5, no VLM).
eval-edit-mask-smoke:
	cd apps/modal-backend && EDIT_REGION_BENCH_RUN=1 .venv/bin/python -m tests.edit_bench.mask_smoke
# E5: the mask-scoped edit bench — the asked change LANDS (alignment judge on
# the inside crop), the edit CONFINES (outside pixel-diff, free, per-case),
# the MEDIUM holds (style judge). EDIT_REGION_BENCH_MODELS adds A/B arms;
# EDIT_REGION_BENCH_LOOP=1 measures the production edit loop;
# EDIT_REGION_BENCH_WHOLE=1 adds the EDIT_JUDGE whole-image arm. PAID (~$1).
eval-edit-region:
	cd apps/modal-backend && EDIT_REGION_BENCH_RUN=1 .venv/bin/python -m tests.edit_bench.runner
# The before/after regression sweep: every PAID eval that has a committed
# baseline band (tests/eval_baselines.json), run back to back. Each prints
# PASS / REGRESSION / IMPROVED vs its band — run it before AND after a risky
# generation-path change and diff the verdicts. ~$7/run; keeps going past a
# single bench failure so one flaky run doesn't hide the rest.
# Free coverage twin: make coverage (no spend).
eval-baselines:
	-cd apps/modal-backend && .venv/bin/python -m tests.world_bench.layout_runner
	-cd apps/modal-backend && STYLE_BENCH_RUN=1 .venv/bin/python -m tests.continuity_bench.style_runner
	-cd apps/modal-backend && GROUNDING_BENCH_RUN=1 .venv/bin/python -m tests.world_bench.grounding_runner
	-cd apps/modal-backend && ENTER_BENCH_RUN=1 .venv/bin/python -m tests.continuity_bench.enter_runner
	-cd apps/modal-backend && VIEW_BENCH_RUN=1 .venv/bin/python -m tests.continuity_bench.view_runner
	-cd apps/modal-backend && EDIT_REGION_BENCH_RUN=1 .venv/bin/python -m tests.edit_bench.runner
# Matrix bench (the evolvable eval): scenarios × arms × models × prompt-
# variants, disk-cached so prompt evolution re-bills only changed cells.
# DRY-RUN IS THE DEFAULT — eval-matrix-dry prints the per-cell cost table
# (the mandatory preview, $0). eval-matrix runs uncached cells under the
# hard budget cap (MATRIX_BUDGET_USD, default $3; MATRIX_ALLOW_PARTIAL=1
# runs to the cap instead of refusing). Scenarios come from the map corpus
# once the recon bench (tests/recon_bench) lands.
eval-matrix-dry:
	cd apps/modal-backend && .venv/bin/python -m tests.matrix_bench.runner
eval-matrix:
	cd apps/modal-backend && MATRIX_BENCH_RUN=1 .venv/bin/python -m tests.matrix_bench.runner

# ── Scenario Lab (unified test bench) ───────────────────────────────────────
# bench-dry is the mandatory $0 cost preview. bench-run spends under the cap.
# SWEEP= picks a sweep file under tests/scenario_lab/sweeps/ (default: layout).
SWEEP ?= layout
.PHONY: bench-dry bench-run bench-compare bench-baselines scenario-new ux-bench-dry ux-bench chain-bench chain-bench-dry

bench-dry: eval-matrix-dry
	cd apps/modal-backend && MATRIX_SWEEP=tests/scenario_lab/sweeps/$(SWEEP).json .venv/bin/python -m tests.scenario_lab.runner

bench-run:
	cd apps/modal-backend && MATRIX_BENCH_RUN=1 MATRIX_SWEEP=tests/scenario_lab/sweeps/$(SWEEP).json .venv/bin/python -m tests.scenario_lab.runner

bench-compare:
	cd apps/modal-backend && .venv/bin/python -m tests.scenario_lab.bench_compare

bench-baselines: eval-baselines

scenario-new:
	cd apps/modal-backend && .venv/bin/python -m tests.scenario_lab.scenario_new $(id)

ux-bench-dry:
	pnpm tsx scripts/ux-bench/run.ts

ux-bench:
	UX_BENCH_RUN=1 pnpm tsx scripts/ux-bench/run.ts

chain-bench-dry:
	cd apps/modal-backend && .venv/bin/python -m tests.scenario_lab.chain_runner

chain-bench:
	cd apps/modal-backend && CHAIN_BENCH_RUN=1 .venv/bin/python -m tests.scenario_lab.chain_runner
# Free coverage report (backend lines + the web view-path files).
coverage:
	cd apps/modal-backend && .venv/bin/python -m pytest -q -m "not paid" --cov=providers --cov=generate --cov-report=term | tail -30
	cd apps/web && pnpm exec vitest run --coverage --coverage.reporter=text 2>/dev/null | grep -E "geo-tap|click-route|world-geometry|image-condition|ClickDetail|All files" || true
# Alias for eval-baselines — the full paid regression sweep.
eval-paid: eval-baselines
# The ladder proof: Playwright drives the REAL app (localhost:3000) through
# map → closeup tap → enter tap across 5 place types, saves the image
# gallery + wire manifests to ladder-proof-runs/<name>, then numeric judges
# score both hops. The eyes-on pass (adversarial subagent verdicts on the
# images) stays manual — no ladder change ships without it. PAID: ~$0.55
# per scenario + ~$0.03 judging. LADDER_ONLY=city,castle narrows scenarios.
ladder-proof:
	cd apps/web && node scripts/ladder-proof.mjs ../../ladder-proof-runs/$${LADDER_RUN:-$$(date +%Y%m%d-%H%M%S)}
ladder-judge:
	cd apps/modal-backend && .venv/bin/python -m tests.ladder_judge ../../ladder-proof-runs/$(LADDER_RUN)
