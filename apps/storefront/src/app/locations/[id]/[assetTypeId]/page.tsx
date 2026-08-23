import Link from "next/link";
import { notFound } from "next/navigation";
import type { AssetTypeDto, LocationDto } from "@rentos/contracts";

import { StorageBookingForm } from "@/components/StorageBookingForm";
import { apiFetch, ApiError } from "@/lib/api";
import { resolveTenantSlug } from "@/lib/tenant";

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(
    Number(amount),
  );
}

/** PRD v2 §4.1 step 3: check-in date, term, name, WhatsApp — with live availability + the full payment schedule preview. */
export default async function StorageBookingPage({ params }: { params: Promise<{ id: string; assetTypeId: string }> }) {
  const { id, assetTypeId } = await params;
  const tenantSlug = await resolveTenantSlug();
  let locations: LocationDto[];
  let assetType: AssetTypeDto;
  try {
    [locations, assetType] = await Promise.all([
      apiFetch<LocationDto[]>("/catalog/locations", { tenantSlug }),
      apiFetch<AssetTypeDto>(`/catalog/asset-types/${assetTypeId}`, { tenantSlug }),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  const location = locations.find((l) => l.id === id);
  if (!location || assetType.bookingModel !== "RECURRING_LEASE") notFound();

  const deposit =
    assetType.pricing.depositRule?.type === "MULTIPLE_OF_RENT"
      ? `${assetType.pricing.depositRule.multiple}× monthly rent (refundable)`
      : assetType.pricing.depositRule && "amount" in assetType.pricing.depositRule
        ? `${formatIDR(assetType.pricing.depositRule.amount)} (refundable)`
        : "none";

  return (
    <div className="grid gap-10 md:grid-cols-2">
      <div>
        <Link href={`/locations/${location.id}`} className="text-sm text-brand-700/60 hover:text-accent-500">
          ← Other sizes at {location.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{assetType.name}</h1>
        <p className="mt-1 text-brand-700/70">{location.name}</p>
        <ol className="mt-4 flex flex-wrap gap-2 text-xs text-brand-700/60">
          <li className="rounded-full bg-brand-700/5 px-3 py-1">1 · Branch ✓</li>
          <li className="rounded-full bg-brand-700/5 px-3 py-1">2 · Size ✓</li>
          <li className="rounded-full bg-brand-700 px-3 py-1 font-medium text-white">3 · Your details</li>
        </ol>
        <p className="mt-6 text-2xl font-semibold text-accent-500">
          {formatIDR(assetType.pricing.basePrice)}
          <span className="text-base font-normal text-brand-700/60">/month</span>
        </p>
        <dl className="mt-6 space-y-2 text-sm">
          <div className="flex justify-between border-b border-brand-600/10 pb-2">
            <dt className="text-brand-700/60">Size</dt>
            <dd>
              {String(assetType.attributesSchema.sizeM2 ?? "")} m²
              {assetType.attributesSchema.climateControlled ? " · climate controlled" : ""}
            </dd>
          </div>
          <div className="flex justify-between border-b border-brand-600/10 pb-2">
            <dt className="text-brand-700/60">Terms</dt>
            <dd>1, 3, 6 or 12 months · billed monthly</dd>
          </div>
          <div className="flex justify-between border-b border-brand-600/10 pb-2">
            <dt className="text-brand-700/60">Admin fee (once)</dt>
            <dd>{formatIDR(assetType.pricing.adminFee ?? 0)}</dd>
          </div>
          <div className="flex justify-between border-b border-brand-600/10 pb-2">
            <dt className="text-brand-700/60">Security deposit</dt>
            <dd>{deposit}</dd>
          </div>
        </dl>
        <p className="mt-4 text-xs text-brand-700/60">
          First payment = first month + admin fee + deposit. Following months are invoiced 7 days before they're due. No daily or weekly rates.
        </p>
      </div>
      <div>
        <StorageBookingForm locationId={location.id} locationName={location.name} assetTypeId={assetType.id} assetTypeName={assetType.name} />
      </div>
    </div>
  );
}
