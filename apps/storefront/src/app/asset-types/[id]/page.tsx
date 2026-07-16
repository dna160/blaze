import type { AssetTypeDto, AvailabilityResponse } from "@rentos/contracts";

import { BookingForm } from "@/components/BookingForm";
import { apiFetch } from "@/lib/api";
import { resolveTenantSlug } from "@/lib/tenant";

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(
    Number(amount),
  );
}

export default async function AssetTypeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenantSlug = await resolveTenantSlug();
  const [assetType, availability] = await Promise.all([
    apiFetch<AssetTypeDto>(`/catalog/asset-types/${id}`, { tenantSlug }),
    apiFetch<AvailabilityResponse>(`/catalog/asset-types/${id}/availability`, { tenantSlug }),
  ]);

  return (
    <div className="grid gap-10 md:grid-cols-2">
      <div>
        <h1 className="text-2xl font-semibold">{assetType.name}</h1>
        <p className="mt-2 text-brand-700/70">
          {String(assetType.attributesSchema.sizeM2 ?? "")} m² ·{" "}
          {assetType.attributesSchema.climateControlled ? "Climate controlled" : "Standard"}
        </p>
        <p className="mt-4 text-2xl font-semibold text-accent-500">
          {formatIDR(assetType.pricing.basePrice)}
          <span className="text-base font-normal text-brand-700/60">/month</span>
        </p>
        <p className="mt-2 text-sm text-brand-700/70">
          {availability.availableCount > 0
            ? `${availability.availableCount} unit${availability.availableCount === 1 ? "" : "s"} available now`
            : "Currently fully booked — join the waitlist via WhatsApp."}
        </p>
        <dl className="mt-6 space-y-2 text-sm">
          <div className="flex justify-between border-b border-brand-600/10 pb-2">
            <dt className="text-brand-700/60">Admin fee</dt>
            <dd>{formatIDR(assetType.pricing.adminFee ?? 0)}</dd>
          </div>
          <div className="flex justify-between border-b border-brand-600/10 pb-2">
            <dt className="text-brand-700/60">Security deposit</dt>
            <dd>
              {assetType.pricing.depositRule?.type === "MULTIPLE_OF_RENT"
                ? `${assetType.pricing.depositRule.multiple}× monthly rent`
                : formatIDR(assetType.pricing.depositRule && "amount" in assetType.pricing.depositRule ? assetType.pricing.depositRule.amount : 0)}
            </dd>
          </div>
        </dl>
      </div>

      <div>{availability.availableCount > 0 && <BookingForm tenantSlug={tenantSlug} assetTypeId={assetType.id} />}</div>
    </div>
  );
}
