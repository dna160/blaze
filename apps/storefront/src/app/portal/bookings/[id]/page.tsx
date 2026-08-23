"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AssetTypeDto, BookingDto, ContractDto, InvoiceDto, SwapRequestDto } from "@rentos/contracts";

import { apiFetch, apiUpload, ApiError, openPdf } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { formatDateId, formatIDR, getClientTenantSlug } from "@/lib/tenant-client";

const TENANT_SLUG = getClientTenantSlug();

type BookingDetail = BookingDto & {
  assetType?: { name: string };
  asset?: { code: string } | null;
  location?: { name: string; address: string | null } | null;
};

const STATUS_COPY: Record<string, { title: string; body: string }> = {
  WAITLISTED: { title: "You're on the waitlist", body: "This size is full for your dates. We'll message you the moment a unit frees up — nothing to do for now." },
  PENDING_APPROVAL: { title: "Awaiting confirmation", body: "Our team is reviewing your request. You'll get a message with the next step shortly." },
  APPROVED: { title: "Approved", body: "Next: verify your identity if you haven't, then we send your contract and proforma invoice." },
  ACTIVE: { title: "Active", body: "Your unit is yours. Upcoming payments are listed below." },
  RENEWING: { title: "Payment due", body: "A monthly invoice is waiting — pay it below to keep everything on track." },
  SUSPENDED: { title: "Suspended", body: "A payment is overdue and access is paused. Paying the outstanding invoice restores it." },
  NOTICE_GIVEN: { title: "Ending", body: "Your termination notice is recorded." },
  MOVED_OUT: { title: "Ended", body: "Thanks for storing with us. Your deposit refund is being processed." },
  EXPIRED: { title: "Request expired", body: "This request wasn't confirmed in time. You can submit a new one any time." },
  REJECTED: { title: "Not approved", body: "We couldn't process this request." },
};

