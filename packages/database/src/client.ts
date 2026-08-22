import { PrismaClient } from "../generated/client/index.js";

/**
 * Runtime services (api, worker) MUST connect via DATABASE_URL_APP, which
 * points at the `rentos_app` role created by the enable_rls migration.
 * That role has no BYPASSRLS/superuser/table-ownership escape hatch, so
 * every query it runs is subject to the tenant_isolation policy.
 *
 * Migrations (`prisma migrate deploy`) intentionally use the separate
 * DATABASE_URL (owning role) — see prisma/migrations/*_enable_rls.
 *
 * Falling back to DATABASE_URL when DATABASE_URL_APP is unset keeps local
 * bootstrapping (before you've provisioned rentos_app) unblocked, but it
 * means RLS is NOT enforced in that fallback mode — hence the loud warning.
 */
function resolveDatabaseUrl(): string {
  const appUrl = process.env.DATABASE_URL_APP;
  if (appUrl) return appUrl;

  const fallback = process.env.DATABASE_URL;
  if (!fallback) {
    throw new Error("Neither DATABASE_URL_APP nor DATABASE_URL is set.");
  }
  // eslint-disable-next-line no-console
  console.warn(
    "[@rentos/database] DATABASE_URL_APP is not set — falling back to DATABASE_URL. " +
      "RLS is NOT enforced against an owning role. Set DATABASE_URL_APP to the rentos_app connection string outside local bootstrapping.",
  );
  return fallback;
}

let prismaSingleton: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  if (!prismaSingleton) {
    prismaSingleton = new PrismaClient({
      datasources: { db: { url: resolveDatabaseUrl() } },
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
  }
  return prismaSingleton;
}

export type { PrismaClient };
