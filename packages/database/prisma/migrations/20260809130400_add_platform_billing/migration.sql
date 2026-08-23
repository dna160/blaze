-- IDEMPOTENT. This migration was originally named with a 202607xx timestamp and
-- was applied to at least one live database under that name (production, hand-
-- migrated in July when Phase 4 was verified). It was later re-timestamped to
-- sort AFTER 20260809120200_harden_tenant_isolation_nullctx, because that
-- migration rewrites every tenant_isolation policy and would otherwise strip the
-- platform-admin branch this set adds to `users`.
--
-- Renaming makes Prisma treat it as brand new, so it re-runs against databases
-- that already have these objects — which is exactly what happened on
-- 2026-08-23: `Database error code 42710` (duplicate_object), and P3009 blocking
-- every later migration. Every statement below is therefore guarded so that
-- re-running is a no-op. Do not add an unguarded CREATE to this file.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "BillingPlan" AS ENUM ('TRIAL', 'STARTER', 'GROWTH', 'SCALE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PlatformInvoiceStatus" AS ENUM ('ISSUED', 'PAID');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "billing_plan" "BillingPlan" NOT NULL DEFAULT 'TRIAL';

-- CreateTable
CREATE TABLE IF NOT EXISTS "platform_invoices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "billing_plan" "BillingPlan" NOT NULL,
    "period_year" INTEGER NOT NULL,
    "period_month" INTEGER NOT NULL,
    "included_assets" INTEGER NOT NULL,
    "actual_asset_count" INTEGER NOT NULL,
    "plan_amount" DECIMAL(14,2) NOT NULL,
    "overage_amount" DECIMAL(14,2) NOT NULL,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "status" "PlatformInvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "platform_invoices_tenant_id_idx" ON "platform_invoices"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "platform_invoices_tenant_id_period_year_period_month_key" ON "platform_invoices"("tenant_id", "period_year", "period_month");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Row-Level Security — same shape as every migration since enable_rls:
-- new tables aren't retroactively covered by that migration, so each one
-- repeats ENABLE + FORCE + a tenant_id-matching policy explicitly.
-- platform_invoices is tenant-scoped exactly like every other billing
-- record (RentOS's AR against the tenant, not the tenant's own AR), so
-- the standard policy shape applies unchanged.
ALTER TABLE "platform_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_invoices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "platform_invoices";
CREATE POLICY tenant_isolation ON "platform_invoices"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Session 26 — the dedicated platform-admin path the original enable_rls
-- migration's own comment flagged as future work: "rows with a NULL
-- tenant_id (platform-admin scope) are only reachable via the
-- owning/migrator role until a dedicated platform-admin path ships
-- (tracked in docs/HANDOFF.md, PRD Phase 4 territory)."
--
-- `rentos_app` (the running services' role, NOBYPASSRLS) still cannot see
-- ANY row via its normal per-tenant policy when app.tenant_id isn't set to
-- a real tenant UUID — that fail-closed behavior is exactly what makes
-- RLS trustworthy here and must not change for tenant-scoped rows. What
-- this adds is a second, narrow OR-branch: a NULL-tenant_id row (a
-- platform-admin User, see User.tenantId's doc comment) becomes visible
-- ONLY when a new session var, app.platform_admin, is explicitly set to
-- 'true' — which only packages/database/src/platform-context.ts's
-- withPlatformContext() ever does, for the one purpose of looking up a
-- platform-admin User at login time. A request that never calls
-- withPlatformContext never sets this var, so current_setting(...) stays
-- NULL and the OR-branch stays false — same fail-closed default as
-- app.tenant_id already has. This does NOT touch any other RLS-covered
-- table; automation_settings, audit_log, webhook_events (the other
-- nullable-tenant_id tables the original comment mentions) keep their
-- unmodified per-tenant-only policy, since nothing about this session's
-- work needs a platform-admin to read cross-tenant rows on those tables.
--
-- Ordering note: this migration is timestamped AFTER
-- 20260809120200_harden_tenant_isolation_nullctx deliberately. That migration
-- loops over every table carrying a `tenant_isolation` policy and rewrites it
-- to the plain per-tenant form, so if this one ran first the platform-admin
-- OR-branch below would be silently stripped and withPlatformContext() would
-- return zero rows — breaking platform login, tenant onboarding and platform
-- billing with no migration error to show for it.
--
-- The tenant_id comparison below therefore also carries that migration's
-- nullif(..., '') guard: a placeholder GUC reverts to the EMPTY STRING rather
-- than NULL on a pooled connection that has ever set it, and ''::uuid raises
-- instead of matching nothing. nullif keeps unset and reverted both NULL, so
-- forgetting tenant scope stays structurally a zero-rows result.
DROP POLICY IF EXISTS tenant_isolation ON "users";
DROP POLICY IF EXISTS tenant_isolation ON "users";
CREATE POLICY tenant_isolation ON "users"
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR (tenant_id IS NULL AND current_setting('app.platform_admin', true) = 'true')
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR (tenant_id IS NULL AND current_setting('app.platform_admin', true) = 'true')
  );
