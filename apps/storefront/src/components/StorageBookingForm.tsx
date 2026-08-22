"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CreateBookingResponse, QuoteResponse, StorageAvailabilityResponse, TermMonthsValue } from "@rentos/contracts";

import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { formatDateId, formatIDR, getClientTenantSlug } from "@/lib/tenant-client";

interface Props {
  locationId: string;
  locationName: string;
  assetTypeId: string;
  assetTypeName: string;
}

const TERMS: Array<{ months: TermMonthsValue; label: string }> = [
  { months: 1, label: "1 month" },
  { months: 3, label: "3 months" },
  { months: 6, label: "6 months" },
  { months: 12, label: "12 months" },
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * PRD v2 §4.1 step 3 + §4.3/§4.4: check-in date and term drive a live
 * availability check (blackout-aware, against the customer's real dates)
 * and a live quote that previews the whole monthly payment schedule —
 * the same math the proforma will be generated with. Full is never a dead
 * end: the form says up front that the request will be waitlisted, and
 * the result panel reports the position. A signed-in customer (OTP or
 * Google) is attached by session; the API uses their stored channel.
 */
export function StorageBookingForm({ locationId, locationName, assetTypeId, assetTypeName }: Props) {
  const tenantSlug = getClientTenantSlug();
  const [startDate, setStartDate] = useState("");
  const [termMonths, setTermMonths] = useState<TermMonthsValue>(3);
  const [phone, setPhone] = useState("");
  const [fullName, setFullName] = useState("");
  const [availability, setAvailability] = useState<StorageAvailabilityResponse | null>(null);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateBookingResponse | null>(null);
  const [sessionName, setSessionName] = useState<string | null>(null);

  useEffect(() => {
    const token = authClient.getToken();
    if (!token) return;
    apiFetch<{ fullName: string | null; phone: string | null }>("/customers/me", { tenantSlug, token })
      .then((me) => {
        setSessionName(me.fullName ?? "your account");
        if (me.fullName) setFullName(me.fullName);
        if (me.phone) setPhone(me.phone);
      })
      .catch(() => undefined);
  }, [tenantSlug]);

  useEffect(() => {
    if (!startDate) {
      setAvailability(null);
      setQuote(null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    const iso = new Date(startDate).toISOString();
    const params = new URLSearchParams({ locationId, assetTypeId, startDate: iso, termMonths: String(termMonths) });
    Promise.all([
      apiFetch<StorageAvailabilityResponse>(`/catalog/availability?${params.toString()}`, { tenantSlug }),
      apiFetch<QuoteResponse>(`/catalog/asset-types/${assetTypeId}/quote?startDate=${encodeURIComponent(iso)}&termMonths=${termMonths}`, { tenantSlug }),
    ])
      .then(([a, q]) => {
        if (cancelled) return;
        setAvailability(a);
        setQuote(q);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setAvailability(null);
        setQuote(null);
        setError(err instanceof ApiError ? err.message : "Could not check these dates.");
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [startDate, termMonths, locationId, assetTypeId, tenantSlug]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);
    try {
      const token = authClient.getToken() ?? undefined;
      const res = await apiFetch<CreateBookingResponse>("/bookings", {
        tenantSlug,
        token,
        method: "POST",
        body: {
          assetTypeId,
          locationId,
          startDate: new Date(startDate).toISOString(),
          termMonths,
          customerPhone: phone,
          customerFullName: fullName,
        },
      });
      setResult(res);
      setStatus("done");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      setStatus("error");
    }
  }

  if (status === "done" && result) {
    const waitlisted = result.status === "WAITLISTED";
    return (
      <div className={`rounded-xl p-6 ${waitlisted ? "bg-amber-50 text-amber-900" : "bg-green-50 text-green-900"}`}>
        <p className="text-lg font-semibold">{waitlisted ? `You're on the waitlist (#${result.waitlistPosition})` : "Request received!"}</p>
        <p className="mt-2 text-sm">
          {waitlisted
            ? `${assetTypeName} at ${locationName} is full for ${formatDateId(startDate)}. We've saved your spot — you'll get a message the moment a unit frees up.`
            : `We'll confirm your ${assetTypeName} at ${locationName} (unit ${result.assetCode}) shortly. Watch for our message — it has a link that signs you straight in.`}
        </p>
        <p className="mt-3 text-xs opacity-80">
          Reference <code>{result.id.slice(0, 8)}</code> ·{" "}
          <Link href={`/portal/bookings/${result.id}`} className="underline">
            track it in My Account
          </Link>
        </p>
      </div>
    );
  }

  const full = availability !== null && !availability.available;
  const canSubmit = Boolean(startDate && fullName && phone) && status !== "submitting" && !checking && availability !== null;

  return (
    <form onSubmit={onSubmit} className="space-y-5 rounded-xl border border-brand-600/10 bg-white p-6">
      <h3 className="font-medium">Book this size</h3>
      {sessionName && <p className="text-xs text-brand-700/60">Booking as {sessionName}.</p>}

      <div>
        <label className="block text-sm text-brand-700/70">Check-in date</label>
        <input
          type="date"
          required
          min={todayIso()}
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
        />
      </div>

      <div>
        <label className="block text-sm text-brand-700/70">Rental term</label>
        <div className="mt-1 grid grid-cols-4 gap-1 rounded border border-brand-600/20 p-1">
          {TERMS.map((t) => (
            <button
              key={t.months}
              type="button"
              onClick={() => setTermMonths(t.months)}
              className={`rounded px-2 py-1.5 text-sm font-medium transition-colors ${
                termMonths === t.months ? "bg-brand-700 text-white" : "text-brand-700/70 hover:bg-brand-700/5"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {startDate && (
        <div className={`rounded-lg p-3 text-sm ${checking ? "bg-brand-700/5" : full ? "bg-amber-50 text-amber-900" : "bg-green-50 text-green-900"}`}>
          {checking
            ? "Checking availability…"
            : availability
              ? full
                ? `Fully booked for these dates — you'll be added to the waitlist (${availability.waitlistAhead} ahead of you).`
                : `${availability.availableCount} unit${availability.availableCount === 1 ? "" : "s"} free from ${formatDateId(startDate)} to ${formatDateId(availability.endDate)}.`
              : null}
        </div>
      )}

      {quote && !checking && (
        <div className="rounded-lg bg-brand-700/5 p-3 text-sm">
          <p className="font-medium text-brand-700">First payment</p>
          <div className="mt-1 space-y-1">
            {quote.lines.map((l, i) => (
              <div key={i} className="flex justify-between text-brand-700/70">
                <span>{l.description}</span>
                <span>{formatIDR(l.amount)}</span>
              </div>
            ))}
            <div className="flex justify-between border-t border-brand-600/10 pt-1 font-medium text-brand-700">
              <span>Due before move-in</span>
              <span>{formatIDR(quote.totalAmount)}</span>
            </div>
          </div>
          {quote.schedule && quote.schedule.length > 1 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-brand-700/60">Then {quote.schedule.length - 1} monthly payment{quote.schedule.length > 2 ? "s" : ""}</summary>
              <ul className="mt-1 space-y-0.5 text-xs text-brand-700/70">
                {quote.schedule.slice(1).map((p) => (
                  <li key={p.index} className="flex justify-between">
                    <span>Due {formatDateId(p.dueDate)}</span>
                    <span>{formatIDR(p.totalAmount)}</span>
                  </li>
                ))}
              </ul>
            </details>
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
        disabled={!canSubmit}
        className={`w-full rounded py-2 font-medium text-white disabled:opacity-50 ${full ? "bg-amber-600" : "bg-brand-700"}`}
      >
        {status === "submitting" ? "Submitting…" : full ? "Join the waitlist" : "Request to book"}
      </button>
      <p className="text-center text-xs text-brand-700/60">No payment now. We confirm first, then send your contract and proforma invoice.</p>
    </form>
  );
}
