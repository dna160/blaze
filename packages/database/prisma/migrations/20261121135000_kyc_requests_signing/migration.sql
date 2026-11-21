-- PRD go-live 2 §5 — KYC requests (batches), staff-assisted uploads, and the
-- two ways to sign a contract (online / offline with a deadline).

-- §5.2 KYC requests ----------------------------------------------------------
CREATE TYPE "KycRequestStatus" AS ENUM ('OPEN', 'COMPLETE', 'VERIFIED', 'REJECTED');

CREATE TABLE "kyc_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "booking_id" UUID,
    "requested_types" TEXT[],
    "requested_by_user_id" UUID,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channel" TEXT NOT NULL DEFAULT 'WHATSAPP',
    "status" "KycRequestStatus" NOT NULL DEFAULT 'OPEN',
    "completed_at" TIMESTAMP(3),
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kyc_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "kyc_requests_tenant_id_status_idx" ON "kyc_requests"("tenant_id", "status");
CREATE INDEX "kyc_requests_customer_id_idx" ON "kyc_requests"("customer_id");
CREATE INDEX "kyc_requests_booking_id_idx" ON "kyc_requests"("booking_id");

ALTER TABLE "kyc_requests" ADD CONSTRAINT "kyc_requests_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "kyc_requests" ADD CONSTRAINT "kyc_requests_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- At most one undecided request per customer: the batch a new upload joins.
CREATE UNIQUE INDEX "kyc_requests_one_undecided_per_customer" ON "kyc_requests"("customer_id") WHERE "status" IN ('OPEN', 'COMPLETE');

GRANT SELECT, INSERT, UPDATE, DELETE ON "kyc_requests" TO rentos_app;
ALTER TABLE "kyc_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kyc_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "kyc_requests"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- §5.1 staff-assisted uploads ------------------------------------------------
ALTER TABLE "kyc_documents" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'CUSTOMER';
ALTER TABLE "kyc_documents" ADD COLUMN "uploaded_by_user_id" UUID;
ALTER TABLE "kyc_documents" ADD COLUMN "kyc_request_id" UUID;
CREATE INDEX "kyc_documents_kyc_request_id_idx" ON "kyc_documents"("kyc_request_id");
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_kyc_request_id_fkey" FOREIGN KEY ("kyc_request_id") REFERENCES "kyc_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: every customer who already has documents gets ONE synthetic
-- request holding them, so nothing under review disappears from the new
-- per-request review page and reviewed documents stay findable in its history.
--   something still PENDING_REVIEW -> COMPLETE (waiting for a reviewer)
--   otherwise the customer's own outcome -> VERIFIED or REJECTED
INSERT INTO "kyc_requests" ("id", "tenant_id", "customer_id", "booking_id", "requested_types", "requested_at", "channel", "status", "completed_at", "decided_at", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  c."tenant_id",
  c."id",
  (SELECT b."id" FROM "bookings" b WHERE b."customer_id" = c."id" ORDER BY b."created_at" DESC LIMIT 1),
  d."types",
  d."first_at",
  'BACKFILL',
  CASE
    WHEN d."pending" > 0 THEN 'COMPLETE'::"KycRequestStatus"
    WHEN c."kyc_status" = 'REJECTED' THEN 'REJECTED'::"KycRequestStatus"
    ELSE 'VERIFIED'::"KycRequestStatus"
  END,
  d."last_at",
  CASE WHEN d."pending" > 0 THEN NULL ELSE d."last_reviewed_at" END,
  d."first_at",
  CURRENT_TIMESTAMP
FROM "customers" c
JOIN (
  SELECT
    "customer_id",
    array_agg(DISTINCT "document_type") AS "types",
    min("created_at") AS "first_at",
    max("created_at") AS "last_at",
    max("reviewed_at") AS "last_reviewed_at",
    count(*) FILTER (WHERE "status" = 'PENDING_REVIEW') AS "pending"
  FROM "kyc_documents"
  GROUP BY "customer_id"
) d ON d."customer_id" = c."id";

UPDATE "kyc_documents" k
SET "kyc_request_id" = r."id"
FROM "kyc_requests" r
WHERE r."customer_id" = k."customer_id" AND r."channel" = 'BACKFILL' AND k."kyc_request_id" IS NULL;

-- §5.3 two ways to sign ------------------------------------------------------
ALTER TABLE "contracts" ADD COLUMN "sign_method" TEXT NOT NULL DEFAULT 'ONLINE';
ALTER TABLE "contracts" ADD COLUMN "sign_deadline_at" TIMESTAMP(3);
ALTER TABLE "contracts" ADD COLUMN "company_stamp_present" BOOLEAN;
ALTER TABLE "contracts" ADD COLUMN "signed_uploaded_by_user_id" UUID;
