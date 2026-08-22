-- BUILD-SPEC C1 — RLS for the new tenant-scoped tables, plus the cross-tenant
-- HO read scope. Two hard rules from the spec, both enforced here:
--
--   1. The new tenant-scoped tables (customer_phones, master_agreements,
--      rental_orders, rental_order_events, order_acceptances, waitlist_entries)
--      get the SAME tenant_isolation policy shape as every existing table:
--      ENABLE + FORCE ROW LEVEL SECURITY, USING and WITH CHECK both keyed on
--      current_setting('app.tenant_id'). Forgetting tenant context is a
--      zero-rows result, never a cross-tenant leak.
--
--   2. HO cross-tenant visibility (B2: HO sees FULL financials) is a SEPARATE,
--      READ-ONLY policy keyed on a SEPARATE session variable, app.organization_id.
--      It is a `FOR SELECT` permissive policy, so it is OR'd with tenant_isolation
--      for reads but has NO effect on INSERT/UPDATE/DELETE — writes remain
--      strictly single-tenant (tenant_isolation's WITH CHECK is never widened).
--      When app.organization_id is unset it resolves to NULL and matches no rows
--      (fail-closed). A cross-tenant WRITE bug in a franchise system is
--      commercially unrecoverable; this design makes one structurally impossible.

-- Grants for the new tables (and organizations). ALTER DEFAULT PRIVILEGES from
-- the original enable_rls migration already covers tables the migrator creates,
-- but we grant explicitly so this migration is self-contained and correct even
-- if the default-privileges owner ever differs.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "organizations", "customer_phones", "master_agreements", "rental_orders",
  "rental_order_events", "order_acceptances", "waitlist_entries"
TO rentos_app;

-- 1. tenant_isolation on the new tenant-scoped tables.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'customer_phones', 'master_agreements', 'rental_orders',
    'rental_order_events', 'order_acceptances', 'waitlist_entries'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      t
    );
  END LOOP;
END
$$;

-- 2. org_read: a read-only cross-tenant scope for HO users. Applied to every
--    tenant-scoped table (existing + new). A row is visible under this policy
--    only when its tenant belongs to the organization set in app.organization_id.
--    nullif(...,'') + the (,true) missing_ok arg make an unset/empty variable
--    resolve to NULL, which matches no tenants (fail-closed).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'locations', 'users', 'customers', 'kyc_documents', 'customer_phones',
    'asset_types', 'assets', 'bookings', 'booking_events', 'contracts',
    'invoices', 'invoice_lines', 'payments', 'credit_notes', 'deposits',
    'ledger_entries', 'notifications', 'automation_settings', 'promo_codes',
    'swap_requests', 'master_agreements', 'rental_orders',
    'rental_order_events', 'order_acceptances', 'waitlist_entries'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY org_read ON %I FOR SELECT USING (tenant_id IN (SELECT id FROM tenants WHERE organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid))',
      t
    );
  END LOOP;
END
$$;
