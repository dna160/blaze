-- Row-Level Security: tenant isolation is enforced by Postgres, not by
-- application convention (PRD §6 "RLS makes cross-tenant leakage a
-- DB-enforced impossibility").
--
-- How tenant context is set: every request-scoped Prisma transaction opens
-- with `SET LOCAL app.tenant_id = '<uuid>'` (see packages/database/src/tenant-context.ts).
-- current_setting('app.tenant_id', true) returns NULL when unset, and
-- `tenant_id = NULL` is never true in SQL — so a query that forgets to set
-- tenant context sees zero rows (fail-closed), never another tenant's rows.
--
-- Ownership gotcha this migration deliberately avoids: Postgres RLS does
-- NOT apply to a table's owning role by default. If the application
-- connected with the same role that owns the tables (the common mistake),
-- RLS would silently no-op for all app traffic. We fix this two ways:
--   1. FORCE ROW LEVEL SECURITY on every tenant table, so RLS applies even
--      to the owner (only a superuser or BYPASSRLS role would skip it).
--   2. A dedicated `rentos_app` role, used ONLY by the running services
--      (never for migrations), which is a plain non-superuser role with no
--      BYPASSRLS attribute. Migrations continue to run as the owning role
--      from DATABASE_URL; runtime services connect via DATABASE_URL_APP.
--      See .env.example and docs/HANDOFF.md ("RLS enforcement").

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rentos_app') THEN
    CREATE ROLE rentos_app LOGIN PASSWORD 'changeme_in_production' NOBYPASSRLS NOSUPERUSER;
  END IF;
END
$$;

-- FORCE ROW LEVEL SECURITY (below) applies policies even to the table
-- owner, which is exactly what we want for rentos_app — but it also means
-- the role running THIS migration (DATABASE_URL, whatever Railway/local
-- Postgres names it — not necessarily a true superuser on managed
-- Postgres) would be locked out of its own tables for seed/admin
-- operations. Grant it BYPASSRLS explicitly rather than assuming
-- superuser status; this is a deliberate, visible flag, not an ownership
-- side effect.
DO $$
BEGIN
  EXECUTE format('ALTER ROLE %I BYPASSRLS', current_user);
END
$$;

GRANT USAGE ON SCHEMA public TO rentos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rentos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rentos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rentos_app;

-- Tables scoped by tenant_id (non-nullable). Nullable-tenant tables
-- (users, audit_log, webhook_events) get the same policy shape below —
-- rows with a NULL tenant_id (platform-admin scope) are only reachable via
-- the owning/migrator role until a dedicated platform-admin path ships
-- (tracked in docs/HANDOFF.md, PRD Phase 4 territory).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'locations', 'users', 'customers', 'kyc_documents',
    'asset_types', 'assets', 'bookings', 'booking_events', 'contracts',
    'invoices', 'invoice_lines', 'payments', 'credit_notes', 'deposits',
    'ledger_entries', 'notifications', 'automation_settings', 'promo_codes',
    'audit_log', 'webhook_events'
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

-- `tenants` and `tenant_domains` are deliberately EXCLUDED from per-row
-- tenant RLS (no ENABLE ROW LEVEL SECURITY above — the blanket GRANT
-- earlier in this file already covers rentos_app's read access to them).
-- Resolving which tenant a request belongs to (by Host header / custom
-- domain) is the bootstrapping step that happens BEFORE app.tenant_id can
-- be set — a table that required tenant context to discover the tenant
-- would be a chicken-and-egg lock-out. Domain-to-tenant mapping is not
-- sensitive: it's inherent to running a public storefront on that domain.
-- Everything domain-scoped (bookings, invoices, etc.) still requires the
-- context these two tables exist to establish.
