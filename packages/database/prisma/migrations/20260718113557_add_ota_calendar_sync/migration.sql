-- CreateEnum
CREATE TYPE "OtaSyncStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "ota_calendar_subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_synced_at" TIMESTAMP(3),
    "last_sync_status" "OtaSyncStatus" NOT NULL DEFAULT 'PENDING',
    "last_sync_error" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ota_calendar_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ota_blocked_dates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "external_uid" TEXT NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ota_blocked_dates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ota_calendar_subscriptions_tenant_id_idx" ON "ota_calendar_subscriptions"("tenant_id");

-- CreateIndex
CREATE INDEX "ota_calendar_subscriptions_asset_id_idx" ON "ota_calendar_subscriptions"("asset_id");

-- CreateIndex
CREATE INDEX "ota_blocked_dates_tenant_id_idx" ON "ota_blocked_dates"("tenant_id");

-- CreateIndex
CREATE INDEX "ota_blocked_dates_asset_id_idx" ON "ota_blocked_dates"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "ota_blocked_dates_subscription_id_external_uid_key" ON "ota_blocked_dates"("subscription_id", "external_uid");

-- AddForeignKey
ALTER TABLE "ota_calendar_subscriptions" ADD CONSTRAINT "ota_calendar_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ota_calendar_subscriptions" ADD CONSTRAINT "ota_calendar_subscriptions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ota_blocked_dates" ADD CONSTRAINT "ota_blocked_dates_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ota_blocked_dates" ADD CONSTRAINT "ota_blocked_dates_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "ota_calendar_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security — same shape as every migration since enable_rls:
-- new tables aren't retroactively covered by that migration, so each one
-- repeats ENABLE + FORCE + a tenant_id-matching policy explicitly. See
-- docs/HANDOFF.md Session 22.
ALTER TABLE "ota_calendar_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ota_calendar_subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ota_calendar_subscriptions"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "ota_blocked_dates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ota_blocked_dates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ota_blocked_dates"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
