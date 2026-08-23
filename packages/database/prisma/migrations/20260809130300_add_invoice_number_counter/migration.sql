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

-- CreateTable
CREATE TABLE IF NOT EXISTS "invoice_number_counters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_number_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "invoice_number_counters_tenant_id_idx" ON "invoice_number_counters"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_number_counters_tenant_id_year_month_key" ON "invoice_number_counters"("tenant_id", "year", "month");

-- Backfill: seed each tenant/year/month's counter from the count of
-- invoices already created in that period under the old COUNT(*)-based
-- scheme, so the new sequence continues where the old one left off
-- instead of colliding with already-issued invoice numbers the moment
-- this migration lands.
-- Backfill. ON CONFLICT DO NOTHING is what makes this statement idempotent, and
-- it is load-bearing for the same reason the DDL above is guarded: this
-- migration re-runs against databases that already applied it under its old
-- 202607xx name, where these counter rows already exist. Without it the
-- re-run dies with 23505 on invoice_number_counters_tenant_id_year_month_key.
--
-- DO NOTHING rather than DO UPDATE deliberately: an existing row has been in
-- use issuing invoice numbers and its counter is ahead of this COUNT(*).
-- Overwriting it would re-issue numbers that are already on real invoices.
INSERT INTO "invoice_number_counters" (id, tenant_id, year, month, counter)
SELECT gen_random_uuid(), tenant_id, EXTRACT(YEAR FROM created_at)::int, EXTRACT(MONTH FROM created_at)::int, COUNT(*)::int
FROM "invoices"
GROUP BY tenant_id, EXTRACT(YEAR FROM created_at), EXTRACT(MONTH FROM created_at)
ON CONFLICT (tenant_id, year, month) DO NOTHING;

-- Row-Level Security — same shape as every migration since enable_rls:
-- new tables aren't retroactively covered by that migration, so each
-- one repeats ENABLE + FORCE + a tenant_id-matching policy explicitly.
-- See docs/HANDOFF.md Session 24.
ALTER TABLE "invoice_number_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_number_counters" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "invoice_number_counters";
CREATE POLICY tenant_isolation ON "invoice_number_counters"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
