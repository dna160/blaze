# syntax=docker/dockerfile:1
# RentOS Worker (apps/worker) — BullMQ processors: invoice generation, dunning ladder.
# Build from the repo root: docker build -f infra/docker/worker.Dockerfile .
# Railway: builder = "DOCKERFILE", dockerfilePath = "infra/docker/worker.Dockerfile" (see apps/worker/railway.toml).

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN apk add --no-cache openssl libc6-compat

FROM base AS pruner
WORKDIR /app
COPY . .
RUN pnpm dlx turbo prune @rentos/worker --docker

FROM base AS installer
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=installer /app/ .
COPY --from=pruner /app/out/full/ .
RUN pnpm exec turbo run build --filter=@rentos/worker...

# See infra/docker/api.Dockerfile for the rationale on copying the full
# installed node_modules here rather than a second prod-only install.
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S rentos && adduser -S rentos -G rentos

COPY --from=builder /app .

USER rentos
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4100/ || exit 1

CMD ["node", "apps/worker/dist/main.js"]
