"use client";

import { useState } from "react";

import { apiFetch, ApiError } from "@/lib/api";

interface BookingFormProps {
  tenantSlug: string;
  assetTypeId: string;
  bookingModel: string;
}

/** PRD §7.1.2 booking flow steps 1-3: pick date(s), identify by phone, submit. OTP/KYC happen after submission in this v1 flow. */
export function BookingForm({ tenantSlug, assetTypeId, bookingModel }: BookingFormProps) {
  const isNightly = bookingModel === "NIGHTLY";
  const isDurationOrder = bookingModel === "DURATION_ORDER";
  const needsEndDate = isNightly || isDurationOrder;
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [phone, setPhone] = useState("");
  const [fullName, setFullName] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [bookingId, setBookingId] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (needsEndDate && endDate && new Date(endDate) <= new Date(startDate)) {
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
          ...(needsEndDate ? { endDate: new Date(endDate).toISOString() } : {}),
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

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-brand-600/10 bg-white p-6">
      <h3 className="font-medium">Request this unit</h3>
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
      {needsEndDate && (
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
