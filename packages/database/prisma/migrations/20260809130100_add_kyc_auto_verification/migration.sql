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
  CREATE TYPE "KycVerificationSource" AS ENUM ('MANUAL', 'AUTO');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "provider_reason" TEXT,
ADD COLUMN IF NOT EXISTS "provider_ref" TEXT,
ADD COLUMN IF NOT EXISTS "verification_source" "KycVerificationSource" NOT NULL DEFAULT 'MANUAL';
