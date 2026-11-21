-- PRD go-live 2 §8.1 / §8.2 — a suppressed message carries a stable reason
-- code next to its text, so the suppressed list can filter and export by it.
ALTER TABLE "notifications" ADD COLUMN "suppression_code" TEXT;

-- Everything suppressed before the test allowlist existed was held by the pause.
UPDATE "notifications" SET "suppression_code" = 'PAUSED' WHERE "status" = 'SUPPRESSED';

-- The suppressed list (and the banner's count) read by status within a tenant.
CREATE INDEX "notifications_tenant_id_status_created_at_idx" ON "notifications"("tenant_id", "status", "created_at");
