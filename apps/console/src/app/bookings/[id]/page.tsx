"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { BookingDto, ContractDto, InvoiceDto, PipelineBookingDto } from "@rentos/contracts";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, apiFetchBlob, apiUpload, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

interface BookingWithRelations extends BookingDto {
  customer: { id: string; fullName: string | null; phone: string | null; email: string | null; kycStatus: string; preferredChannel: string };
  assetType: { name: string };
  asset: { code: string } | null;
  location: { name: string } | null;
  events: Array<{ id: string; fromStatus: string | null; toStatus: string; actorType: string; reason: string | null; createdAt: string }>;
}

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}
function fmtDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" }) : "—";
}

/** Staff-side booking detail — contract status + upload-on-customer's-behalf for a paper contract collected in person (PRD §5.3). */
export default function BookingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [booking, setBooking] = useState<BookingWithRelations | null>(null);
  const [contract, setContract] = useState<ContractDto | null>(null);
  const [pipeline, setPipeline] = useState<PipelineBookingDto | null>(null);
  const [invoices, setInvoices] = useState<InvoiceDto[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [signedByName, setSignedByName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stayActionBusy, setStayActionBusy] = useState(false);

  async function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const b = await apiFetch<BookingWithRelations>(`/bookings/${id}`, { token });
      setBooking(b);
      if (!["DRAFT", "WAITLISTED", "PENDING_APPROVAL", "NEEDS_INFO"].includes(b.status)) {
        const c = await apiFetch<ContractDto | null>(`/contracts/by-booking/${id}`, { token });
        setContract(c);
      }
      // Pipeline stage + the booking's invoices (schedule) — both tolerate failure so the page still renders.
      apiFetch<PipelineBookingDto[]>("/bookings/pipeline", { token })
        .then((rows) => setPipeline(rows.find((r) => r.id === id) ?? null))
        .catch(() => setPipeline(null));
      apiFetch<InvoiceDto[]>("/invoices", { token })
        .then((all) => setInvoices(all.filter((i) => i.bookingId === id).sort((a, c) => (a.scheduleIndex ?? 99) - (c.scheduleIndex ?? 99))))
        .catch(() => setInvoices([]));
    } catch {
      router.push("/bookings");
    }
  }

  async function pipelineAction(path: string, success: string) {
    const token = authClient.getToken();
    if (!token) return;
    setStayActionBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/bookings/${id}/${path}`, { token, method: "POST", body: {} });
      setNotice(success);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Action failed.");
    } finally {
      setStayActionBusy(false);
    }
  }

  async function openContractPdf() {
    const token = authClient.getToken();
    if (!token || !contract) return;
    try {
      const blob = await apiFetchBlob(`/contracts/${contract.id}/document`, token);
      window.open(URL.createObjectURL(blob), "_blank", "noopener");
    } catch {
      setError("Could not open the agreement PDF.");
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

  async function performStayAction(action: "check-in" | "check-out" | "pickup" | "return" | "complete-inspection") {
    const token = authClient.getToken();
    if (!token) return;
    setStayActionBusy(true);
    setError(null);
    try {
      await apiFetch(`/bookings/${id}/${action}`, { token, method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${action.replace("-", " ")}.`);
    } finally {
      setStayActionBusy(false);
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

  const isTermLease = booking.bookingModel === "RECURRING_LEASE" && Boolean(booking.termMonths);
  const stage = pipeline?.pipelineStage;

  return (
    <ConsoleShell>
      <Link href="/bookings" className="text-sm text-brand-700/60 hover:underline">
        ← Workbench
      </Link>
      <h1 className="mt-1 text-2xl font-semibold">
        <Link href={`/clients/${booking.customer.id}`} className="hover:underline">
          {booking.customer.fullName ?? booking.customer.phone ?? booking.customer.email}
        </Link>
      </h1>
      <p className="mt-1 text-sm text-brand-700/60">
        {booking.assetType.name} {booking.asset ? `— unit ${booking.asset.code}` : "— no unit assigned"}
        {booking.location ? ` · ${booking.location.name}` : ""} · {fmtDate(booking.startDate)}
        {booking.endDate ? ` → ${fmtDate(booking.endDate)}` : ""}
        {booking.termMonths ? ` · ${booking.termMonths}-month term` : ""} · Status: {booking.status}
      </p>
      <p className="text-xs text-brand-700/50">
        {booking.customer.phone ?? "no phone"} · {booking.customer.email ?? "no email"} · messages via {booking.customer.preferredChannel === "EMAIL" ? "email" : "WhatsApp"} · KYC {booking.customer.kycStatus}
      </p>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {notice && <p className="mt-2 text-sm text-green-700">{notice}</p>}

      {isTermLease && pipeline && stage && stage !== "ACTIVE" && stage !== "CLOSED" && (
        <div className="mt-6 rounded-lg border border-brand-600/10 bg-white p-5">
          <h2 className="font-medium">Pipeline — {stage.replace("_", " ")}</h2>
          <p className="mt-1 text-sm text-brand-700/60">{pipeline.stageDetail}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {stage === "WAITLIST" && (
              <button onClick={() => pipelineAction("offer-unit", "Unit offered — the customer has been told.")} disabled={stayActionBusy} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                Offer unit
              </button>
            )}
            {stage === "APPROVAL" && (
              <button onClick={() => pipelineAction("approve", "Approved — the customer has been asked to verify their identity.")} disabled={stayActionBusy} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                Approve
              </button>
            )}
            {stage === "KYC" && (
              <button onClick={() => pipelineAction("request-kyc", "KYC request sent.")} disabled={stayActionBusy} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {booking.kycRequestedAt ? "Re-send KYC request" : "Request KYC"}
              </button>
            )}
            {stage === "CONTRACT" && (
              <button onClick={() => pipelineAction("generate-contract", "Contract + proforma generated and sent.")} disabled={stayActionBusy} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                Generate contract + proforma
              </button>
            )}
            {stage === "FINANCE" && pipeline.firstInvoice && (
              <Link href={`/invoices/${pipeline.firstInvoice.id}`} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white">
                Open proforma {pipeline.firstInvoice.invoiceNumber}
              </Link>
            )}
          </div>
        </div>
      )}

      {invoices.length > 0 && (
        <div className="mt-6 rounded-lg border border-brand-600/10 bg-white p-5">
          <h2 className="font-medium">{isTermLease ? "Payment schedule" : "Invoices"}</h2>
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs text-brand-700/60">
              <tr>
                <th className="py-1">#</th>
                <th className="py-1">Invoice</th>
                <th className="py-1">Period</th>
                <th className="py-1">Due</th>
                <th className="py-1">Status</th>
                <th className="py-1 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-t border-brand-600/10">
                  <td className="py-1">{inv.scheduleIndex !== null && inv.scheduleIndex !== undefined ? inv.scheduleIndex + 1 : "—"}</td>
                  <td className="py-1">
                    <Link href={`/invoices/${inv.id}`} className="hover:underline">
                      {inv.invoiceNumber}
                    </Link>
                  </td>
                  <td className="py-1 text-xs text-brand-700/60">
                    {inv.periodStart && inv.periodEnd ? `${fmtDate(inv.periodStart)} – ${fmtDate(inv.periodEnd)}` : "—"}
                  </td>
                  <td className="py-1">{fmtDate(inv.dueDate)}</td>
                  <td className="py-1">{inv.status}</td>
                  <td className="py-1 text-right">{formatIDR(inv.totalAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {booking.bookingModel === "NIGHTLY" && (booking.status === "PAID" || booking.status === "CHECKED_IN") && (
        <div className="mt-6 rounded-lg border border-brand-600/10 bg-white p-5">
          <h2 className="font-medium">Stay</h2>
          {booking.status === "PAID" ? (
            <>
              <p className="mt-2 text-sm text-brand-700/60">Paid in full — ready for the guest to check in.</p>
              <button
                onClick={() => performStayAction("check-in")}
                disabled={stayActionBusy}
                className="mt-3 rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {stayActionBusy ? "Checking in..." : "Check in"}
              </button>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm text-brand-700/60">Guest is checked in. Check out to close this stay.</p>
              <button
                onClick={() => performStayAction("check-out")}
                disabled={stayActionBusy}
                className="mt-3 rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {stayActionBusy ? "Checking out..." : "Check out"}
              </button>
            </>
          )}
        </div>
      )}

      {booking.bookingModel === "DURATION_ORDER" &&
        (booking.status === "PAID" ||
          booking.status === "PICKED_UP" ||
          booking.status === "RETURNED" ||
          booking.status === "INSPECTION") && (
          <div className="mt-6 rounded-lg border border-brand-600/10 bg-white p-5">
            <h2 className="font-medium">Order</h2>
            {booking.status === "PAID" && (
              <>
                <p className="mt-2 text-sm text-brand-700/60">Paid in full — ready for pickup.</p>
                <button
                  onClick={() => performStayAction("pickup")}
                  disabled={stayActionBusy}
                  className="mt-3 rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {stayActionBusy ? "Recording pickup..." : "Mark picked up"}
                </button>
              </>
            )}
            {booking.status === "PICKED_UP" && (
              <>
                <p className="mt-2 text-sm text-brand-700/60">Equipment is out with the customer.</p>
                <button
                  onClick={() => performStayAction("return")}
                  disabled={stayActionBusy}
                  className="mt-3 rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {stayActionBusy ? "Recording return..." : "Mark returned"}
                </button>
              </>
            )}
            {booking.status === "INSPECTION" && (
              <>
                <p className="mt-2 text-sm text-brand-700/60">
                  Returned — under inspection. Apply any damage deductions via the deposit before closing, if
                  needed.
                </p>
                <button
                  onClick={() => performStayAction("complete-inspection")}
                  disabled={stayActionBusy}
                  className="mt-3 rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {stayActionBusy ? "Closing..." : "Complete inspection"}
                </button>
              </>
            )}
          </div>
        )}

      {contract && (
        <div className="mt-6 rounded-lg border border-brand-600/10 bg-white p-5">
          <h2 className="font-medium">Rental agreement</h2>
          {contract.unsignedDocumentUrl && (
            <button onClick={openContractPdf} className="mt-1 text-sm text-accent-500 underline">
              Open generated agreement (PDF)
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

      {booking.events.length > 0 && (
        <div className="mt-6 rounded-lg border border-brand-600/10 bg-white p-5">
          <h2 className="font-medium">Timeline</h2>
          <ul className="mt-2 space-y-1 text-xs">
            {booking.events.map((e) => (
              <li key={e.id} className="flex justify-between gap-3 border-t border-brand-600/10 py-1">
                <span>
                  {e.fromStatus ? `${e.fromStatus} → ` : ""}
                  <span className="font-medium">{e.toStatus}</span>
                  {e.reason ? ` — ${e.reason}` : ""}
                </span>
                <span className="shrink-0 text-brand-700/50">
                  {e.actorType.toLowerCase()} · {new Date(e.createdAt).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ConsoleShell>
  );
}
