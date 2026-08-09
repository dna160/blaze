-- BUILD-SPEC v2.0 schema renewal (R0 + R1 + R2 structural delta).
-- Corrections realized here: C1 (Organization above Tenant), C2 (role x scope),
-- C4 (RentalOrder + renewal chain), C5 (WaitlistEntry), §5 (MasterAgreement +
-- OrderAcceptance). RLS for the new tenant-scoped tables and the org-read scope
-- live in the sibling migration 20260809120100_rls_new_tables_and_org_read.
--
-- NOTE on the `tenants.organization_id` backfill below: the naive
-- `ADD COLUMN organization_id UUID NOT NULL` fails on a table that already has
-- rows. We add it nullable, backfill exactly one Organization per existing
-- Tenant (faithful to BUILD-SPEC C1's "backfill one org, keep every RLS policy
-- valid throughout"), then set NOT NULL. On a fresh DB the backfill is a no-op.

-- CreateEnum
CREATE TYPE "BaseRole" AS ENUM ('ADMIN', 'FINANCE', 'SUPERVISOR', 'STAFF');

-- CreateEnum
CREATE TYPE "RoleScope" AS ENUM ('ORGANIZATION', 'TENANT');

-- CreateEnum
CREATE TYPE "RentalOrderStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'AWAITING_PAYMENT', 'ACTIVE', 'RENEWAL_OFFERED', 'RENEWAL_CONFIRMED', 'RENEWAL_DECLINED', 'EXPIRING', 'COMPLETED', 'DEFAULTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('ARMED', 'FIRED', 'EXPIRED', 'CONVERTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('INDIVIDUAL', 'BUSINESS');

-- CreateEnum
CREATE TYPE "MasterAgreementStatus" AS ENUM ('DRAFT', 'SENT', 'SIGNED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OrderAcceptanceMethod" AS ENUM ('OTP', 'CLICK');

-- DropForeignKey
ALTER TABLE "assets" DROP CONSTRAINT "assets_location_id_fkey";

-- DropIndex
DROP INDEX "assets_tenant_id_location_id_code_key";

-- DropIndex
DROP INDEX "user_roles_user_id_role_key";

-- AlterTable
ALTER TABLE "assets" ALTER COLUMN "location_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "rental_order_id" UUID,
ALTER COLUMN "booking_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "company_name" TEXT,
ADD COLUMN     "tax_id" TEXT,
ADD COLUMN     "type" "CustomerType" NOT NULL DEFAULT 'INDIVIDUAL';

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "rental_order_id" UUID,
ADD COLUMN     "void_reason" TEXT,
ADD COLUMN     "voided_by_user_id" UUID;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "recipient_role" TEXT NOT NULL DEFAULT 'CUSTOMER';

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "messaging_config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- AlterTable: add organization_id nullable first, then backfill, then enforce.
ALTER TABLE "tenants" ADD COLUMN "organization_id" UUID;

-- Backfill: one Organization per pre-existing Tenant (C1). No-op on a fresh DB.
DO $$
DECLARE
  r RECORD;
  new_org_id UUID;
BEGIN
  FOR r IN SELECT id, name, slug FROM "tenants" WHERE "organization_id" IS NULL LOOP
    new_org_id := gen_random_uuid();
    INSERT INTO "organizations" ("id", "slug", "name", "created_at", "updated_at")
    VALUES (new_org_id, r.slug || '-org', r.name, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    UPDATE "tenants" SET "organization_id" = new_org_id WHERE id = r.id;
  END LOOP;
END
$$;

ALTER TABLE "tenants" ALTER COLUMN "organization_id" SET NOT NULL;

-- AlterTable: user_roles gains scope + tenant_ids; role becomes BaseRole.
-- The old GlobalRole `role` column is dropped and re-added as BaseRole. Any
-- pre-existing rows lose their role value (there is no lossless GlobalRole ->
-- BaseRole mapping); seed re-provisions roles. On a fresh DB this is a no-op.
ALTER TABLE "user_roles" ADD COLUMN     "scope" "RoleScope" NOT NULL DEFAULT 'TENANT',
ADD COLUMN     "tenant_ids" UUID[] DEFAULT ARRAY[]::UUID[],
DROP COLUMN "role",
ADD COLUMN     "role" "BaseRole" NOT NULL;

-- DropEnum
DROP TYPE "GlobalRole";

-- CreateTable
CREATE TABLE "customer_phones" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_phones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_agreements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "template_version" TEXT NOT NULL,
    "status" "MasterAgreementStatus" NOT NULL DEFAULT 'DRAFT',
    "document_url" TEXT,
    "esign_provider" TEXT,
    "esign_envelope_id" TEXT,
    "signed_at" TIMESTAMP(3),
    "signed_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "master_agreement_id" UUID,
    "customer_id" UUID NOT NULL,
    "asset_type_id" UUID NOT NULL,
    "asset_id" UUID,
    "status" "RentalOrderStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "price_snapshot" JSONB NOT NULL,
    "previous_order_id" UUID,
    "renewal_offered_at" TIMESTAMP(3),
    "renewal_responded_at" TIMESTAMP(3),
    "reserved_until" TIMESTAMP(3),
    "approved_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rental_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_order_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rental_order_id" UUID NOT NULL,
    "from_status" "RentalOrderStatus",
    "to_status" "RentalOrderStatus" NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rental_order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_acceptances" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rental_order_id" UUID NOT NULL,
    "method" "OrderAcceptanceMethod" NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "otp_challenge_id" TEXT,
    "proof" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "asset_type_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'ARMED',
    "kyc_verified" BOOLEAN NOT NULL DEFAULT false,
    "price_snapshot" JSONB NOT NULL,
    "fired_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "fired_rental_order_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "customer_phones_tenant_id_idx" ON "customer_phones"("tenant_id");

-- CreateIndex
CREATE INDEX "customer_phones_customer_id_idx" ON "customer_phones"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_phones_tenant_id_phone_key" ON "customer_phones"("tenant_id", "phone");

-- CreateIndex
CREATE INDEX "master_agreements_tenant_id_idx" ON "master_agreements"("tenant_id");

-- CreateIndex
CREATE INDEX "master_agreements_organization_id_idx" ON "master_agreements"("organization_id");

-- CreateIndex
CREATE INDEX "master_agreements_customer_id_idx" ON "master_agreements"("customer_id");

-- CreateIndex
CREATE INDEX "rental_orders_tenant_id_idx" ON "rental_orders"("tenant_id");

-- CreateIndex
CREATE INDEX "rental_orders_tenant_id_status_idx" ON "rental_orders"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "rental_orders_customer_id_idx" ON "rental_orders"("customer_id");

-- CreateIndex
CREATE INDEX "rental_orders_asset_id_idx" ON "rental_orders"("asset_id");

-- CreateIndex
CREATE INDEX "rental_orders_previous_order_id_idx" ON "rental_orders"("previous_order_id");

-- CreateIndex
CREATE INDEX "rental_order_events_tenant_id_idx" ON "rental_order_events"("tenant_id");

-- CreateIndex
CREATE INDEX "rental_order_events_rental_order_id_idx" ON "rental_order_events"("rental_order_id");

-- CreateIndex
CREATE INDEX "order_acceptances_tenant_id_idx" ON "order_acceptances"("tenant_id");

-- CreateIndex
CREATE INDEX "order_acceptances_rental_order_id_idx" ON "order_acceptances"("rental_order_id");

-- CreateIndex
CREATE INDEX "waitlist_entries_tenant_id_idx" ON "waitlist_entries"("tenant_id");

-- CreateIndex
CREATE INDEX "waitlist_entries_tenant_id_asset_type_id_status_idx" ON "waitlist_entries"("tenant_id", "asset_type_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_entries_tenant_id_asset_type_id_position_key" ON "waitlist_entries"("tenant_id", "asset_type_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "assets_tenant_id_code_key" ON "assets"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "contracts_rental_order_id_idx" ON "contracts"("rental_order_id");

-- CreateIndex
CREATE INDEX "invoices_rental_order_id_idx" ON "invoices"("rental_order_id");

-- CreateIndex
CREATE INDEX "tenants_organization_id_idx" ON "tenants"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_user_id_role_scope_key" ON "user_roles"("user_id", "role", "scope");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_phones" ADD CONSTRAINT "customer_phones_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_phones" ADD CONSTRAINT "customer_phones_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_agreements" ADD CONSTRAINT "master_agreements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_agreements" ADD CONSTRAINT "master_agreements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_agreements" ADD CONSTRAINT "master_agreements_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_orders" ADD CONSTRAINT "rental_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_orders" ADD CONSTRAINT "rental_orders_master_agreement_id_fkey" FOREIGN KEY ("master_agreement_id") REFERENCES "master_agreements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_orders" ADD CONSTRAINT "rental_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_orders" ADD CONSTRAINT "rental_orders_asset_type_id_fkey" FOREIGN KEY ("asset_type_id") REFERENCES "asset_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_orders" ADD CONSTRAINT "rental_orders_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_orders" ADD CONSTRAINT "rental_orders_previous_order_id_fkey" FOREIGN KEY ("previous_order_id") REFERENCES "rental_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_order_events" ADD CONSTRAINT "rental_order_events_rental_order_id_fkey" FOREIGN KEY ("rental_order_id") REFERENCES "rental_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_acceptances" ADD CONSTRAINT "order_acceptances_rental_order_id_fkey" FOREIGN KEY ("rental_order_id") REFERENCES "rental_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_asset_type_id_fkey" FOREIGN KEY ("asset_type_id") REFERENCES "asset_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_fired_rental_order_id_fkey" FOREIGN KEY ("fired_rental_order_id") REFERENCES "rental_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_rental_order_id_fkey" FOREIGN KEY ("rental_order_id") REFERENCES "rental_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_rental_order_id_fkey" FOREIGN KEY ("rental_order_id") REFERENCES "rental_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
