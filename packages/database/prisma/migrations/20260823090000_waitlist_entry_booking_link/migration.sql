-- Link the C5 waitlist queue to the PRD v2 booking it queues for.
--
-- The two specs described the same feature from different ends. BUILD-SPEC C5
-- built `waitlist_entries` for the mechanics that stop a waitlist going wrong:
-- a queue position under a unique (tenant, asset_type, position) constraint, a
-- single-fire row lock on the asset, and a payment TTL. PRD v2 P3 wanted the
-- waitlisted customer to stay one record with one message trail and one card in
-- the approval workbench — which is what a `WAITLISTED` Booking already is.
--
-- Keeping both and joining them gives each what it was for: the Booking is the
-- customer-facing record, this table is the queue. The added columns are what
-- "Offer unit" needs in order to re-check availability for the window the
-- customer actually asked for (PRD v2 §5.1), which position alone can't say.
--
-- All nullable: entries armed directly through the console waitlist API
-- (POST /waitlist) have no originating booking, and that path stays valid.
ALTER TABLE "waitlist_entries"
  ADD COLUMN "booking_id"           UUID,
  ADD COLUMN "location_id"          UUID,
  ADD COLUMN "requested_start_date" TIMESTAMP(3),
  ADD COLUMN "term_months"          INTEGER;

-- One queue row per booking. A booking is waitlisted once, not repeatedly.
CREATE UNIQUE INDEX "waitlist_entries_booking_id_key" ON "waitlist_entries"("booking_id");

-- SET NULL, not CASCADE: deleting a booking must not silently vanish a queue
-- position and shift everyone behind it. The row survives for audit.
ALTER TABLE "waitlist_entries"
  ADD CONSTRAINT "waitlist_entries_booking_id_fkey"
  FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "waitlist_entries"
  ADD CONSTRAINT "waitlist_entries_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- waitlist_entries already carries ENABLE/FORCE ROW LEVEL SECURITY and its
-- tenant_isolation policy from 20260809120100_rls_new_tables_and_org_read, and
-- the nullif() hardening from 20260809120200. Adding columns does not disturb
-- either, and no new table is created here, so there is no policy to add.
