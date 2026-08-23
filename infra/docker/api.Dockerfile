# syntax=docker/dockerfile:1
# RentOS API (apps/api) — NestJS modular monolith.
# Build from the repo root: docker build -f infra/docker/api.Dockerfile .
# Railway: builder = "DOCKERFILE", dockerfilePath = "infra/docker/api.Dockerfile" (see apps/api/railway.toml).

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
# Prisma's query engine needs OpenSSL at runtime; libc6-compat covers native addons built against glibc assumptions.
RUN apk add --no-cache openssl libc6-compat

# ---- Prune: compute the minimal subset of the monorepo apps/api actually needs ----
FROM base AS pruner
WORKDIR /app
COPY . .
RUN pnpm dlx turbo prune @rentos/api --docker

# ---- Install: dependency layer, cacheable independently of source changes ----
FROM base AS installer
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# ---- Build: full pruned source + compile ----
FROM base AS builder
WORKDIR /app
COPY --from=installer /app/ .
COPY --from=pruner /app/out/full/ .
RUN pnpm exec turbo run build --filter=@rentos/api...

# ---- Runtime ----
# Copies the full installed node_modules from `builder` rather than doing a
# second prod-only `pnpm install` — simpler and more robust for a pnpm
# workspace with symlinked local packages, at the cost of shipping
# devDependencies in the runtime image. Tightening this (prod-only
# install + explicit dist-only copy) is a reasonable later optimization,
# tracked in docs/HANDOFF.md, once there's a real build environment to
# validate it against (this sandbox has no Docker registry access — see
# docs/HANDOFF.md "Docker builds could not be verified in-session").
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S rentos && adduser -S rentos -G rentos

COPY --from=builder /app .

# The release step. Runs `prisma migrate deploy` (owner role, DATABASE_URL)
# before starting the API (rentos_app, DATABASE_URL_APP) — see the script for
# why the two roles must stay separate. The runtime image already carries the
# Prisma CLI and prisma/migrations because this stage copies the full installed
# workspace from `builder`, devDependencies included.
COPY --chmod=0755 scripts/start-api.sh /usr/local/bin/start-api.sh

USER rentos
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1

CMD ["/usr/local/bin/start-api.sh"]
