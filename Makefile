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
