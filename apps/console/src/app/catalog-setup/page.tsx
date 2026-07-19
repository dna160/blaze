"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AssetTypeDto, BookingModelValue, LocationDto, PricingConfig } from "@rentos/contracts";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

const BOOKING_MODELS: { value: BookingModelValue; label: string; billingPeriod: PricingConfig["billingPeriod"] }[] = [
  { value: "RECURRING_LEASE", label: "Recurring Lease (monthly rent)", billingPeriod: "MONTHLY" },
  { value: "NIGHTLY", label: "Nightly (hotel/homestay)", billingPeriod: "NIGHTLY" },
  { value: "DURATION_ORDER", label: "Duration Order (equipment rental)", billingPeriod: "ORDER" },
  { value: "HOURLY_SLOT", label: "Hourly Slot (venue/studio)", billingPeriod: "HOURLY" },
];

interface AssetTypeFormState {
  name: string;
  slug: string;
  bookingModel: BookingModelValue;
  basePrice: string;
  currency: string;
  adminFee: string;
  depositType: "NONE" | "FIXED" | "MULTIPLE_OF_RENT";
  depositAmount: string;
  depositMultiple: string;
  taxInclusive: boolean;
  isPooled: boolean;
  isPublished: boolean;
}

const EMPTY_FORM: AssetTypeFormState = {
  name: "",
  slug: "",
  bookingModel: "RECURRING_LEASE",
  basePrice: "",
  currency: "IDR",
  adminFee: "",
  depositType: "NONE",
  depositAmount: "",
  depositMultiple: "",
  taxInclusive: false,
  isPooled: false,
  isPublished: true,
};

function toPricing(form: AssetTypeFormState): PricingConfig {
  const billingPeriod = BOOKING_MODELS.find((m) => m.value === form.bookingModel)!.billingPeriod;
  return {
    basePrice: form.basePrice,
    currency: form.currency,
    billingPeriod,
    adminFee: form.adminFee ? Number(form.adminFee) : undefined,
    taxInclusive: form.taxInclusive,
    depositRule:
      form.depositType === "FIXED"
        ? { type: "FIXED", amount: Number(form.depositAmount || 0) }
        : form.depositType === "MULTIPLE_OF_RENT"
          ? { type: "MULTIPLE_OF_RENT", multiple: Number(form.depositMultiple || 1) }
          : undefined,
  };
}

function fromAssetType(assetType: AssetTypeDto): AssetTypeFormState {
  const pricing = assetType.pricing;
  return {
    name: assetType.name,
    slug: assetType.slug,
    bookingModel: assetType.bookingModel,
    basePrice: pricing.basePrice,
    currency: pricing.currency,
    adminFee: pricing.adminFee?.toString() ?? "",
    depositType: pricing.depositRule?.type ?? "NONE",
    depositAmount: pricing.depositRule?.type === "FIXED" ? pricing.depositRule.amount.toString() : "",
    depositMultiple: pricing.depositRule?.type === "MULTIPLE_OF_RENT" ? pricing.depositRule.multiple.toString() : "",
    taxInclusive: pricing.taxInclusive,
    isPooled: assetType.isPooled,
    isPublished: assetType.isPublished,
  };
}

function formatIDR(amount: string): string {
  const n = Number(amount);
  if (Number.isNaN(n)) return amount;
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);
}

