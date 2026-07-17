-- CreateEnum
CREATE TYPE "SwapRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "swap_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "requested_asset_type_id" UUID NOT NULL,
    "reason" TEXT,
    "status" "SwapRequestStatus" NOT NULL DEFAULT 'PENDING',
    "new_asset_id" UUID,
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "swap_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "swap_requests_tenant_id_idx" ON "swap_requests"("tenant_id");

-- CreateIndex
CREATE INDEX "swap_requests_booking_id_idx" ON "swap_requests"("booking_id");

-- AddForeignKey
ALTER TABLE "swap_requests" ADD CONSTRAINT "swap_requests_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swap_requests" ADD CONSTRAINT "swap_requests_requested_asset_type_id_fkey" FOREIGN KEY ("requested_asset_type_id") REFERENCES "asset_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swap_requests" ADD CONSTRAINT "swap_requests_new_asset_id_fkey" FOREIGN KEY ("new_asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-Level Security — same shape as the enable_rls migration's per-table
-- loop (ENABLE + FORCE + a tenant_id-matching policy). New tables aren't
-- retroactively covered by that migration, so every table created after
-- it needs this repeated explicitly. rentos_app's table-level GRANT
-- already covers this table via the original migration's
-- ALTER DEFAULT PRIVILEGES, so only RLS itself is needed here.
ALTER TABLE "swap_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "swap_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "swap_requests"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
