"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { BookingDto } from "@rentos/contracts";

import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

const TENANT_SLUG = process.env.NEXT_PUBLIC_DEV_TENANT_SLUG ?? "";

/** PRD §7.1.4: self-service "give termination notice". */
export default function BookingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [booking, setBooking] = useState<BookingDto | null>(null);
  const [noticeDate, setNoticeDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    apiFetch<BookingDto>(`/bookings/${id}`, { tenantSlug: TENANT_SLUG, token })
      .then(setBooking)
      .catch(() => router.push("/portal"));
  }, [id, router]);

  async function giveNotice(e: React.FormEvent) {
    e.preventDefault();
    const token = authClient.getToken();
    if (!token) return;
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch(`/bookings/${id}/notice`, {
        tenantSlug: TENANT_SLUG,
        token,
        method: "POST",
        body: { noticeEffectiveDate: new Date(noticeDate).toISOString() },
      });
      setMessage("Termination notice submitted. Your final invoice is on its way.");
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (!booking) return <p>Loading...</p>;

  const canGiveNotice = ["ACTIVE", "RENEWING", "SUSPENDED"].includes(booking.status);

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Booking {booking.id.slice(0, 8)}</h1>
        <p className="mt-1 text-brand-700/70">Status: {booking.status}</p>
      </div>

      {canGiveNotice && (
        <form onSubmit={giveNotice} className="space-y-4 rounded-xl border border-brand-600/10 bg-white p-6">
          <h3 className="font-medium">Give termination notice</h3>
          <input
            type="date"
            required
            value={noticeDate}
            onChange={(e) => setNoticeDate(e.target.value)}
            className="w-full rounded border border-brand-600/20 px-3 py-2"
          />
          {message && <p className="text-sm">{message}</p>}
          <button disabled={busy} className="w-full rounded bg-brand-700 py-2 font-medium text-white disabled:opacity-50">
            {busy ? "Submitting..." : "Submit notice"}
          </button>
        </form>
      )}
    </div>
  );
}