/** Catalog setup (Session 23) — the first console UI to create/edit AssetType pricing or add Asset units; every one before this was seed-data-only. */
export default function CatalogSetupPage() {
  const router = useRouter();
  const [assetTypes, setAssetTypes] = useState<AssetTypeDto[] | null>(null);
  const [locations, setLocations] = useState<LocationDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createForm, setCreateForm] = useState<AssetTypeFormState>(EMPTY_FORM);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<AssetTypeFormState>(EMPTY_FORM);

  const [unitAssetTypeId, setUnitAssetTypeId] = useState<string | null>(null);
  const [unitLocationId, setUnitLocationId] = useState("");
  const [unitCode, setUnitCode] = useState("");

  async function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const [types, locs] = await Promise.all([
        apiFetch<AssetTypeDto[]>("/catalog/asset-types/all", { token }),
        apiFetch<LocationDto[]>("/catalog/locations", { token }),
      ]);
      setAssetTypes(types);
      setLocations(locs);
      if (locs.length > 0 && !unitLocationId) setUnitLocationId(locs[0]!.id);
    } catch (err) {
      if (err instanceof ApiError && err.status !== 401) setError(err.message);
      else router.push("/login");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createAssetType() {
    if (!createForm.name.trim() || !createForm.slug.trim() || !createForm.basePrice.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/catalog/asset-types", {
        token: authClient.getToken(),
        method: "POST",
        body: {
          name: createForm.name.trim(),
          slug: createForm.slug.trim(),
          bookingModel: createForm.bookingModel,
          pricing: toPricing(createForm),
          isPooled: createForm.isPooled,
          isPublished: createForm.isPublished,
        },
      });
      setCreateForm(EMPTY_FORM);
      setShowCreateForm(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create asset type.");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(assetType: AssetTypeDto) {
    setEditingId(assetType.id);
    setEditForm(fromAssetType(assetType));
  }

  async function saveEdit(id: string) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/catalog/asset-types/${id}`, {
        token: authClient.getToken(),
        method: "PATCH",
        body: {
          name: editForm.name.trim(),
          pricing: toPricing(editForm),
          isPooled: editForm.isPooled,
          isPublished: editForm.isPublished,
        },
      });
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update asset type.");
    } finally {
      setBusy(false);
    }
  }

  async function addUnit() {
    if (!unitAssetTypeId || !unitLocationId || !unitCode.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/catalog/assets", {
        token: authClient.getToken(),
        method: "POST",
        body: { assetTypeId: unitAssetTypeId, locationId: unitLocationId, code: unitCode.trim() },
      });
      setUnitCode("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add unit.");
    } finally {
      setBusy(false);
    }
  }

  function renderPricingFields(form: AssetTypeFormState, setForm: (f: AssetTypeFormState) => void, locked: boolean) {
    return (
      <div className="grid grid-cols-2 gap-3">
        {!locked && (
          <div>
            <label className="text-xs font-medium text-brand-700/60">Booking model</label>
            <select
              value={form.bookingModel}
              onChange={(e) => setForm({ ...form, bookingModel: e.target.value as BookingModelValue })}
              className="mt-1 w-full rounded border border-brand-600/20 px-2 py-1.5 text-sm"
            >
              {BOOKING_MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="text-xs font-medium text-brand-700/60">Base price (IDR)</label>
          <input
            value={form.basePrice}
            onChange={(e) => setForm({ ...form, basePrice: e.target.value })}
            placeholder="450000"
            className="mt-1 w-full rounded border border-brand-600/20 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-brand-700/60">Admin fee (IDR, optional)</label>
          <input
            value={form.adminFee}
            onChange={(e) => setForm({ ...form, adminFee: e.target.value })}
            placeholder="50000"
            className="mt-1 w-full rounded border border-brand-600/20 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-brand-700/60">Deposit rule</label>
          <select
            value={form.depositType}
            onChange={(e) => setForm({ ...form, depositType: e.target.value as AssetTypeFormState["depositType"] })}
            className="mt-1 w-full rounded border border-brand-600/20 px-2 py-1.5 text-sm"
          >
            <option value="NONE">No deposit</option>
            <option value="FIXED">Fixed amount</option>
            <option value="MULTIPLE_OF_RENT">Multiple of rent</option>
          </select>
        </div>
        {form.depositType === "FIXED" && (
          <div>
            <label className="text-xs font-medium text-brand-700/60">Deposit amount (IDR)</label>
            <input
              value={form.depositAmount}
              onChange={(e) => setForm({ ...form, depositAmount: e.target.value })}
              className="mt-1 w-full rounded border border-brand-600/20 px-2 py-1.5 text-sm"
            />
          </div>
        )}
        {form.depositType === "MULTIPLE_OF_RENT" && (
          <div>
            <label className="text-xs font-medium text-brand-700/60">Multiple of rent</label>
            <input
              value={form.depositMultiple}
              onChange={(e) => setForm({ ...form, depositMultiple: e.target.value })}
              placeholder="1"
              className="mt-1 w-full rounded border border-brand-600/20 px-2 py-1.5 text-sm"
            />
          </div>
        )}
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={form.taxInclusive} onChange={(e) => setForm({ ...form, taxInclusive: e.target.checked })} />
          Tax inclusive
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={form.isPooled} onChange={(e) => setForm({ ...form, isPooled: e.target.checked })} />
          Pooled (shared inventory)
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={form.isPublished} onChange={(e) => setForm({ ...form, isPublished: e.target.checked })} />
          Published (visible on storefront)
        </label>
      </div>
    );
  }

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">Catalog Setup</h1>
      <p className="mt-1 text-sm text-brand-700/60">
        Create and price asset types, and add individual units — the setup this tenant's catalog runs on.
      </p>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {!assetTypes || !locations ? (
        <p className="mt-6">Loading...</p>
      ) : (
        <div className="mt-6 space-y-8">
          <section>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium">Asset Types</h2>
              <button
                onClick={() => setShowCreateForm((v) => !v)}
                className="rounded bg-brand-700 px-3 py-1.5 text-sm font-medium text-white"
              >
                {showCreateForm ? "Cancel" : "+ New asset type"}
              </button>
            </div>

            {showCreateForm && (
              <div className="mt-3 space-y-3 rounded-lg border border-brand-600/10 bg-white p-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-brand-700/60">Name</label>
                    <input
                      value={createForm.name}
                      onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                      className="mt-1 w-full rounded border border-brand-600/20 px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-brand-700/60">Slug</label>
                    <input
                      value={createForm.slug}
                      onChange={(e) => setCreateForm({ ...createForm, slug: e.target.value.toLowerCase() })}
                      placeholder="unit-2x2"
                      className="mt-1 w-full rounded border border-brand-600/20 px-2 py-1.5 text-sm"
                    />
                  </div>
                </div>
                {renderPricingFields(createForm, setCreateForm, false)}
                <button
                  onClick={createAssetType}
                  disabled={busy || !createForm.name.trim() || !createForm.slug.trim() || !createForm.basePrice.trim()}
                  className="rounded bg-brand-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  Create
                </button>
              </div>
            )}

            <div className="mt-4 space-y-3">
              {assetTypes.map((at) => (
                <div key={at.id} className="rounded-lg border border-brand-600/10 bg-white p-4">
                  {editingId === at.id ? (
                    <div className="space-y-3">
                      <input
                        value={editForm.name}
                        onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                        className="w-full rounded border border-brand-600/20 px-2 py-1.5 text-sm font-medium"
                      />
                      {renderPricingFields(editForm, setEditForm, true)}
                      <div className="flex gap-2">
                        <button
                          onClick={() => saveEdit(at.id)}
                          disabled={busy}
                          className="rounded bg-brand-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="rounded border border-brand-600/20 px-3 py-1.5 text-sm font-medium"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-medium">
                          {at.name} <span className="text-xs text-brand-700/50">({at.slug})</span>
                        </p>
                        <p className="mt-1 text-sm text-brand-700/60">
                          {BOOKING_MODELS.find((m) => m.value === at.bookingModel)?.label} ·{" "}
                          {formatIDR(at.pricing.basePrice)}
                          {at.pricing.adminFee ? ` + ${formatIDR(at.pricing.adminFee.toString())} admin fee` : ""}
                        </p>
                        <p className="mt-1 text-xs text-brand-700/40">
                          {at.isPublished ? "Published" : "Draft (hidden from storefront)"}
                          {at.isPooled ? " · Pooled" : ""}
                        </p>
                      </div>
                      <button
                        onClick={() => startEdit(at)}
                        className="rounded border border-brand-600/20 px-3 py-1.5 text-sm font-medium hover:bg-brand-700/5"
                      >
                        Edit pricing
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {assetTypes.length === 0 && <p className="text-sm text-brand-700/50">No asset types yet — create one above.</p>}
            </div>
          </section>

          <section>
            <h2 className="text-lg font-medium">Add a Unit</h2>
            <p className="mt-1 text-sm text-brand-700/60">Add a physical unit under an existing asset type.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand-600/10 bg-white p-4">
              <select
                value={unitAssetTypeId ?? ""}
                onChange={(e) => setUnitAssetTypeId(e.target.value || null)}
                className="rounded border border-brand-600/20 px-2 py-1.5 text-sm"
              >
                <option value="">Asset type...</option>
                {assetTypes.map((at) => (
                  <option key={at.id} value={at.id}>
                    {at.name}
                  </option>
                ))}
              </select>
              <select
                value={unitLocationId}
                onChange={(e) => setUnitLocationId(e.target.value)}
                className="rounded border border-brand-600/20 px-2 py-1.5 text-sm"
              >
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
              <input
                value={unitCode}
                onChange={(e) => setUnitCode(e.target.value)}
                placeholder="Unit code (e.g. A-05)"
                className="rounded border border-brand-600/20 px-2 py-1.5 text-sm"
              />
              <button
                onClick={addUnit}
                disabled={busy || !unitAssetTypeId || !unitLocationId || !unitCode.trim()}
                className="rounded bg-brand-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Add unit
              </button>
            </div>
          </section>
        </div>
      )}
    </ConsoleShell>
  );
}
