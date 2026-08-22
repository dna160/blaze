-- Harden tenant_isolation against the pooled-connection empty-string GUC gotcha.
--
-- A custom ("placeholder") GUC set via SET LOCAL / set_config(..., is_local=true)
-- does NOT revert to undefined at transaction end — on a connection that has set
-- it at least once it reverts to the EMPTY STRING. Prisma pools connections, so a
-- query that ever runs outside withTenantContext() on a reused connection would
-- evaluate `current_setting('app.tenant_id', true)::uuid` against '' and raise
-- `invalid input syntax for type uuid: ""` instead of returning zero rows.
--
-- That is still fail-closed (an error returns no data, never another tenant's
-- rows), but BUILD-SPEC §11.4's invariant is that forgetting tenant scope is
-- "structurally a zero-rows result." We make that literally true by wrapping the
-- cast in nullif(..., '') so both unset (NULL) and reverted ('') resolve to NULL,
-- and `tenant_id = NULL` is never true. The org_read policy already uses this
-- guard. Recreate tenant_isolation for every table that currently has it, so
-- existing and newly-added tenant tables are all covered.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_policies
    WHERE policyname = 'tenant_isolation' AND schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY tenant_isolation ON %I', r.tablename);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      r.tablename
    );
  END LOOP;
END
$$;
