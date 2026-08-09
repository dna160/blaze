import type { Prisma, PrismaClient } from "../generated/client/index.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidOrganizationIdError extends Error {
  constructor(organizationId: string) {
    super(`"${organizationId}" is not a valid organization id (expected a UUID).`);
    this.name = "InvalidOrganizationIdError";
  }
}

/**
 * BUILD-SPEC C1 — the READ-ONLY cross-tenant scope for HO users.
 *
 * Sets the SEPARATE Postgres session variable `app.organization_id` for the
 * duration of the transaction. The `org_read` RLS policy (a FOR SELECT
 * permissive policy, migration 20260809120100_rls_new_tables_and_org_read) makes
 * every row whose tenant belongs to this organization visible to reads — and
 * ONLY reads. It never touches the `tenant_isolation` WITH CHECK clause, so
 * INSERT/UPDATE/DELETE remain strictly single-tenant. This is why HO can see
 * full financials across branches (B2) while a cross-tenant WRITE stays
 * structurally impossible.
 *
 * This function deliberately does NOT set `app.tenant_id`. Use it only for read
 * paths. For a write on behalf of an org-scoped user, go through
 * `withTenantContext(activeTenantId, ...)` as normal — the write is then
 * confined to that active tenant, exactly as the spec requires.
 */
export async function withOrgReadContext<T>(
  prisma: PrismaClient,
  organizationId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(organizationId)) {
    throw new InvalidOrganizationIdError(organizationId);
  }

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
    return fn(tx);
  });
}
