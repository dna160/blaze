"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { BookingDto, ContractDto } from "@rentos/contracts";

import { apiFetch, apiUpload, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

const TENANT_SLUG = process.env.NEXT_PUBLIC_DEV_TENANT_SLUG ?? "";

/** PRD §7.1.4: self-service "give termination notice" + contract signing (PRD §5.3, wet-sign PDF v1). */
export default function BookingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [booking, setBooking] = useState<BookingDto | null>(null);
  const [contract, setContract] = useState<ContractDto | null | undefined>(undefined);
  const [noticeDate, setNoticeDate] = useState("");
  const [signedByName, setSignedByName] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const b = await apiFetch<BookingDto>(`/bookings/${id}`, { tenantSlug: TENANT_SLUG, token });
      setBooking(b);
      if (b.status !== "DRAFT" && b.status !== "PENDING_APPROVAL" && b.status !== "NEEDS_INFO") {
        const c = await apiFetch<ContractDto | null>(`/contracts/by-booking/${id}`, { tenantSlug: TENANT_SLUG, token });
        setContract(c);
      }
    } catch {
      router.push("/portal");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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

  async function signContract(file: File) {
    const token = authClient.getToken();
    if (!token || !signedByName) return;
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("signedByName", signedByName);
      formData.append("file", file);
      await apiUpload(`/contracts/by-booking/${id}/sign`, { tenantSlug: TENANT_SLUG, token, formData });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  if (!booking) return <p>Loading...</p>;

  const canGiveNotice = ["ACTIVE", "RENEWING", "SUSPENDED"].includes(booking.status);
  const canSignContract = booking.status === "APPROVED" && contract && !contract.signedAt;

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Booking {booking.id.slice(0, 8)}</h1>
        <p className="mt-1 text-brand-700/70">Status: {booking.status}</p>
      </div>

      {contract && (
        <div className="rounded-xl border border-brand-600/10 bg-white p-6">
          <h3 className="font-medium">Rental agreement</h3>
          {contract.signedAt ? (
            <p className="mt-2 text-sm text-green-700">
              Signed by {contract.signedByName} on {new Date(contract.signedAt).toLocaleDateString("id-ID")}.
            </p>
          ) : (
            <p className="mt-2 text-sm text-brand-700/60">Not signed yet.</p>
          )}
        </div>
      )}

      {canSignContract && (
        <div className="space-y-4 rounded-xl border border-brand-600/10 bg-white p-6">
          <h3 className="font-medium">Sign your rental agreement</h3>
          <p className="text-sm text-brand-700/60">
            Print, sign, and upload a photo or scan (wet-sign PDF/JPEG/PNG accepted in v1).
          </p>
          <input
            required
            value={signedByName}
            onChange={(e) => setSignedByName(e.target.value)}
            placeholder="Full legal name"
            className="w-full rounded border border-brand-600/20 px-3 py-2"
          />
          <input
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            disabled={uploading || !signedByName}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) signContract(file);
            }}
            className="w-full text-sm"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          {uploading && <p className="text-xs text-brand-700/60">Uploading...</p>}
        </div>
      )}

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
