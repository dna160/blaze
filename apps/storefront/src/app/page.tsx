import Link from "next/link";
import type { AssetDto, AssetTypeDto, LocationDto } from "@rentos/contracts";

import { LocationMap } from "@/components/LocationMap";
import { apiFetch } from "@/lib/api";
import { resolveTenantSlug } from "@/lib/tenant";

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(
    Number(amount),
  );
}

/**
 * PRD §7.1.1: public catalog, no login required, SEO-rendered (Server Component).
 *
 * PRD v2 §4.1: a storage tenant (any published RECURRING_LEASE type) sells
 * branch-first — step 1 is "choose a location", with a map that recommends
 * the closest branch. Tenants without storage types (homestay, equipment)
 * keep the v1 asset-type catalog untouched.
 */
export default async function CatalogPage() {
  const tenantSlug = await resolveTenantSlug();
  const assetTypes = await apiFetch<AssetTypeDto[]>("/catalog/asset-types", { tenantSlug });
  const isStorageTenant = assetTypes.some((t) => t.bookingModel === "RECURRING_LEASE");

  if (isStorageTenant) {
    const [locations, assets] = await Promise.all([
      apiFetch<LocationDto[]>("/catalog/locations", { tenantSlug }),
      apiFetch<AssetDto[]>("/catalog/assets", { tenantSlug }),
    ]);
    const unitCounts: Record<string, number> = {};
    for (const a of assets) unitCounts[a.locationId] = (unitCounts[a.locationId] ?? 0) + 1;
    const cheapest = assetTypes
      .filter((t) => t.bookingModel === "RECURRING_LEASE")
      .map((t) => Number(t.pricing.basePrice))
      .sort((a, b) => a - b)[0];

    return (
      <div>
        <h1 className="text-3xl font-semibold">Choose your branch</h1>
        <p className="mt-2 text-brand-700/70">
          Self-storage from {cheapest !== undefined ? formatIDR(cheapest) : "—"}/month · 1, 3, 6 or 12-month terms · confirmation on WhatsApp.
        </p>
        <ol className="mt-4 flex flex-wrap gap-2 text-xs text-brand-700/60">
          <li className="rounded-full bg-brand-700 px-3 py-1 font-medium text-white">1 · Branch</li>
          <li className="rounded-full bg-brand-700/5 px-3 py-1">2 · Size</li>
          <li className="rounded-full bg-brand-700/5 px-3 py-1">3 · Your details</li>
        </ol>
        <div className="mt-6">
          <LocationMap locations={locations} unitCounts={unitCounts} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-3xl font-semibold">Find the right unit</h1>
      <p className="mt-2 text-brand-700/70">Instant pricing. Book online, pay by VA/QRIS/e-wallet.</p>

      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        {assetTypes.map((assetType) => (
          <Link
            key={assetType.id}
            href={`/asset-types/${assetType.id}`}
            className="rounded-xl border border-brand-600/10 bg-white p-6 shadow-sm transition hover:shadow-md"
          >
            <h2 className="text-lg font-medium">{assetType.name}</h2>
            <p className="mt-1 text-sm text-brand-700/60">
              {String(assetType.attributesSchema.sizeM2 ?? "")} m²
              {assetType.attributesSchema.climateControlled ? " · Climate controlled" : ""}
            </p>
            <p className="mt-4 text-xl font-semibold text-accent-500">
              from {formatIDR(assetType.pricing.basePrice)}
              {assetType.bookingModel === "NIGHTLY" ? "/night" : assetType.bookingModel === "DURATION_ORDER" ? "/day" : "/month"}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
