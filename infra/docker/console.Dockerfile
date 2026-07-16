# syntax=docker/dockerfile:1
# RentOS Console (apps/console) — internal admin Next.js app.
# Build from the repo root: docker build -f infra/docker/console.Dockerfile .
# Railway: builder = "DOCKERFILE", dockerfilePath = "infra/docker/console.Dockerfile" (see apps/console/railway.toml).
#
# NEXT_PUBLIC_* vars are inlined into the client bundle at BUILD time — set
# them as build-time variables on this Railway service, not just runtime env.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

FROM base AS pruner
WORKDIR /app
COPY . .
RUN pnpm dlx turbo prune @rentos/console --docker

FROM base AS installer
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_TENANT_SLUG
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_TENANT_SLUG=$NEXT_PUBLIC_TENANT_SLUG
COPY --from=installer /app/ .
COPY --from=pruner /app/out/full/ .
RUN pnpm exec turbo run build --filter=@rentos/console...

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S rentos && adduser -S rentos -G rentos

COPY --from=builder /app/apps/console/public ./apps/console/public
COPY --from=builder --chown=rentos:rentos /app/apps/console/.next/standalone ./
COPY --from=builder --chown=rentos:rentos /app/apps/console/.next/static ./apps/console/.next/static

USER rentos
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ || exit 1

CMD ["node", "apps/console/server.js"]
