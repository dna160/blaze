import Link from "next/link";
import type { AssetTypeDto } from "@rentos/contracts";

import { apiFetch } from "@/lib/api";
import { resolveTenantSlug } from "@/lib/tenant";

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(
    Number(amount),
  );
}

/** PRD §7.1.1: public catalog, no login required, SEO-rendered (this is a Server Component). */
export default async function CatalogPage() {
  const tenantSlug = await resolveTenantSlug();
  const assetTypes = await apiFetch<AssetTypeDto[]>("/catalog/asset-types", { tenantSlug });

  return (
    <div>
      <h1 className="text-3xl font-semibold">Find the right storage unit</h1>
      <p className="mt-2 text-brand-700/70">Instant pricing. Book online, pay by VA/QRIS/e-wallet, move in fast.</p>

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
              from {formatIDR(assetType.pricing.basePrice)}/month
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
