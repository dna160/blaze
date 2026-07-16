import { headers } from "next/headers";

/**
 * The storefront resolves its own tenant from the Host it's actually
 * being served on (a real customer domain in production), then forwards
 * that as X-Tenant-Slug on every call to the API — see
 * apps/api/src/common/middleware/tenant.middleware.ts for why the API
 * trusts this header. NEXT_PUBLIC_DEV_TENANT_SLUG lets local dev
 * (localhost:3000) work without wildcard DNS.
 */
export async function resolveTenantSlug(): Promise<string> {
  const devSlug = process.env.NEXT_PUBLIC_DEV_TENANT_SLUG;
  if (devSlug) return devSlug;

  const host = (await headers()).get("host") ?? "";
  const domain = host.split(":")[0] ?? "";
  const subdomain = domain.split(".")[0];
  if (!subdomain || subdomain === "localhost") {
    throw new Error(
      "Could not resolve a tenant from the request Host and NEXT_PUBLIC_DEV_TENANT_SLUG is not set.",
    );
  }
  return subdomain;
}
