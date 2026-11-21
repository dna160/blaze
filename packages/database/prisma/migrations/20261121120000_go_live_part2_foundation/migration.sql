-- PRD go-live 2 — the columns several workstreams share. Feature tables
-- (deposit events, change requests, KYC requests, ...) come in their own
-- migrations.

-- §8.1 test allowlist, §4.1 approval policy, §9.2 branding
ALTER TABLE "organizations" ADD COLUMN "messaging_allowlist" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "organizations" ADD COLUMN "messaging_allowlist_only" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "organizations" ADD COLUMN "approval_policy" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "organizations" ADD COLUMN "branding" JSONB NOT NULL DEFAULT '{}';

-- §6.1 passwords, §9.1 console language
ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "password_changed_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'id';
