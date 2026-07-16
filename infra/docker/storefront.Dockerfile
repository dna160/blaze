# syntax=docker/dockerfile:1
# RentOS Storefront (apps/storefront) — customer-facing Next.js app.
# Build from the repo root: docker build -f infra/docker/storefront.Dockerfile .
# Railway: builder = "DOCKERFILE", dockerfilePath = "infra/docker/storefront.Dockerfile" (see apps/storefront/railway.toml).
#
# NEXT_PUBLIC_* vars are inlined into the client bundle at BUILD time, not
# read at runtime — they must be passed as --build-arg (Railway: set them
# as build-time variables on this service, not just runtime env vars).

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

FROM base AS pruner
WORKDIR /app
COPY . .
RUN pnpm dlx turbo prune @rentos/storefront --docker

FROM base AS installer
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_DEV_TENANT_SLUG
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_DEV_TENANT_SLUG=$NEXT_PUBLIC_DEV_TENANT_SLUG
COPY --from=installer /app/ .
COPY --from=pruner /app/out/full/ .
RUN pnpm exec turbo run build --filter=@rentos/storefront...

# ---- Runtime: Next.js standalone output — a minimal traced server + only the node_modules it needs ----
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S rentos && adduser -S rentos -G rentos

COPY --from=builder /app/apps/storefront/public ./apps/storefront/public
COPY --from=builder --chown=rentos:rentos /app/apps/storefront/.next/standalone ./
COPY --from=builder --chown=rentos:rentos /app/apps/storefront/.next/static ./apps/storefront/.next/static

USER rentos
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ || exit 1

CMD ["node", "apps/storefront/server.js"]
