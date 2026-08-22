"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { BookingDto } from "@rentos/contracts";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

interface BookingWithRelations extends BookingDto {
  customer: { id: string; fullName: string | null; phone: string; kycStatus: string };
  assetType: { id: string; name: string };
  asset: { id: string; code: string } | null;
}

/** PRD §7.2.1 Approval Workbench: single queue, full context, approve/reject/request-info. */
export default function BookingsPage() {
  const router = useRouter();
  const [bookings, setBookings] = useState<BookingWithRelations[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const data = await apiFetch<BookingWithRelations[]>("/bookings/pending", { token });
      setBookings(data);
    } catch {
      authClient.clear();
      router.push("/login");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function approve(id: string) {
    const token = authClient.getToken();
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/bookings/${id}/approve`, { token, method: "POST", body: {} });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Approval failed.");
    } finally {
      setBusyId(null);
    }
  }

  async function reject(id: string) {
    const reason = window.prompt("Rejection reason?");
    if (!reason) return;
    const token = authClient.getToken();
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/bookings/${id}/reject`, { token, method: "POST", body: { reason } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Rejection failed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">Approval Workbench</h1>
      <p className="mt-1 text-sm text-brand-700/60">Bookings awaiting a decision, oldest first.</p>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {!bookings ? (
        <p className="mt-6">Loading...</p>
      ) : bookings.length === 0 ? (
        <p className="mt-6 text-brand-700/60">Nothing pending — queue is clear.</p>
      ) : (
        <div className="mt-6 space-y-4">
          {bookings.map((b) => (
            <div key={b.id} className="rounded-lg border border-brand-600/10 bg-white p-5">
              <div className="flex items-start justify-between">
                <div>
                  <Link href={`/bookings/${b.id}`} className="font-medium hover:underline">
                    {b.customer.fullName ?? b.customer.phone}
                  </Link>
                  <p className="text-sm text-brand-700/60">{b.customer.phone}</p>
                  <p className="mt-2 text-sm">
                    {b.assetType.name} {b.asset ? `— unit ${b.asset.code}` : ""}
                  </p>
                  <p className="text-sm text-brand-700/60">
                    Move-in {new Date(b.startDate).toLocaleDateString("id-ID")} · KYC: {b.customer.kycStatus}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => approve(b.id)}
                    disabled={busyId === b.id}
                    className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => reject(b.id)}
                    disabled={busyId === b.id}
                    className="rounded border border-red-300 px-4 py-2 text-sm font-medium text-red-600 disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </ConsoleShell>
  );
}
