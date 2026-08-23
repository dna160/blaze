import Link from "next/link";
import { notFound } from "next/navigation";
import type { LocationAssetTypeSummary, LocationDto } from "@rentos/contracts";

import { apiFetch, ApiError } from "@/lib/api";
import { resolveTenantSlug } from "@/lib/tenant";

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(
    Number(amount),
  );
}

const SIZE_COPY: Record<string, { title: string; hint: string }> = {
  SMALL: { title: "Small", hint: "Boxes, a bike, seasonal items — about a walk-in closet." },
  MEDIUM: { title: "Medium", hint: "A studio apartment's worth: sofa, bed, boxes." },
  LARGE: { title: "Large", hint: "A family home or business stock — van-sized." },
};

/** PRD v2 §4.1 step 2: sizes sold at this branch, with live "available now" counts. */
export default async function LocationSizesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenantSlug = await resolveTenantSlug();
  let locations: LocationDto[];
  let summaries: LocationAssetTypeSummary[];
  try {
    [locations, summaries] = await Promise.all([
      apiFetch<LocationDto[]>("/catalog/locations", { tenantSlug }),
      apiFetch<LocationAssetTypeSummary[]>(`/catalog/locations/${id}/asset-types`, { tenantSlug }),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  const location = locations.find((l) => l.id === id);
  if (!location) notFound();

  return (
    <div>
      <Link href="/" className="text-sm text-brand-700/60 hover:text-accent-500">
        ← All branches
      </Link>
      <h1 className="mt-2 text-3xl font-semibold">{location.name}</h1>
      {location.address && <p className="mt-1 text-brand-700/70">{location.address}</p>}
      <ol className="mt-4 flex flex-wrap gap-2 text-xs text-brand-700/60">
        <li className="rounded-full bg-brand-700/5 px-3 py-1">1 · Branch ✓</li>
        <li className="rounded-full bg-brand-700 px-3 py-1 font-medium text-white">2 · Size</li>
        <li className="rounded-full bg-brand-700/5 px-3 py-1">3 · Your details</li>
      </ol>

      {summaries.length === 0 ? (
        <p className="mt-8 text-brand-700/60">This branch has no units listed yet.</p>
      ) : (
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          {summaries.map(({ assetType, sizeClass, unitCount, availableNow }) => {
            const copy = sizeClass ? SIZE_COPY[sizeClass] : undefined;
            const full = availableNow === 0;
            return (
              <Link
                key={assetType.id}
                href={`/locations/${location.id}/${assetType.id}`}
                className="flex flex-col rounded-xl border border-brand-600/10 bg-white p-6 shadow-sm transition hover:shadow-md"
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-accent-500">{copy?.title ?? "Unit"}</p>
                <h2 className="mt-1 text-lg font-medium">{assetType.name}</h2>
                <p className="mt-1 text-sm text-brand-700/60">
                  {String(assetType.attributesSchema.sizeM2 ?? "")} m²
                  {assetType.attributesSchema.climateControlled ? " · Climate controlled" : ""}
                </p>
                {copy && <p className="mt-2 text-sm text-brand-700/70">{copy.hint}</p>}
                <p className="mt-4 text-xl font-semibold">
                  {formatIDR(assetType.pricing.basePrice)}
                  <span className="text-sm font-normal text-brand-700/60">/month</span>
                </p>
                <p className={`mt-3 text-sm ${full ? "text-amber-700" : "text-green-700"}`}>
                  {full ? `Fully booked right now — join the waitlist` : `${availableNow} of ${unitCount} available now`}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
