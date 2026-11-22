-- PRD go-live 2 P1 set.

-- §7.2 customer merge: the duplicate's number becomes an alias of the survivor.
CREATE TABLE "customer_number_aliases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "alias_number" INTEGER NOT NULL,
    "merged_from_customer_id" UUID,
    "merged_from_name" TEXT,
    "merged_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_number_aliases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "customer_number_aliases_tenant_id_alias_number_key" ON "customer_number_aliases"("tenant_id", "alias_number");
CREATE INDEX "customer_number_aliases_customer_id_idx" ON "customer_number_aliases"("customer_id");
ALTER TABLE "customer_number_aliases" ADD CONSTRAINT "customer_number_aliases_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_number_aliases" TO rentos_app;
ALTER TABLE "customer_number_aliases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_number_aliases" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_number_aliases"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY org_read ON "customer_number_aliases" FOR SELECT
  USING (tenant_id IN (SELECT id FROM tenants WHERE organization_id = nullif(current_setting('app.organization_id', true), '')::uuid));

-- §10.3 deposit refund task: raised once when refund_due_at passes while the deposit is held.
ALTER TABLE "deposits" ADD COLUMN "refund_task_raised_at" TIMESTAMP(3);

-- §10.1 PPh net settlement: the withheld part of a payment, its bukti potong, and how much of an invoice is settled.
ALTER TABLE "payments" ADD COLUMN "pph_withheld_amount" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "payments" ADD COLUMN "bukti_potong_key" TEXT;
ALTER TABLE "payments" ADD COLUMN "bukti_potong_at" TIMESTAMP(3);
ALTER TABLE "invoices" ADD COLUMN "settled_amount" DECIMAL(14,2) NOT NULL DEFAULT 0;
-- A PAID invoice was settled in full; a partly refunded / credited one too (its refund is separate).
UPDATE "invoices" SET "settled_amount" = "total_amount" WHERE "status" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED');
