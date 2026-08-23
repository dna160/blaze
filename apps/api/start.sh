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

# Migrations, with a bounded recovery for one specific, verified-safe failure.
#
# Normal path: `migrate deploy` succeeds and nothing below runs.
#
# Recovery path: when a migration errors part-way Prisma marks it failed, and
# every later deploy aborts with P3009 instead of retrying. That default is
# right — blindly re-running a half-applied migration corrupts data. But the
# 20260809130* migrations are written to be idempotent (see the header on each):
# they were re-timestamped from 202607xx, so Prisma re-runs them against
# databases that already applied them under the old names, and every statement
# is guarded so that re-running is a no-op.
#
# So if the first attempt fails, clear ONLY those and try exactly once more.
# No parsing of Prisma's output: an earlier version scraped the failed
# migration's name out of `migrate status`, which broke silently in the
# container and left no trace of why. Acting on the allowlist directly has no
# such failure mode. `|| true` because resolving a migration that is not in a
# failed state is an expected no-op here, not an error.
IDEMPOTENT_MIGRATIONS="
20260809130000_add_tenant_api_webhooks
20260809130100_add_kyc_auto_verification
20260809130200_add_ota_calendar_sync
20260809130300_add_invoice_number_counter
20260809130400_add_platform_billing
20260809130500_add_rate_tier
"

migrate() {
  pnpm --filter @rentos/database exec prisma migrate deploy
}

# Manual override for a migration outside the safe set. One-shot: remove it once
# the deploy is green.
if [ -n "$RESOLVE_ROLLED_BACK" ]; then
  echo "[entrypoint] Marking '$RESOLVE_ROLLED_BACK' as rolled back so it can be retried…"
  pnpm --filter @rentos/database exec prisma migrate resolve --rolled-back "$RESOLVE_ROLLED_BACK" || true
  echo "[entrypoint] Resolved. Remove RESOLVE_ROLLED_BACK now."
fi

echo "[entrypoint] Applying database migrations…"
if migrate; then
  echo "[entrypoint] Migrations applied."
else
  echo "[entrypoint] migrate deploy failed. Current migration state:"
  # Diagnostic, always printed, stdout AND stderr — Prisma reports failed
  # migrations on stderr, which is easy to discard by accident.
  pnpm --filter @rentos/database exec prisma migrate status 2>&1 || true

  echo "[entrypoint] Clearing any failed marker on the known-idempotent migrations…"
  for m in $IDEMPOTENT_MIGRATIONS; do
    pnpm --filter @rentos/database exec prisma migrate resolve --rolled-back "$m" 2>/dev/null \
      && echo "[entrypoint]   cleared $m" \
      || true
  done

  echo "[entrypoint] Retrying migrations once…"
  if migrate; then
    echo "[entrypoint] Migrations applied on retry."
  else
    echo "[entrypoint] Migrations still failing after recovery. Not starting the API —"
    echo "[entrypoint] a server on a half-migrated schema is worse than a failed deploy."
    echo "[entrypoint] Inspect the status output above; set RESOLVE_ROLLED_BACK to retry a"
    echo "[entrypoint] specific migration, or mark one applied with:"
    echo "[entrypoint]   prisma migrate resolve --applied \"<migration_name>\""
    exit 1
  fi
fi

# One-shot demo seeding. Off unless explicitly set, because the seed upserts
# demo tenants/users and would otherwise re-assert them on every boot. It IS
# idempotent, so an accidental extra run is not destructive — but leave it set
# and you will keep resurrecting demo rows in a real environment. Set it for a
# single deploy, then remove it.
# Accept the obvious truthy spellings. An earlier version tested for exactly
# "true", so SEED_ON_DEPLOY=1 (or TRUE, or yes) silently did nothing and the
# deploy came up with no seeded users at all — a env-var typo should not be
# indistinguishable from "seeding is off".
case "$(printf '%s' "${SEED_ON_DEPLOY:-}" | tr '[:upper:]' '[:lower:]')" in
  true|1|yes|y|on) SHOULD_SEED=yes ;;
  ""|false|0|no|n|off) SHOULD_SEED=no ;;
  *) echo "[entrypoint] SEED_ON_DEPLOY='$SEED_ON_DEPLOY' not understood — treating as off."; SHOULD_SEED=no ;;
esac

if [ "$SHOULD_SEED" = "yes" ]; then
  echo "[entrypoint] SEED_ON_DEPLOY=$SEED_ON_DEPLOY — seeding demo data…"
  pnpm --filter @rentos/database seed
  echo "[entrypoint] Seed complete. Remove SEED_ON_DEPLOY now."
fi

# One-shot admin bootstrap. The C1 migration deletes every user_roles row, so a
# pre-existing tenant is left with staff who can authenticate but hold no
# capabilities — and no way back in through the UI, since granting a role is
# itself a manage_users action. This is the bootstrap path.
#
# PROMOTE_ADMIN_EMAIL=you@example.com
# PROMOTE_ADMIN_TENANT=<slug>       (required when more than one tenant exists)
# PROMOTE_ADMIN_PASSWORD=<password> (optional; sets/resets it, required to create)
#
# Remove these once you are in. Left set, it re-asserts the grant every boot —
# harmless but it means the account cannot be demoted from the console.
if [ -n "$PROMOTE_ADMIN_EMAIL" ]; then
  echo "[entrypoint] Promoting $PROMOTE_ADMIN_EMAIL to ADMIN x ORGANIZATION…"
  # Never fatal. This is an operator convenience; a bad tenant slug or a missing
  # password should print why and leave the API running, not take the service
  # down. The script itself refuses to guess between tenants and lists the real
  # slugs, so the log tells you what to set next.
  if pnpm --filter @rentos/database promote-admin; then
    echo "[entrypoint] Done. Remove PROMOTE_ADMIN_* now."
  else
    echo "[entrypoint] Promotion did NOT happen (see the error above). Starting the API anyway."
  fi
fi

echo "[entrypoint] Starting API…"
exec node apps/api/dist/main.js
