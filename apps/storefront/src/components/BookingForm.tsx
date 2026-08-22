"use client";

import { useEffect, useState } from "react";
import type { CreateBookingResponse, QuoteResponse } from "@rentos/contracts";

import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

interface BookingFormProps {
  tenantSlug: string;
  assetTypeId: string;
  /** NIGHTLY or DURATION_ORDER — storage (RECURRING_LEASE) uses StorageBookingForm since PRD v2. */
  bookingModel: string;
}

function formatIDR(amount: string): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}

/**
 * PRD §7.1.2 booking flow steps 1-3 for the dated verticals (homestay,
 * equipment): pick a date range, identify by phone, submit. OTP/KYC happen
 * after submission. The price preview comes from GET /catalog/asset-types/:id/quote
 * — the same BookingModelStrategy math the real booking will be charged.
 */
export function BookingForm({ tenantSlug, assetTypeId, bookingModel }: BookingFormProps) {
  const isNightly = bookingModel === "NIGHTLY";
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [phone, setPhone] = useState("");
  const [fullName, setFullName] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [bookingId, setBookingId] = useState<string | null>(null);

  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  useEffect(() => {
    if (!startDate || !endDate) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    setQuoteLoading(true);
    setQuoteError(null);
    const params = new URLSearchParams({ startDate: new Date(startDate).toISOString(), endDate: new Date(endDate).toISOString() });
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
  }, [startDate, endDate, assetTypeId, tenantSlug]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (endDate && new Date(endDate) <= new Date(startDate)) {
      setError(isNightly ? "Checkout date must be after check-in." : "Return date must be after pickup.");
      setStatus("error");
      return;
    }
    setStatus("submitting");
    setError(null);
    try {
      const result = await apiFetch<CreateBookingResponse>("/bookings", {
        tenantSlug,
        token: authClient.getToken() ?? undefined,
        method: "POST",
        body: {
          assetTypeId,
          startDate: new Date(startDate).toISOString(),
          endDate: new Date(endDate).toISOString(),
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
          Reference: <code>{bookingId}</code>. You&apos;ll get a confirmation shortly — the message has a link that signs you straight in to track it.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-brand-600/10 bg-white p-6">
      <h3 className="font-medium">Request this unit</h3>

      <div>
        <label className="block text-sm text-brand-700/70">{isNightly ? "Check-in date" : "Pickup date"}</label>
        <input
          type="date"
          required
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
        />
      </div>

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
