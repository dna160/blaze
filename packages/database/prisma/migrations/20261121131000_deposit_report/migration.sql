-- PRD go-live 2 §3 — the deposit report: dates on the deposit, and a row per
-- movement so a date-range report shows what happened in the range.

CREATE TYPE "DepositSource" AS ENUM ('RENTOS', 'LEGACY');
CREATE TYPE "DepositEventType" AS ENUM ('HELD', 'APPLIED', 'REFUND_REQUESTED', 'REFUNDED', 'ADJUSTED');

ALTER TABLE "deposits" ADD COLUMN "customer_id" UUID;
ALTER TABLE "deposits" ADD COLUMN "source" "DepositSource" NOT NULL DEFAULT 'RENTOS';
ALTER TABLE "deposits" ADD COLUMN "received_at" TIMESTAMP(3);
ALTER TABLE "deposits" ADD COLUMN "refund_requested_at" TIMESTAMP(3);
ALTER TABLE "deposits" ADD COLUMN "refund_requested_by_user_id" UUID;
ALTER TABLE "deposits" ADD COLUMN "refund_due_at" TIMESTAMP(3);

-- Backfill from the booking: customer, source, and refund due = lease end + 30
-- days (T&C IV.3). The lease end is the notice date when notice ends the lease
-- before its term, else the term end; an open-ended lease has none yet.
UPDATE "deposits" d
SET "customer_id" = b."customer_id",
    "source" = CASE WHEN b."legacy_booking_number" IS NOT NULL THEN 'LEGACY'::"DepositSource" ELSE 'RENTOS'::"DepositSource" END,
    "refund_due_at" = (
      CASE
        WHEN b."notice_effective_date" IS NOT NULL AND (b."end_date" IS NULL OR b."notice_effective_date" < b."end_date") THEN b."notice_effective_date"
        ELSE b."end_date"
      END
    ) + INTERVAL '30 days'
FROM "bookings" b
WHERE b."id" = d."booking_id";

-- When the money arrived: the day the booking's deposit-carrying invoice was
-- paid. A legacy row was never paid here — it carries its import date.
UPDATE "deposits" d
SET "received_at" = CASE
  WHEN d."source" = 'LEGACY' THEN d."created_at"
  ELSE COALESCE(
    (SELECT MIN(i."paid_at") FROM "invoices" i
      WHERE i."booking_id" = d."booking_id" AND i."paid_at" IS NOT NULL
        AND EXISTS (SELECT 1 FROM "invoice_lines" l WHERE l."invoice_id" = i."id" AND l."line_type" = 'DEPOSIT')),
    d."created_at")
END;

ALTER TABLE "deposits" ALTER COLUMN "received_at" SET NOT NULL;
ALTER TABLE "deposits" ALTER COLUMN "received_at" SET DEFAULT CURRENT_TIMESTAMP;

-- A refund already asked for or paid: the request date was never stored, so
-- the best record is when the row last changed (or the payout itself).
UPDATE "deposits" SET "refund_requested_at" = COALESCE("refunded_at", "updated_at")
WHERE "status" IN ('REFUND_REQUESTED', 'REFUNDED');

CREATE INDEX "deposits_tenant_id_customer_id_idx" ON "deposits"("tenant_id", "customer_id");

CREATE TABLE "deposit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "deposit_id" UUID NOT NULL,
    "type" "DepositEventType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "deposit_events_tenant_id_occurred_at_idx" ON "deposit_events"("tenant_id", "occurred_at");
CREATE INDEX "deposit_events_deposit_id_idx" ON "deposit_events"("deposit_id");

ALTER TABLE "deposit_events" ADD CONSTRAINT "deposit_events_deposit_id_fkey" FOREIGN KEY ("deposit_id") REFERENCES "deposits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill the movements of the deposits that already exist.
--
-- RentOS deposits: received in full on received_at.
INSERT INTO "deposit_events" ("id", "tenant_id", "deposit_id", "type", "amount", "occurred_at", "note")
SELECT gen_random_uuid(), d."tenant_id", d."id", 'HELD', d."amount", d."received_at", 'Backfilled: deposit collected'
FROM "deposits" d WHERE d."source" = 'RENTOS';

-- Legacy deposits: exactly what the import posted to DEPOSIT_LIABILITY, entry
-- by entry — the first as HELD, each later re-sync correction as a signed
-- ADJUSTED — so the events and the ledger agree at every point in time.
INSERT INTO "deposit_events" ("id", "tenant_id", "deposit_id", "type", "amount", "occurred_at", "note")
SELECT gen_random_uuid(), x."tenant_id", x."deposit_id",
       CASE WHEN x.n = 1 THEN 'HELD'::"DepositEventType" ELSE 'ADJUSTED'::"DepositEventType" END,
       x.signed, x."created_at",
       CASE WHEN x.n = 1 THEN 'Backfilled: opening balance from the legacy system' ELSE 'Backfilled: legacy re-sync correction' END
FROM (
  SELECT d."tenant_id", d."id" AS "deposit_id", le."created_at",
         CASE WHEN le."entry_type" = 'CREDIT' THEN le."amount" ELSE -le."amount" END AS signed,
         ROW_NUMBER() OVER (PARTITION BY d."id" ORDER BY le."created_at", le."id") AS n
  FROM "deposits" d
  JOIN "ledger_entries" le
    ON le."tenant_id" = d."tenant_id" AND le."reference_type" = 'LEGACY_IMPORT'
   AND le."reference_id" = d."booking_id" AND le."account" = 'DEPOSIT_LIABILITY'
  WHERE d."source" = 'LEGACY'
) x;

-- A legacy deposit with no ledger entry at all (should not exist): keep it visible.
INSERT INTO "deposit_events" ("id", "tenant_id", "deposit_id", "type", "amount", "occurred_at", "note")
SELECT gen_random_uuid(), d."tenant_id", d."id", 'HELD', d."amount", d."received_at", 'Backfilled: legacy deposit without a ledger entry'
FROM "deposits" d
WHERE d."source" = 'LEGACY' AND NOT EXISTS (SELECT 1 FROM "deposit_events" e WHERE e."deposit_id" = d."id");

-- Applied against damages and refunds: one event per ledger posting, at its time.
INSERT INTO "deposit_events" ("id", "tenant_id", "deposit_id", "type", "amount", "occurred_at", "note")
SELECT gen_random_uuid(), le."tenant_id", d."id",
       CASE WHEN le."description" = 'Deposit refunded' THEN 'REFUNDED'::"DepositEventType" ELSE 'APPLIED'::"DepositEventType" END,
       le."amount", le."created_at", 'Backfilled: ' || le."description"
FROM "ledger_entries" le
JOIN "deposits" d ON d."id" = le."reference_id" AND d."tenant_id" = le."tenant_id"
WHERE le."reference_type" = 'DEPOSIT' AND le."account" = 'DEPOSIT_LIABILITY' AND le."entry_type" = 'DEBIT';

INSERT INTO "deposit_events" ("id", "tenant_id", "deposit_id", "type", "amount", "occurred_at", "note")
SELECT gen_random_uuid(), d."tenant_id", d."id", 'REFUND_REQUESTED', d."amount" - d."applied_amount", d."refund_requested_at", 'Backfilled: refund requested (date approximate)'
FROM "deposits" d WHERE d."refund_requested_at" IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON "deposit_events" TO rentos_app;
ALTER TABLE "deposit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deposit_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "deposit_events"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY org_read ON "deposit_events" FOR SELECT
  USING (tenant_id IN (SELECT id FROM tenants WHERE organization_id = nullif(current_setting('app.organization_id', true), '')::uuid));
