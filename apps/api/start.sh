#!/bin/sh
# Release step for apps/api: bring the schema up to date, then start the API.
#
# Lives in scripts/, not infra/docker/, because it is NOT Docker-specific. The
# Railway services are built with RAILPACK and started from a dashboard Start
# Command, which overrides the Dockerfile CMD — so a release step that only
# existed in the Dockerfile would silently never run (it didn't: deploy
# d6011038 on 2026-08-23 started Nest directly and left the schema untouched).
# Point the service's Start Command at this script and it runs under either
# builder:  sh scripts/start-api.sh
#
# Why this exists: until now nothing applied migrations in production. The
# repo's only migrate path was `pnpm db:migrate`, run by hand, so the schema
# and the deployed code drifted apart silently — on 2026-08-23 the API shipped
# C1-era code (which selects tenants.organization_id) against a database still
# on the pre-C1 schema from July. Every tenant lookup threw, TenantMiddleware
# 400'd every request, and the API's own healthcheck stayed green because
# /api/health never touches the database. Making the release step part of the
# container's start-up is what makes that class of drift impossible.
#
# Role separation is deliberate and must not be collapsed (see
# packages/database/src/client.ts and the enable_rls migration):
#   DATABASE_URL      — the OWNING role. DDL rights. Used here, for migrations.
#   DATABASE_URL_APP  — rentos_app: NOBYPASSRLS, no ownership. Used by the
#                       running API, so every query is subject to RLS.
# Prisma reads DATABASE_URL from the datasource block, so migrate deploy picks
# up the owner automatically and the app process keeps using DATABASE_URL_APP.
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "[entrypoint] DATABASE_URL is not set — refusing to start."
  echo "[entrypoint] Migrations need the OWNING role; DATABASE_URL_APP (rentos_app)"
  echo "[entrypoint] is NOBYPASSRLS and cannot run DDL. Set DATABASE_URL to the"
  echo "[entrypoint] Postgres owner connection string (Railway: \${{Postgres.DATABASE_URL}})."
  exit 1
fi

# Recovery hatch for a migration left in the FAILED state.
#
# When a migration errors part-way, Prisma records it as failed and every later
# `migrate deploy` aborts with P3009 rather than retrying — deliberately, since
# blindly re-running a half-applied migration can corrupt data. Clearing that
# marker is a one-off human decision, so it is an explicit env var rather than
# anything automatic.
#
# ONLY safe when the named migration is idempotent (all the 20260809130* ones
# are — see their headers) or you have confirmed it left nothing behind.
# `--rolled-back` tells Prisma the migration did not take effect, so it is
# retried on this same run. Set it for one deploy, then remove it.
if [ -n "$RESOLVE_ROLLED_BACK" ]; then
  echo "[entrypoint] Marking '$RESOLVE_ROLLED_BACK' as rolled back so it can be retried…"
  pnpm --filter @rentos/database exec prisma migrate resolve --rolled-back "$RESOLVE_ROLLED_BACK"
  echo "[entrypoint] Resolved. Remove RESOLVE_ROLLED_BACK now."
fi

echo "[entrypoint] Applying database migrations…"
# Not backgrounded and not tolerated on failure: a half-migrated schema serving
# traffic is worse than a failed deploy. Railway keeps the previous deployment
# live when the new one never becomes healthy.
pnpm --filter @rentos/database exec prisma migrate deploy
echo "[entrypoint] Migrations applied."

# One-shot demo seeding. Off unless explicitly set, because the seed upserts
# demo tenants/users and would otherwise re-assert them on every boot. It IS
# idempotent, so an accidental extra run is not destructive — but leave it set
# and you will keep resurrecting demo rows in a real environment. Set it for a
# single deploy, then remove it.
if [ "$SEED_ON_DEPLOY" = "true" ]; then
  echo "[entrypoint] SEED_ON_DEPLOY=true — seeding demo data…"
  pnpm --filter @rentos/database seed
  echo "[entrypoint] Seed complete. Remove SEED_ON_DEPLOY now."
fi

echo "[entrypoint] Starting API…"
exec node apps/api/dist/main.js
