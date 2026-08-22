"use client";

import { useEffect, useState } from "react";
import type { QuoteResponse, RateTierValue } from "@rentos/contracts";

import { apiFetch, ApiError } from "@/lib/api";

interface BookingFormProps {
  tenantSlug: string;
  assetTypeId: string;
  bookingModel: string;
  /** RECURRING_LEASE only — which of DAILY/WEEKLY the storefront should offer alongside the always-available Monthly option. */
  availableRateTiers?: RateTierValue[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function formatIDR(amount: string): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * PRD §7.1.2 booking flow steps 1-3: pick date(s)/tier, identify by phone,
 * submit. OTP/KYC happen after submission in this v1 flow.
 *
 * RECURRING_LEASE's Daily/Weekly/Monthly tier picker (Travelio-style short
 * stays on a storage/rental unit): check-in date + a duration count
 * computes the checkout date and drives a live price preview from
 * GET /catalog/asset-types/:id/quote — the same BookingModelStrategy math
 * the real booking will be charged, so the preview can't drift from the
 * actual invoice.
 */
export function BookingForm({ tenantSlug, assetTypeId, bookingModel, availableRateTiers = [] }: BookingFormProps) {
  const isNightly = bookingModel === "NIGHTLY";
  const isDurationOrder = bookingModel === "DURATION_ORDER";
  const isRecurringLease = bookingModel === "RECURRING_LEASE";
  const tierOptions: RateTierValue[] = isRecurringLease ? ["MONTHLY", ...availableRateTiers] : [];
  const hasTierChoice = tierOptions.length > 1;

  const needsEndDate = isNightly || isDurationOrder;
  const [rateTier, setRateTier] = useState<RateTierValue>("MONTHLY");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [duration, setDuration] = useState(1); // days for DAILY, weeks for WEEKLY
  const [phone, setPhone] = useState("");
  const [fullName, setFullName] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [bookingId, setBookingId] = useState<string | null>(null);

  const isFixedTermLease = isRecurringLease && (rateTier === "DAILY" || rateTier === "WEEKLY");
  // Fixed-term RECURRING_LEASE computes its own checkout date from
  // startDate + duration; NIGHTLY/DURATION_ORDER still take a raw date
  // picker (their "duration" is inherently a date range, not a count).
  const computedEndDate = isFixedTermLease && startDate ? addDays(startDate, rateTier === "DAILY" ? duration : duration * 7) : "";
  const effectiveEndDate = isFixedTermLease ? computedEndDate : endDate;
  const showRawEndDatePicker = needsEndDate;
  const showDurationPicker = isFixedTermLease;

  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  useEffect(() => {
    if (!startDate) {
      setQuote(null);
      return;
    }
    if ((needsEndDate || isFixedTermLease) && !effectiveEndDate) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    setQuoteLoading(true);
    setQuoteError(null);
    const params = new URLSearchParams({ startDate: new Date(startDate).toISOString() });
    if (effectiveEndDate) params.set("endDate", new Date(effectiveEndDate).toISOString());
    if (isRecurringLease) params.set("rateTier", rateTier);
    apiFetch<QuoteResponse>(`/catalog/asset-types/${assetTypeId}/quote?${params.toString()}`, { tenantSlug })
      .then((q) => {
        if (!cancelled) setQuote(q);
      })
      .catch((err) => {
        if (!cancelled) {
          setQuote(null);
          setQuoteError(err instanceof ApiError ? err.message : "Could not price these dates.");
        }
      })
      .finally(() => {
        if (!cancelled) setQuoteLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, effectiveEndDate, rateTier]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (showRawEndDatePicker && endDate && new Date(endDate) <= new Date(startDate)) {
      setError(isNightly ? "Checkout date must be after check-in." : "Return date must be after pickup.");
      setStatus("error");
      return;
    }
    setStatus("submitting");
    setError(null);
    try {
      const result = await apiFetch<{ id: string }>("/bookings", {
        tenantSlug,
        method: "POST",
        body: {
          assetTypeId,
          startDate: new Date(startDate).toISOString(),
          ...(effectiveEndDate ? { endDate: new Date(effectiveEndDate).toISOString() } : {}),
          ...(isRecurringLease ? { rateTier } : {}),
          customerPhone: phone,
          customerFullName: fullName,
        },
      });
      setBookingId(result.id);
      setStatus("done");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <div className="rounded-lg bg-green-50 p-4 text-sm text-green-800">
        <p className="font-medium">Booking request submitted!</p>
        <p className="mt-1">
          Reference: <code>{bookingId}</code>. You&apos;ll get a WhatsApp confirmation shortly — log in with your
          phone number in <a href="/login" className="underline">My Account</a> to track it.
        </p>
      </div>
    );
  }

  const TIER_LABEL: Record<RateTierValue, string> = { DAILY: "Daily", WEEKLY: "Weekly", MONTHLY: "Monthly" };

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-brand-600/10 bg-white p-6">
      <h3 className="font-medium">Request this unit</h3>

      {hasTierChoice && (
        <div>
          <label className="block text-sm text-brand-700/70">Rental term</label>
          <div className="mt-1 grid grid-cols-3 gap-1 rounded border border-brand-600/20 p-1">
            {tierOptions.map((tier) => (
              <button
                key={tier}
                type="button"
                onClick={() => {
                  setRateTier(tier);
                  setDuration(1);
                }}
                className={`rounded px-2 py-1.5 text-sm font-medium transition-colors ${
                  rateTier === tier ? "bg-brand-700 text-white" : "text-brand-700/70 hover:bg-brand-700/5"
                }`}
              >
                {TIER_LABEL[tier]}
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <label className="block text-sm text-brand-700/70">
          {isNightly ? "Check-in date" : isDurationOrder ? "Pickup date" : "Move-in date"}
        </label>
        <input
          type="date"
          required
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
        />
      </div>

      {showDurationPicker && (
        <div>
          <label className="block text-sm text-brand-700/70">
            {rateTier === "DAILY" ? "Number of days" : "Number of weeks"}
          </label>
          <input
            type="number"
            required
            min={1}
            value={duration}
            onChange={(e) => setDuration(Math.max(1, Number(e.target.value) || 1))}
            className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
          />
          {computedEndDate && (
            <p className="mt-1 text-xs text-brand-700/60">
              Checkout: {new Date(computedEndDate).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })}
            </p>
          )}
        </div>
      )}

      {showRawEndDatePicker && (
        <div>
          <label className="block text-sm text-brand-700/70">{isNightly ? "Checkout date" : "Return date"}</label>
          <input
            type="date"
            required
            min={startDate || undefined}
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
          />
        </div>
      )}

      {(quoteLoading || quote || quoteError) && (
        <div className="rounded-lg bg-brand-700/5 p-3 text-sm">
          {quoteLoading && <p className="text-brand-700/60">Calculating price...</p>}
          {quoteError && <p className="text-red-600">{quoteError}</p>}
          {quote && !quoteLoading && (
            <div className="space-y-1">
              {quote.lines.map((l, i) => (
                <div key={i} className="flex justify-between text-brand-700/70">
                  <span>{l.description}</span>
                  <span>{formatIDR(l.amount)}</span>
                </div>
              ))}
              <div className="flex justify-between border-t border-brand-600/10 pt-1 font-medium text-brand-700">
                <span>Total due now</span>
                <span>{formatIDR(quote.totalAmount)}</span>
              </div>
            </div>
          )}
        </div>
      )}

      <div>
        <label className="block text-sm text-brand-700/70">Full name</label>
        <input
          required
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
          placeholder="Siti Aminah"
        />
      </div>
      <div>
        <label className="block text-sm text-brand-700/70">WhatsApp number</label>
        <input
          required
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
          placeholder="+62812xxxxxxx"
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={status === "submitting"}
        className="w-full rounded bg-brand-700 py-2 font-medium text-white disabled:opacity-50"
      >
        {status === "submitting" ? "Submitting..." : "Request to book"}
      </button>
    </form>
  );
}
