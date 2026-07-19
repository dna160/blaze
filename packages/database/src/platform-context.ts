import type { Prisma, PrismaClient } from "../generated/client/index.js";

/**
 * The dedicated platform-admin path the original enable_rls migration
 * flagged as future work (see prisma/migrations/*_add_platform_billing's
 * comment on the `users` policy). Sets `app.platform_admin = 'true'` for
 * the duration of the transaction, which is the ONLY thing that makes a
 * NULL-tenant_id `User` row (a platform admin — see `User.tenantId`'s
 * doc comment) visible under `rentos_app`'s RLS-restricted connection.
 *
 * Deliberately narrow: this does not grant any broader cross-tenant
 * access. Every other RLS-covered table's policy is untouched by this
 * session var — only `users` has an OR-branch that reads it at all — so
 * this function has exactly one legitimate use: looking up (or creating,
 * during self-serve tenant signup's admin-user step — though that step
 * actually runs under withTenantContext for the NEW tenant, not this)
 * a platform-admin User for login. See AuthService.platformLogin, the
 * only caller.
 */
export async function withPlatformContext<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.platform_admin', 'true', true)`;
    return fn(tx);
  });
}
