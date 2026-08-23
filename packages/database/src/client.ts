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

const logLevels: Array<"warn" | "error"> = process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"];

/**
 * Builds a PrismaClient for `url`. Production/default path: the native
 * library query engine exactly as before. Opt-in path
 * (`PRISMA_DRIVER_ADAPTER=pg`): Prisma's WASM query engine + the `pg`
 * driver adapter, which needs no native engine binary at all — for
 * sandboxes where binaries.prisma.sh is unreachable (see
 * scripts/prisma-wasm-loader.mjs for the Node loader hook that pairs
 * with it). Never set that env var in a real deployment; the default is
 * the tested, supported configuration.
 */
export function createPrismaClient(url: string): PrismaClient {
  if (process.env.PRISMA_DRIVER_ADAPTER === "pg") {
    // Resolved lazily (this package compiles to CommonJS, so `require` is
    // available) so the default path never even loads these modules.
    const { PrismaPg } = require("@prisma/adapter-pg") as typeof import("@prisma/adapter-pg");
    const { Pool } = require("pg") as typeof import("pg");
    const { PrismaClient: WasmPrismaClient } = require("../generated/client/wasm.js") as {
      PrismaClient: new (opts: unknown) => PrismaClient;
    };
    const adapter = new PrismaPg(new Pool({ connectionString: url }));
    return new WasmPrismaClient({ adapter, log: logLevels });
  }
  return new PrismaClient({ datasources: { db: { url } }, log: logLevels });
}

let prismaSingleton: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  if (!prismaSingleton) {
    prismaSingleton = createPrismaClient(resolveDatabaseUrl());
  }
  return prismaSingleton;
}

export type { PrismaClient };
