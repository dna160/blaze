-- IDEMPOTENT. This migration was originally named with a 202607xx timestamp and
-- was applied to at least one live database under that name (production, hand-
-- migrated in July when Phase 4 was verified). It was later re-timestamped to
-- sort AFTER 20260809120200_harden_tenant_isolation_nullctx, because that
-- migration rewrites every tenant_isolation policy and would otherwise strip the
-- platform-admin branch this set adds to `users`.
--
-- Renaming makes Prisma treat it as brand new, so it re-runs against databases
-- that already have these objects — which is exactly what happened on
-- 2026-08-23: `Database error code 42710` (duplicate_object), and P3009 blocking
-- every later migration. Every statement below is therefore guarded so that
-- re-running is a no-op. Do not add an unguarded CREATE to this file.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "tenant_api_keys" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "created_by_user_id" UUID,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "tenant_webhook_subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "event_types" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "tenant_webhook_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "http_status" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "tenant_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_api_keys_key_hash_key" ON "tenant_api_keys"("key_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tenant_api_keys_tenant_id_idx" ON "tenant_api_keys"("tenant_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tenant_webhook_subscriptions_tenant_id_idx" ON "tenant_webhook_subscriptions"("tenant_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tenant_webhook_deliveries_tenant_id_idx" ON "tenant_webhook_deliveries"("tenant_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tenant_webhook_deliveries_subscription_id_idx" ON "tenant_webhook_deliveries"("subscription_id");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "tenant_api_keys" ADD CONSTRAINT "tenant_api_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "tenant_webhook_subscriptions" ADD CONSTRAINT "tenant_webhook_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "tenant_webhook_deliveries" ADD CONSTRAINT "tenant_webhook_deliveries_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "tenant_webhook_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Row-Level Security — same shape as every migration since enable_rls: new
-- tables aren't retroactively covered by that migration, so each one
-- repeats ENABLE + FORCE + a tenant_id-matching policy explicitly.
-- tenant_api_keys stays RLS-covered like everything else (NOT excluded
-- like tenants/tenant_domains) — ExternalApiModule's ApiKeyGuard looks up
-- a key only after TenantMiddleware has already resolved the tenant from
-- X-Tenant-Slug/Host, so the lookup runs inside that tenant's RLS context,
-- never as an unscoped cross-tenant scan. See docs/HANDOFF.md Session 20.
ALTER TABLE "tenant_api_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_api_keys" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "tenant_api_keys";
CREATE POLICY tenant_isolation ON "tenant_api_keys"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "tenant_webhook_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_webhook_subscriptions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "tenant_webhook_subscriptions";
CREATE POLICY tenant_isolation ON "tenant_webhook_subscriptions"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "tenant_webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_webhook_deliveries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "tenant_webhook_deliveries";
CREATE POLICY tenant_isolation ON "tenant_webhook_deliveries"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
