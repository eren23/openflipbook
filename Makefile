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
	cd apps/modal-backend && .venv/bin/ruff check . && .venv/bin/mypy providers/geometry.py providers/geometry_prompt.py providers/model_router.py providers/grounding.py providers/detector.py generate.py
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
	cd apps/modal-backend && .venv/bin/python -m tests.world_bench.grounding_runner
eval-repair:
	cd apps/modal-backend && REPAIR_BENCH_RUN=1 .venv/bin/python -m pytest -m repair -q
eval-edit:
	cd apps/modal-backend && EDIT_BENCH_RUN=1 .venv/bin/python -m pytest -m edit -q
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
# The full paid sweep (spends fal/openrouter on the tiny golden set).
eval-paid:
	cd apps/modal-backend && LAYOUT_BENCH_RUN=1 GROUNDING_BENCH_RUN=1 REPAIR_BENCH_RUN=1 EDIT_BENCH_RUN=1 .venv/bin/python -m pytest -m paid -q
