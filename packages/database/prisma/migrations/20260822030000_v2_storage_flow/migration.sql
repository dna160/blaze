-- PRD v2 (docs/PRD-v2-storage-flow.md): self-storage booking flow, approval
-- pipeline, waitlist, magic links, Google/email customers, term payment
-- schedules. Hand-written (the sandbox that built this could not reach
-- Prisma's schema-engine binary) but follows `prisma migrate` conventions
-- exactly, so a later real `prisma migrate deploy` sees nothing to do.

-- AlterEnum
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'WAITLISTED';

-- CreateEnum
CREATE TYPE "CustomerChannel" AS ENUM ('WHATSAPP', 'EMAIL');

-- AlterTable: locations — map coordinates
ALTER TABLE "locations" ADD COLUMN "latitude" DOUBLE PRECISION,
                        ADD COLUMN "longitude" DOUBLE PRECISION;

-- AlterTable: customers — nullable phone, preferred channel, Clerk link, email uniqueness
ALTER TABLE "customers" ALTER COLUMN "phone" DROP NOT NULL;
ALTER TABLE "customers" ADD COLUMN "preferred_channel" "CustomerChannel" NOT NULL DEFAULT 'WHATSAPP',
                        ADD COLUMN "clerk_user_id" TEXT;
CREATE UNIQUE INDEX "customers_tenant_id_email_key" ON "customers"("tenant_id", "email");
CREATE UNIQUE INDEX "customers_tenant_id_clerk_user_id_key" ON "customers"("tenant_id", "clerk_user_id");

-- AlterTable: bookings — branch, term, extension link, pipeline timestamps
ALTER TABLE "bookings" ADD COLUMN "location_id" UUID,
                       ADD COLUMN "term_months" INTEGER,
                       ADD COLUMN "extends_booking_id" UUID,
                       ADD COLUMN "kyc_requested_at" TIMESTAMP(3),
                       ADD COLUMN "contract_generated_at" TIMESTAMP(3),
                       ADD COLUMN "waitlisted_at" TIMESTAMP(3);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: invoices — payment-schedule position, generated PDF
ALTER TABLE "invoices" ADD COLUMN "schedule_index" INTEGER,
                       ADD COLUMN "document_url" TEXT;

-- AlterTable: contracts — generated (unsigned) agreement PDF
ALTER TABLE "contracts" ADD COLUMN "unsigned_document_url" TEXT;

-- CreateTable: customer_access_tokens (magic links)
CREATE TABLE "customer_access_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_access_tokens_token_hash_key" ON "customer_access_tokens"("token_hash");
CREATE INDEX "customer_access_tokens_tenant_id_idx" ON "customer_access_tokens"("tenant_id");
CREATE INDEX "customer_access_tokens_customer_id_idx" ON "customer_access_tokens"("customer_id");

-- AddForeignKey
ALTER TABLE "customer_access_tokens" ADD CONSTRAINT "customer_access_tokens_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security — same shape as every migration since enable_rls: a
-- new table is not retroactively covered, so ENABLE + FORCE + policy here.
ALTER TABLE "customer_access_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_access_tokens" FORCE ROW LEVEL SECURITY;
-- nullif(..., '') per 20260809120200_harden_tenant_isolation_nullctx: a
-- placeholder GUC reverts to the EMPTY STRING (not NULL) on a pooled connection
-- that has ever set it, and ''::uuid raises instead of matching nothing. This
-- table is created after that migration ran, so it has to carry the guard
-- itself — a magic-link token is exactly the row that must never be readable
-- from an unscoped connection.
CREATE POLICY tenant_isolation ON "customer_access_tokens"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Grants: enable_rls granted rentos_app table privileges on the tables that
-- existed then; later migrations' tables inherit via the DEFAULT PRIVILEGES
-- set there. Repeated explicitly here so this migration is self-contained
-- even if that default was never applied on a given database.
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_access_tokens" TO rentos_app;
