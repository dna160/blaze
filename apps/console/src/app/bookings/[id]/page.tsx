"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { BookingDto, ContractDto } from "@rentos/contracts";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, apiUpload, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

interface BookingWithRelations extends BookingDto {
  customer: { fullName: string | null; phone: string };
  assetType: { name: string };
  asset: { code: string } | null;
}

/** Staff-side booking detail — contract status + upload-on-customer's-behalf for a paper contract collected in person (PRD §5.3). */
export default function BookingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [booking, setBooking] = useState<BookingWithRelations | null>(null);
  const [contract, setContract] = useState<ContractDto | null>(null);
  const [signedByName, setSignedByName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const b = await apiFetch<BookingWithRelations>(`/bookings/${id}`, { token });
      setBooking(b);
      if (b.status !== "DRAFT" && b.status !== "PENDING_APPROVAL" && b.status !== "NEEDS_INFO") {
        const c = await apiFetch<ContractDto | null>(`/contracts/by-booking/${id}`, { token });
        setContract(c);
      }
    } catch {
      router.push("/bookings");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function uploadOnBehalf(file: File) {
    const token = authClient.getToken();
    if (!token || !signedByName) return;
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("signedByName", signedByName);
      formData.append("file", file);
      await apiUpload(`/contracts/by-booking/${id}/sign`, token, formData);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  if (!booking) {
    return (
      <ConsoleShell>
        <p>Loading...</p>
      </ConsoleShell>
    );
  }

  const esignPending = contract?.esignStatus === "PENDING";
  const canUploadContract = booking.status === "APPROVED" && contract && !contract.signedAt && !esignPending;

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">{booking.customer.fullName ?? booking.customer.phone}</h1>
      <p className="mt-1 text-sm text-brand-700/60">
        {booking.assetType.name} {booking.asset ? `— unit ${booking.asset.code}` : ""} · Status: {booking.status}
      </p>

      {contract && (
        <div className="mt-6 rounded-lg border border-brand-600/10 bg-white p-5">
          <h2 className="font-medium">Rental agreement</h2>
          {contract.signedAt ? (
            <p className="mt-2 text-sm text-green-700">
              Signed by {contract.signedByName} on {new Date(contract.signedAt).toLocaleDateString("id-ID")}.
            </p>
          ) : esignPending ? (
            <p className="mt-2 text-sm text-amber-700">
              Sent for e-signature via {contract.esignProvider} — waiting for the signature to complete.
            </p>
          ) : (
            <p className="mt-2 text-sm text-brand-700/60">Not signed yet — waiting on the customer, or record one collected in person below.</p>
          )}

          {canUploadContract && (
            <div className="mt-4 space-y-2 border-t border-brand-600/10 pt-4">
              <p className="text-sm font-medium">Record a paper contract collected in person</p>
              <input
                required
                value={signedByName}
                onChange={(e) => setSignedByName(e.target.value)}
                placeholder="Signed by (full name)"
                className="w-full rounded border border-brand-600/20 px-2 py-1 text-sm"
              />
              <input
                type="file"
                accept="application/pdf,image/jpeg,image/png"
                disabled={uploading || !signedByName}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) uploadOnBehalf(file);
                }}
                className="w-full text-sm"
              />
              {error && <p className="text-sm text-red-600">{error}</p>}
              {uploading && <p className="text-xs text-brand-700/60">Uploading...</p>}
            </div>
          )}
        </div>
      )}
    </ConsoleShell>
  );
}
