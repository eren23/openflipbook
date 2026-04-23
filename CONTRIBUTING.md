# Contributing to Endless Canvas

Thanks for taking a look. This is a small, opinionated repo — a clean-room re-implementation of the [flipbook.page](https://flipbook.page) paradigm, designed to be self-hosted with your own keys.

## Ground rules

- **No Flipbook source code.** Everything here was written from public bundle inspection. Don't PR anything derived from their source.
- **BYO-keys stays BYO-keys.** We're not adding a hosted backend or pooled credentials.
- **One image per page.** The image-as-UI paradigm is the point; don't propose DOM-based page layouts.

## Local dev

```bash
git clone https://github.com/eren23/openflipbook
cd openflipbook

brew install pnpm modal-cli uv    # or your equivalents
pnpm install

cp apps/modal-backend/.env.example apps/modal-backend/.env
cp .env.example apps/web/.env.local
# fill both in — see docs/BYO-KEYS.md

docker compose up -d --build
open http://localhost:3000/status  # should show green for every env var
open http://localhost:3000/play
```

Without Docker, see [`docs/LOCAL_DEV.md`](docs/LOCAL_DEV.md).

## Making changes

- `pnpm -r typecheck` must pass.
- `pnpm --filter @openflipbook/web build` must succeed.
- Keep the modal backend provider modules (`apps/modal-backend/providers/*`) swappable — no hard couplings to a single vendor.
- If you touch the SSE or LTXF wire protocol, update [`docs/STORY.md`](docs/STORY.md) accordingly.

## PRs

- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`) are appreciated but not enforced.
- Keep PRs narrow — one concern per PR. Refactors separate from features.
- Include before/after screenshots for any UI change.
- If you add a new env var, document it in both `.env.example` files and [`docs/BYO-KEYS.md`](docs/BYO-KEYS.md).

## Reporting bugs

Use the issue template. Include:
- What you ran (`docker compose` vs local).
- Output of `/status` (green/red per var).
- Browser + OS.
- Backend logs (`docker compose logs backend --tail 100`).

## Security

See [`SECURITY.md`](SECURITY.md). Don't open a public issue for anything that could expose a user's keys.
