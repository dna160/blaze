import type { Prisma, PrismaClient } from "../generated/client/index.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTenantIdError extends Error {
  constructor(tenantId: string) {
    super(`"${tenantId}" is not a valid tenant id (expected a UUID).`);
    this.name = "InvalidTenantIdError";
  }
}

/**
 * Runs `fn` inside a transaction with the Postgres session variable
 * `app.tenant_id` set for its duration, which is what every RLS policy
 * checks (see prisma/migrations/*_enable_rls). This is the ONLY sanctioned
 * way to scope a query to a tenant — there is no per-query `where: { tenantId }`
 * escape hatch anywhere in this codebase, by design: forgetting a `where`
 * clause must be structurally impossible to turn into a cross-tenant leak.
 *
 * `SET LOCAL` cannot be parameterized directly, so we go through
 * `set_config(...)` inside a `SELECT`, which Prisma DOES parameterize —
 * this keeps tenantId untrusted-input-safe without string interpolation.
 * The UUID regex check is defense in depth, not the primary safeguard.
 */
export async function withTenantContext<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new InvalidTenantIdError(tenantId);
  }

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}
