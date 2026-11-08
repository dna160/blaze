import Link from "next/link";
import { notFound } from "next/navigation";
import { SIZE_CLASS_ORDER, unitSizeLabel, type BranchPublicProfile, type LocationAssetTypeSummary, type LocationDto, type SizeClassValue } from "@rentos/contracts";

import { BranchInfo } from "@/components/BranchInfo";
import { apiFetch, ApiError } from "@/lib/api";
import { resolveTenantSlug } from "@/lib/tenant";

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(
    Number(amount),
  );
}

const SIZE_COPY: Record<SizeClassValue, { title: string; hint: string }> = {
  SMALL: { title: "Small", hint: "Boxes, a bike, seasonal items — about a walk-in closet." },
  MEDIUM: { title: "Medium", hint: "A studio apartment's worth: sofa, bed, boxes." },
  LARGE: { title: "Large", hint: "A family home or business stock — van-sized." },
  XLARGE: { title: "X Large", hint: "A whole house move or warehouse stock — truck-sized." },
  FREESTYLE: { title: "Free Style", hint: "Pay only for the volume your goods take." },
};

/** PRD go-live §5.2 — Free Style is sold by volume band, so it gets its own group and an explanation. */
const FREESTYLE_COPY = {
  title: "Free Style",
  id: "Bayar sesuai volume barang Anda: ≤1 m³, 1–2 m³ atau 2–3 m³. Cocok untuk beberapa kardus, koper atau barang musiman tanpa menyewa satu unit penuh.",
  en: "Priced by the volume your goods take, in bands of ≤1 m³, 1–2 m³ or 2–3 m³ — for a few boxes, suitcases or seasonal items without renting a whole unit.",
};

function SizeCard({ summary, locationId }: { summary: LocationAssetTypeSummary; locationId: string }) {
  const { assetType, sizeClass, unitCount, availableNow } = summary;
  const copy = sizeClass ? SIZE_COPY[sizeClass] : undefined;
  const full = availableNow === 0;
  const size = unitSizeLabel(assetType.attributesSchema);
  return (
    <Link
      href={`/locations/${locationId}/${assetType.id}`}
      className="flex flex-col rounded-xl border border-brand-600/10 bg-white p-6 shadow-sm transition hover:shadow-md"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-accent-500">{copy?.title ?? "Unit"}</p>
      <h2 className="mt-1 text-lg font-medium">{assetType.name}</h2>
      <p className="mt-1 text-sm text-brand-700/60">
        {size ?? ""}
        {assetType.attributesSchema.climateControlled ? `${size ? " · " : ""}Climate controlled` : ""}
      </p>
      {copy && sizeClass !== "FREESTYLE" && <p className="mt-2 text-sm text-brand-700/70">{copy.hint}</p>}
      <p className="mt-4 text-xl font-semibold">
        {formatIDR(assetType.pricing.basePrice)}
        <span className="text-sm font-normal text-brand-700/60">/month</span>
      </p>
      <p className={`mt-3 text-sm ${full ? "text-amber-700" : "text-green-700"}`}>
        {full ? `Fully booked right now — join the waitlist` : `${availableNow} of ${unitCount} available now`}
      </p>
    </Link>
  );
}

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
  // Branch details are a nicety here: never let them take the size list down.
  const profile = await apiFetch<BranchPublicProfile>("/branch/profile", { tenantSlug }).catch(() => null);

  // S, M, L, XL first (the API already sorts them), then Free Style as its own group.
  const rank = (c: SizeClassValue | null) => (c ? SIZE_CLASS_ORDER.indexOf(c) : SIZE_CLASS_ORDER.length);
  const sorted = [...summaries].sort((a, b) => rank(a.sizeClass) - rank(b.sizeClass));
  const units = sorted.filter((s) => s.sizeClass !== "FREESTYLE");
  const freeStyle = sorted.filter((s) => s.sizeClass === "FREESTYLE");

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
        <>
          {units.length > 0 && (
            <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {units.map((s) => (
                <SizeCard key={s.assetType.id} summary={s} locationId={location.id} />
              ))}
            </div>
          )}
          {freeStyle.length > 0 && (
            <section className="mt-10">
              <h2 className="text-xl font-semibold">{FREESTYLE_COPY.title}</h2>
              <p className="mt-1 max-w-2xl text-sm text-brand-700/70">{FREESTYLE_COPY.id}</p>
              <p className="mt-1 max-w-2xl text-sm text-brand-700/50">{FREESTYLE_COPY.en}</p>
              <div className="mt-4 grid gap-6 sm:grid-cols-3">
                {freeStyle.map((s) => (
                  <SizeCard key={s.assetType.id} summary={s} locationId={location.id} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {profile && (
        <section className="mt-10">
          <h2 className="text-xl font-semibold">Tentang cabang ini / About this branch</h2>
          <div className="mt-3">
            <BranchInfo profile={profile} />
          </div>
        </section>
      )}
    </div>
  );
}
