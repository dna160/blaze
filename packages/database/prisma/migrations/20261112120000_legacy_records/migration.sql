-- Owner 2026-11-12: keep everything the legacy system (Booqable) holds, as it
-- made it, in a read-only archive. Nothing here feeds the ledger or any job.
-- CreateTable
CREATE TABLE "legacy_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "legacy_id" TEXT NOT NULL,
    "number" TEXT,
    "customer_id" UUID,
    "customer_number" INTEGER,
    "customer_name" TEXT,
    "occurred_at" TIMESTAMP(3),
    "amount" DECIMAL(14,2),
    "status" TEXT,
    "title" TEXT,
    "data" JSONB NOT NULL,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legacy_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "legacy_records_tenant_id_kind_occurred_at_idx" ON "legacy_records"("tenant_id", "kind", "occurred_at");

-- CreateIndex
CREATE INDEX "legacy_records_tenant_id_customer_number_idx" ON "legacy_records"("tenant_id", "customer_number");

-- CreateIndex
CREATE UNIQUE INDEX "legacy_records_tenant_id_source_kind_legacy_id_key" ON "legacy_records"("tenant_id", "source", "kind", "legacy_id");


GRANT SELECT, INSERT, UPDATE, DELETE ON "legacy_records" TO rentos_app;
ALTER TABLE "legacy_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legacy_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "legacy_records"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY org_read ON "legacy_records" FOR SELECT
  USING (tenant_id IN (SELECT id FROM tenants WHERE organization_id = nullif(current_setting('app.organization_id', true), '')::uuid));
