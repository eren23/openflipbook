FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
ENV CI=1

FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/config/package.json ./packages/config/
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
# Client flags are inlined at BUILD time (NEXT_PUBLIC_*): without these args
# the image silently ships the flag-off bundle — demo-stack sessions seeded
# world mode OFF while local dev (.env.local) had it on.
ARG NEXT_PUBLIC_WORLD_MODE
ARG NEXT_PUBLIC_DOM_LABELS
ARG NEXT_PUBLIC_ON_RAMP_COACH
ARG NEXT_PUBLIC_ENTER_COACH
ARG NEXT_PUBLIC_BENCH_UI
ENV NEXT_PUBLIC_WORLD_MODE=$NEXT_PUBLIC_WORLD_MODE \
    NEXT_PUBLIC_DOM_LABELS=$NEXT_PUBLIC_DOM_LABELS \
    NEXT_PUBLIC_ON_RAMP_COACH=$NEXT_PUBLIC_ON_RAMP_COACH \
    NEXT_PUBLIC_ENTER_COACH=$NEXT_PUBLIC_ENTER_COACH \
    NEXT_PUBLIC_BENCH_UI=$NEXT_PUBLIC_BENCH_UI
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/config ./packages/config
COPY apps/web ./apps/web
RUN pnpm --filter @openflipbook/web build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
