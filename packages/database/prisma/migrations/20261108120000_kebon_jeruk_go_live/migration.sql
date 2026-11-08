-- Kebon Jeruk go-live (docs/PRD-kebon-jeruk-go-live.md). Everything here is
-- additive except invoice_number_counters, whose rows move into
-- document_number_counters (kind INVOICE, scope "YYYY-MM") before it is dropped.

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('CONTRACT', 'INVOICE', 'CREDIT_NOTE');

-- AlterEnum
ALTER TYPE "KycStatus" ADD VALUE 'VERIFIED_LEGACY';

-- AlterEnum
ALTER TYPE "LedgerAccount" ADD VALUE 'PREPAID_TAX_PPH';
ALTER TYPE "LedgerAccount" ADD VALUE 'OPENING_BALANCE';

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "zone" TEXT;

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "legacy_booking_number" TEXT,
ADD COLUMN     "paid_through" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "confirmed_at" TIMESTAMP(3),
ADD COLUMN     "confirmed_by_user_id" UUID,
ADD COLUMN     "contract_number" TEXT,
ADD COLUMN     "signature_image_key" TEXT,
ADD COLUMN     "signature_ip" TEXT,
ADD COLUMN     "signature_user_agent" TEXT,
ADD COLUMN     "terms_version" INTEGER;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "address" TEXT,
ADD COLUMN     "customer_number" INTEGER,
ADD COLUMN     "pph_type" TEXT;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "messaging_paused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "messaging_paused_at" TIMESTAMP(3),
ADD COLUMN     "messaging_paused_by_user_id" UUID,
ADD COLUMN     "messaging_paused_reason" TEXT,
ADD COLUMN     "tax_config" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "address" JSONB,
ADD COLUMN     "bank_accounts" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "branch_code" TEXT,
ADD COLUMN     "contact" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "facilities" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "numbering" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "operating_hours" JSONB NOT NULL DEFAULT '{}';


-- CreateTable
CREATE TABLE "document_number_counters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "scope" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "document_number_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_number_counters" (
    "organization_id" UUID NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "customer_number_counters_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "contract_terms" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messaging_contact_state" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "last_auto_reply_at" TIMESTAMP(3),
    "last_human_reply_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messaging_contact_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_password_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_password_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_number_counters_tenant_id_idx" ON "document_number_counters"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_number_counters_tenant_id_kind_scope_key" ON "document_number_counters"("tenant_id", "kind", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "contract_terms_organization_id_version_key" ON "contract_terms"("organization_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "messaging_contact_state_organization_id_phone_key" ON "messaging_contact_state"("organization_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "user_password_tokens_token_hash_key" ON "user_password_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "user_password_tokens_user_id_idx" ON "user_password_tokens"("user_id");

-- CreateIndex
CREATE INDEX "assets_tenant_id_zone_idx" ON "assets"("tenant_id", "zone");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_tenant_id_legacy_booking_number_key" ON "bookings"("tenant_id", "legacy_booking_number");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_tenant_id_contract_number_key" ON "contracts"("tenant_id", "contract_number");

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenant_id_customer_number_key" ON "customers"("tenant_id", "customer_number");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_organization_id_branch_code_key" ON "tenants"("organization_id", "branch_code");

-- AddForeignKey
ALTER TABLE "contract_terms" ADD CONSTRAINT "contract_terms_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- §6.2 Invoice counters move into the general document counter table. The
-- old table counted per tenant per month, which is exactly scope "YYYY-MM".
-- ---------------------------------------------------------------------------
INSERT INTO "document_number_counters" (id, tenant_id, kind, scope, value)
SELECT gen_random_uuid(), tenant_id, 'INVOICE', year::text || '-' || lpad(month::text, 2, '0'), counter
FROM "invoice_number_counters"
ON CONFLICT (tenant_id, kind, scope) DO NOTHING;

DROP TABLE "invoice_number_counters";

ALTER TABLE "document_number_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_number_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "document_number_counters"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Organization-level tables sit outside tenant RLS, like `organizations`.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "document_number_counters", "customer_number_counters", "contract_terms",
  "messaging_contact_state", "user_password_tokens"
TO rentos_app;

-- ---------------------------------------------------------------------------
-- §6.2 Customer numbers: unique per organization, assigned on insert from an
-- atomic counter. A trigger rather than application code so that every path
-- that creates a customer (storefront, console, OTP sign-in, importer) gets
-- one. An explicit number (the legacy importer) is kept and the counter moves
-- above it, so the next new customer continues after the highest import.
-- SECURITY DEFINER: the counter and `tenants` are read/written as the owner,
-- independent of the caller's RLS context.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assign_customer_number() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  org uuid;
  n integer;
BEGIN
  SELECT organization_id INTO org FROM tenants WHERE id = NEW.tenant_id;
  IF org IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.customer_number IS NULL THEN
    INSERT INTO customer_number_counters (organization_id, value) VALUES (org, 1)
    ON CONFLICT (organization_id) DO UPDATE SET value = customer_number_counters.value + 1
    RETURNING value INTO n;
    NEW.customer_number := n;
  ELSE
    INSERT INTO customer_number_counters (organization_id, value) VALUES (org, NEW.customer_number)
    ON CONFLICT (organization_id) DO UPDATE SET value = GREATEST(customer_number_counters.value, EXCLUDED.value);
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS customers_assign_number ON "customers";
CREATE TRIGGER customers_assign_number
  BEFORE INSERT OR UPDATE OF customer_number ON "customers"
  FOR EACH ROW EXECUTE FUNCTION assign_customer_number();

-- Backfill existing customers in creation order, per organization.
WITH numbered AS (
  SELECT c.id, t.organization_id,
         row_number() OVER (PARTITION BY t.organization_id ORDER BY c.created_at, c.id) AS n
  FROM customers c JOIN tenants t ON t.id = c.tenant_id
  WHERE c.customer_number IS NULL
)
UPDATE customers c SET customer_number = numbered.n FROM numbered WHERE numbered.id = c.id;

INSERT INTO customer_number_counters (organization_id, value)
SELECT t.organization_id, max(c.customer_number)
FROM customers c JOIN tenants t ON t.id = c.tenant_id
GROUP BY t.organization_id
ON CONFLICT (organization_id) DO UPDATE SET value = GREATEST(customer_number_counters.value, EXCLUDED.value);

-- ---------------------------------------------------------------------------
-- §5.1 The legal entity was seeded wrong. Only touches the seeded placeholder.
-- ---------------------------------------------------------------------------
UPDATE organizations SET legal_name = 'PT Servis Storej Indonesia'
WHERE slug = 'city-storage' AND legal_name = 'PT City Storage Indonesia';
UPDATE tenants SET legal_name = 'PT Servis Storej Indonesia'
WHERE legal_name = 'PT City Storage Indonesia';
