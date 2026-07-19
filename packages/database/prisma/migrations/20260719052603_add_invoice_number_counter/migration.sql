-- CreateTable
CREATE TABLE "invoice_number_counters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_number_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_number_counters_tenant_id_idx" ON "invoice_number_counters"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_number_counters_tenant_id_year_month_key" ON "invoice_number_counters"("tenant_id", "year", "month");

-- Backfill: seed each tenant/year/month's counter from the count of
-- invoices already created in that period under the old COUNT(*)-based
-- scheme, so the new sequence continues where the old one left off
-- instead of colliding with already-issued invoice numbers the moment
-- this migration lands.
INSERT INTO "invoice_number_counters" (id, tenant_id, year, month, counter)
SELECT gen_random_uuid(), tenant_id, EXTRACT(YEAR FROM created_at)::int, EXTRACT(MONTH FROM created_at)::int, COUNT(*)::int
FROM "invoices"
GROUP BY tenant_id, EXTRACT(YEAR FROM created_at), EXTRACT(MONTH FROM created_at);

-- Row-Level Security — same shape as every migration since enable_rls:
-- new tables aren't retroactively covered by that migration, so each
-- one repeats ENABLE + FORCE + a tenant_id-matching policy explicitly.
-- See docs/HANDOFF.md Session 24.
ALTER TABLE "invoice_number_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_number_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invoice_number_counters"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
