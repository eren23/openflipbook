#!/usr/bin/env bash
# Endless Canvas — one-shot local setup. Safe to re-run; each step is a check.
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

msg() { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m==>\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m==>\033[0m %s\n" "$*" >&2; exit 1; }

msg "Checking tools"
command -v node >/dev/null || fail "node not found — install Node 20+"
command -v pnpm >/dev/null || fail "pnpm not found — run: npm i -g pnpm"
command -v modal >/dev/null || warn "modal CLI not found — install: pipx install modal"
command -v psql  >/dev/null || warn "psql not found — only needed to run infra/schema.sql"

msg "Installing workspace dependencies"
pnpm install

if [ ! -f "$ROOT/apps/web/.env.local" ]; then
  msg "Creating apps/web/.env.local from .env.example"
  cp "$ROOT/.env.example" "$ROOT/apps/web/.env.local"
  warn "Edit apps/web/.env.local and fill in your keys before running pnpm dev"
fi

if command -v modal >/dev/null; then
  msg "Reminder: run 'modal secret create openflipbook-secrets ...' per docs/BYO-KEYS.md"
  msg "Then: cd apps/modal-backend && modal deploy generate.py"
  msg "Optional streaming: cd apps/modal-backend && modal deploy ltx_stream.py"
fi

msg "Done. Next:"
cat <<'EOF'
  1. Fill apps/web/.env.local with your keys.
  2. Create Modal secret and deploy generate.py. Paste MODAL_API_URL into .env.local.
  3. (Optional) Deploy ltx_stream.py for self-hosted streaming.
  4. psql "$DATABASE_URL" -f infra/schema.sql
  5. pnpm dev
EOF
