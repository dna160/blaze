-- Messaging inbox: staff need to know which inbound messages they have opened.
-- Only meaningful on inbound rows (template_key = 'inbound_message'); NULL means
-- unread. Idempotent in the same style as the other migrations here, so a
-- partially-applied deploy can be re-run.
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "read_at" TIMESTAMP(3);

-- The inbox groups by (tenant, counterpart phone) and orders by time; without
-- this every conversation list is a sequential scan of the whole table.
CREATE INDEX IF NOT EXISTS "notifications_tenant_id_recipient_created_at_idx"
  ON "notifications" ("tenant_id", "recipient", "created_at");
