"use client";

/**
 * Client-side tenant slug for API calls from client components. Prefers the
 * dev/build-time env (how every deployed storefront is configured today —
 * one build per tenant), falling back to the first label of the hostname
 * so a wildcard-DNS deployment (`{tenant}.rentos.app`) works without a
 * rebuild. Mirrors `resolveTenantSlug()` in ./tenant.ts for server
 * components.
 */
export function getClientTenantSlug(): string {
  const env = process.env.NEXT_PUBLIC_DEV_TENANT_SLUG ?? process.env.NEXT_PUBLIC_TENANT_SLUG;
  if (env) return env;
  if (typeof window === "undefined") return "";
  const label = window.location.hostname.split(".")[0] ?? "";
  return label === "localhost" ? "" : label;
}

export function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}

export function formatDateId(value: string | Date): string {
  return new Date(value).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}