/** PRD §7.1.4 customer portal booking detail + PRD v2: term, payment schedule, contract/proforma PDFs, KYC nudge. */
export default function BookingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [contract, setContract] = useState<ContractDto | null | undefined>(undefined);
  const [invoices, setInvoices] = useState<InvoiceDto[]>([]);
  const [kycStatus, setKycStatus] = useState<string | null>(null);
  const [assetTypes, setAssetTypes] = useState<AssetTypeDto[] | null>(null);
  const [swapRequests, setSwapRequests] = useState<SwapRequestDto[]>([]);
  const [noticeDate, setNoticeDate] = useState("");
  const [signedByName, setSignedByName] = useState("");
  const [swapAssetTypeId, setSwapAssetTypeId] = useState("");
  const [swapReason, setSwapReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push(`/login?next=/portal/bookings/${id}`);
      return;
    }
    try {
      const [b, me, mine] = await Promise.all([
        apiFetch<BookingDetail>(`/bookings/${id}`, { tenantSlug: TENANT_SLUG, token }),
        apiFetch<{ kycStatus: string }>("/customers/me", { tenantSlug: TENANT_SLUG, token }),
        apiFetch<InvoiceDto[]>("/invoices/mine", { tenantSlug: TENANT_SLUG, token }),
      ]);
      setBooking(b);
      setKycStatus(me.kycStatus);
      setInvoices(mine.filter((i) => i.bookingId === b.id).sort((a, c) => (a.scheduleIndex ?? 99) - (c.scheduleIndex ?? 99)));
      if (!["DRAFT", "WAITLISTED", "PENDING_APPROVAL", "NEEDS_INFO"].includes(b.status)) {
        const c = await apiFetch<ContractDto | null>(`/contracts/by-booking/${id}`, { tenantSlug: TENANT_SLUG, token });
        setContract(c);
      }
      if (["ACTIVE", "RENEWING"].includes(b.status)) {
        const [types, swaps] = await Promise.all([
          apiFetch<AssetTypeDto[]>("/catalog/asset-types", { tenantSlug: TENANT_SLUG, token }),
          apiFetch<SwapRequestDto[]>(`/swap-requests/by-booking/${id}`, { tenantSlug: TENANT_SLUG, token }),
        ]);
        setAssetTypes(types.filter((t) => t.id !== b.assetTypeId && t.bookingModel === b.bookingModel));
        setSwapRequests(swaps);
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
      setMessage(booking?.termMonths ? "Notice recorded. Payments after that date are cancelled." : "Termination notice submitted. Your final invoice is on its way.");
      await load();
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

  async function requestSwap(e: React.FormEvent) {
    e.preventDefault();
    const token = authClient.getToken();
    if (!token || !swapAssetTypeId) return;
    setSwapping(true);
    setError(null);
    try {
      await apiFetch("/swap-requests", {
        tenantSlug: TENANT_SLUG,
        token,
        method: "POST",
        body: { bookingId: id, requestedAssetTypeId: swapAssetTypeId, reason: swapReason || undefined },
      });
      setSwapAssetTypeId("");
      setSwapReason("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit swap request.");
    } finally {
      setSwapping(false);
    }
  }

  function open(path: string) {
    const token = authClient.getToken();
    if (token) openPdf(path, { tenantSlug: TENANT_SLUG, token }).catch(() => setError("Could not open the PDF."));
  }

  if (!booking) return <p>Loading...</p>;

  const copy = STATUS_COPY[booking.status] ?? { title: booking.status, body: "" };
  const canGiveNotice = ["ACTIVE", "RENEWING", "SUSPENDED"].includes(booking.status);
  const esignPending = contract?.esignStatus === "PENDING";
  const canSignContract = booking.status === "APPROVED" && contract && !contract.signedAt && !esignPending;
  const hasPendingSwap = swapRequests.some((s) => s.status === "PENDING");
  const canRequestSwap = ["ACTIVE", "RENEWING"].includes(booking.status) && assetTypes && assetTypes.length > 0 && !hasPendingSwap;
  const needsKyc = booking.status === "APPROVED" && kycStatus !== "VERIFIED";
  const proforma = invoices.find((i) => i.scheduleIndex === 0) ?? invoices[0];

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <Link href="/portal" className="text-sm text-brand-700/60 hover:text-accent-500">
          ← My rentals
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">
          {booking.assetType?.name ?? "Booking"}
          {booking.asset?.code ? ` — unit ${booking.asset.code}` : ""}
        </h1>
        <p className="text-sm text-brand-700/60">
          {booking.location?.name ? `${booking.location.name} · ` : ""}
          {formatDateId(booking.startDate)}
          {booking.endDate ? ` → ${formatDateId(booking.endDate)}` : ""}
          {booking.termMonths ? ` · ${booking.termMonths}-month term` : ""}
        </p>
      </div>

      <div className="rounded-xl border border-brand-600/10 bg-white p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-accent-500">{copy.title}</p>
        <p className="mt-1 text-sm text-brand-700/70">{copy.body}</p>
        {needsKyc && (
          <Link href="/portal/kyc" className="mt-3 inline-block rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white">
            {kycStatus === "PENDING_REVIEW" ? "Identity documents under review" : "Verify your identity"}
          </Link>
        )}
        {booking.status === "APPROVED" && kycStatus === "VERIFIED" && !proforma && (
          <p className="mt-2 text-sm text-brand-700/70">Identity verified — we&apos;re preparing your contract and proforma invoice.</p>
        )}
      </div>

      {invoices.length > 0 && (
        <div className="rounded-xl border border-brand-600/10 bg-white p-6">
          <h3 className="font-medium">{booking.termMonths ? "Payment schedule" : "Invoices"}</h3>
          <ul className="mt-3 divide-y divide-brand-600/10 text-sm">
            {invoices.map((inv) => {
              const payable = inv.status === "ISSUED" || inv.status === "OVERDUE";
              return (
                <li key={inv.id} className="flex items-center justify-between py-2">
                  <div>
                    <p className="font-medium">
                      {inv.scheduleIndex === 0 ? "First payment (proforma)" : inv.scheduleIndex !== null && inv.scheduleIndex !== undefined ? `Payment ${inv.scheduleIndex + 1}` : inv.invoiceNumber}
                    </p>
                    <p className="text-xs text-brand-700/60">
                      Due {formatDateId(inv.dueDate)} · {inv.status === "SCHEDULED" ? "scheduled" : inv.status.toLowerCase()}
                    </p>
                  </div>
                  <div className="text-right">
                    <p>{formatIDR(inv.totalAmount)}</p>
                    <Link href={`/portal/invoices/${inv.id}`} className={`text-xs ${payable ? "font-medium text-accent-500" : "text-brand-700/60"} underline`}>
                      {payable ? "Pay now" : "View"}
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {contract && (
        <div className="rounded-xl border border-brand-600/10 bg-white p-6">
          <h3 className="font-medium">Rental agreement</h3>
          {contract.unsignedDocumentUrl && (
            <button type="button" onClick={() => open(`/contracts/${contract.id}/document`)} className="mt-2 text-sm text-accent-500 underline">
              Download the agreement (PDF)
            </button>
          )}
          {contract.signedAt ? (
            <p className="mt-2 text-sm text-green-700">
              Signed by {contract.signedByName} on {new Date(contract.signedAt).toLocaleDateString("id-ID")}.
            </p>
          ) : esignPending ? (
            <p className="mt-2 text-sm text-amber-700">
              Sent for e-signature via {contract.esignProvider} — waiting for the signature to complete.
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
            Print the agreement above, sign it, and upload a photo or scan (PDF/JPEG/PNG).
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
          <h3 className="font-medium">{booking.termMonths ? "End your rental early" : "Give termination notice"}</h3>
          {booking.termMonths && (
            <p className="text-sm text-brand-700/60">
              Your term runs to {booking.endDate ? formatDateId(booking.endDate) : "its end date"}. Ending early cancels the payments after the date you choose; invoices already issued still apply.
            </p>
          )}
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

      {swapRequests.length > 0 && (
        <div className="rounded-xl border border-brand-600/10 bg-white p-6">
          <h3 className="font-medium">Swap requests</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {swapRequests.map((s) => (
              <li key={s.id} className="flex items-center justify-between">
                <span>{s.reason ?? "Upgrade/downsize request"}</span>
                <span className="text-brand-700/60">{s.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {canRequestSwap && (
        <form onSubmit={requestSwap} className="space-y-4 rounded-xl border border-brand-600/10 bg-white p-6">
          <h3 className="font-medium">Request an upgrade or downsize</h3>
          <select
            required
            value={swapAssetTypeId}
            onChange={(e) => setSwapAssetTypeId(e.target.value)}
            className="w-full rounded border border-brand-600/20 px-3 py-2"
          >
            <option value="">Choose a unit type...</option>
            {assetTypes!.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <input
            value={swapReason}
            onChange={(e) => setSwapReason(e.target.value)}
            placeholder="Reason (optional)"
            className="w-full rounded border border-brand-600/20 px-3 py-2"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button disabled={swapping} className="w-full rounded bg-brand-700 py-2 font-medium text-white disabled:opacity-50">
            {swapping ? "Submitting..." : "Request swap"}
          </button>
        </form>
      )}
    </div>
  );
}
