-- PRD go-live 2 §4 — booking changes need approval.

-- CreateEnum
CREATE TYPE "ChangeRequestType" AS ENUM ('CANCEL', 'CHANGE_START_DATE');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "change_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "type" "ChangeRequestType" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "reason" TEXT NOT NULL,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "change_requests_tenant_id_status_idx" ON "change_requests"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "change_requests_booking_id_idx" ON "change_requests"("booking_id");

-- At most one PENDING request per booking per type (§4.1). A second one is
-- refused by the database, whatever the application checked first.
CREATE UNIQUE INDEX "change_requests_one_pending_per_booking_type"
  ON "change_requests"("booking_id", "type") WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "change_requests" TO rentos_app;
ALTER TABLE "change_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "change_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "change_requests"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- §4.3 — a contract is re-rendered as a new version when its booking's start
-- date moves; the earlier versions are kept on the row.
ALTER TABLE "contracts" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "contracts" ADD COLUMN "previous_versions" JSONB NOT NULL DEFAULT '[]';
