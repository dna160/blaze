"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ClientListItem } from "@rentos/contracts";

import { HEALTH_STYLE } from "@/components/ClientList";
import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, apiFetchBlob, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { canDo } from "@/lib/capabilities";

interface ClientDetail {
  customer: {
    id: string;
    fullName: string | null;
    phone: string | null;
    email: string | null;
    type: "INDIVIDUAL" | "BUSINESS";
    companyName: string | null;
    taxId: string | null;
    nib: string | null;
    pphWithheld: boolean | null;
    pphType: "PPH_4_2_FINAL" | "PPH_23" | null;
    address: string | null;
    customerNumber: number | null;
    preferredChannel: "WHATSAPP" | "EMAIL";
    kycStatus: string;
    isBlocklisted: boolean;
    blocklistReason: string | null;
    notes: string | null;
    createdAt: string;
    bookings: Array<{
      id: string;
      status: string;
      startDate: string;
      endDate: string | null;
      termMonths: number | null;
      legacyBookingNumber: string | null;
      paidThrough: string | null;
      asset: { id: string; code: string } | null;
      assetType: { id: string; name: string };
      location: { id: string; name: string } | null;
      invoices: Array<{ id: string; invoiceNumber: string; status: string; scheduleIndex: number | null; dueDate: string; totalAmount: string; paidAt: string | null; payments: Array<{ id: string; method: string; status: string; amount: string; paidAt: string | null }> }>;
      deposits: Array<{ id: string; amount: string; status: string; appliedAmount: string }>;
      contracts: Array<{ id: string; contractNumber: string | null; signedAt: string | null; confirmedAt: string | null; unsignedDocumentUrl: string | null }>;
    }>;
    kycDocuments: Array<{ id: string; documentType: string; status: string; createdAt: string }>;
  };
  summary: ClientListItem | null;
  notifications: Array<{ id: string; templateKey: string; channel: string; status: string; recipient: string; createdAt: string }>;
}

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}
function fmtDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" }) : "—";
}
function fmtDateTime(value: string): string {
  return new Date(value).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** PRD go-live §7.4 — GET /customers/:id/documents. */
interface VaultDocument {
  kind: "CONTRACT" | "SIGNED_CONTRACT" | "INVOICE" | "PAYMENT_PROOF" | "KYC";
  label: string;
  detail: string | null;
  status: string | null;
  date: string;
  href: string;
}

const KIND_LABEL: Record<VaultDocument["kind"], string> = {
  CONTRACT: "Contract (generated)",
  SIGNED_CONTRACT: "Contract (signed)",
  INVOICE: "Invoice",
  PAYMENT_PROOF: "Payment proof",
  KYC: "KYC",
};

function kycLabel(status: string): string {
  return status === "VERIFIED_LEGACY" ? "Verified (legacy)" : status;
}

const PPH_TYPES = [
  { value: "PPH_4_2_FINAL", label: "PPh Final 4(2) 10%" },
  { value: "PPH_23", label: "PPh 23 2%" },
] as const;

/**
 * PRD go-live §8.2 — "Apakah akan memotong PPh?" plus the type, NPWP and the
 * address printed on documents. Staff correct what the customer answered;
 * every change is audited by the API.
 */
function TaxPanel({ customer, canEdit, onSaved }: { customer: ClientDetail["customer"]; canEdit: boolean; onSaved: () => void }) {
  const [withheld, setWithheld] = useState<"yes" | "no" | "unknown">(
    customer.pphWithheld === null ? "unknown" : customer.pphWithheld ? "yes" : "no",
  );
  const [pphType, setPphType] = useState<string>(customer.pphType ?? "");
  const [taxId, setTaxId] = useState(customer.taxId ?? "");
  const [address, setAddress] = useState(customer.address ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await apiFetch(`/customers/${customer.id}/tax-profile`, {
        token: authClient.getToken(),
        method: "PATCH",
        body: {
          pphWithheld: withheld === "unknown" ? null : withheld === "yes",
          pphType: pphType || null,
          taxId: taxId.trim() || null,
          address: address.trim() || null,
        },
      });
      setMsg("Saved.");
      onSaved();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3 rounded-lg border border-brand-600/10 bg-white p-4 text-sm">
      <h2 className="text-lg font-medium">Tax &amp; billing details</h2>
      <fieldset className="space-y-1" disabled={!canEdit}>
        <legend className="font-medium">Apakah akan memotong PPh? / Will the company withhold PPh?</legend>
        <div className="flex gap-4">
          {(["yes", "no", "unknown"] as const).map((v) => (
            <label key={v} className="flex items-center gap-1.5">
              <input type="radio" name="pph" checked={withheld === v} onChange={() => setWithheld(v)} />
              {v === "yes" ? "Ya / Yes" : v === "no" ? "Tidak / No" : "Belum dijawab / Not answered"}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block">
        <span className="text-brand-700/70">PPh type</span>
        <select
          value={pphType}
          onChange={(e) => setPphType(e.target.value)}
          disabled={!canEdit || withheld !== "yes"}
          className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2 disabled:bg-brand-700/5"
        >
          <option value="">Default (PPh Final 4(2) for space rental)</option>
          {PPH_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-brand-700/70">NPWP</span>
        <input value={taxId} onChange={(e) => setTaxId(e.target.value)} disabled={!canEdit} className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2 disabled:bg-brand-700/5" />
      </label>
      <label className="block">
        <span className="text-brand-700/70">Address (printed on contracts and invoices)</span>
        <textarea value={address} onChange={(e) => setAddress(e.target.value)} disabled={!canEdit} rows={2} maxLength={300} className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2 disabled:bg-brand-700/5" />
      </label>
      <p className="text-xs text-brand-700/60">
        The invoice total never changes: a withholding customer transfers the total minus the PPh and sends the bukti potong.
      </p>
      {canEdit && (
        <div className="flex items-center gap-3">
          <button disabled={busy} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
          {msg && <span className="text-xs text-brand-700/70">{msg}</span>}
        </div>
      )}
    </form>
  );
}

const INVOICE_STYLE: Record<string, string> = {
  SCHEDULED: "bg-gray-100 text-gray-700",
  ISSUED: "bg-blue-100 text-blue-800",
  OVERDUE: "bg-red-100 text-red-800",
  PAID: "bg-green-100 text-green-800",
  VOID: "bg-gray-200 text-gray-600",
  CREDITED: "bg-amber-100 text-amber-800",
};

/** PRD v2 §5.2 — "When they click on the client they can look closer": profile, rentals with their payment schedules, deposits, KYC, message log. */
export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<ClientDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<VaultDocument[] | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const me = authClient.getUser();
  const canEditTax = canDo(me, "approve_booking") || canDo(me, "record_payment");

  function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    apiFetch<ClientDetail>(`/customers/clients/${id}`, { token })
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load client."));
    apiFetch<VaultDocument[]>(`/customers/${id}/documents`, { token })
      .then(setDocuments)
      .catch((err) => setDocError(err instanceof ApiError ? err.message : "Failed to load documents."));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /**
   * Every document opens in a new tab, whatever its review status. The links
   * are API paths behind the staff token, so the file is fetched as a blob and
   * opened from an object URL (a plain href would not carry the token). The
   * tab is opened first, synchronously, so popup blockers allow it.
   */
  async function openDocument(doc: VaultDocument) {
    const tab = window.open("", "_blank");
    try {
      const blob = await apiFetchBlob(doc.href, authClient.getToken());
      const url = URL.createObjectURL(blob);
      if (tab) tab.location.href = url;
      else window.open(url, "_blank");
    } catch (err) {
      tab?.close();
      setDocError(err instanceof ApiError ? `${doc.label}: ${err.message || `error ${err.status}`}` : `${doc.label}: could not open.`);
    }
  }

  if (error) {
    return (
      <ConsoleShell>
        <p className="text-sm text-red-600">{error}</p>
      </ConsoleShell>
    );
  }
  if (!data) {
    return (
      <ConsoleShell>
        <p>Loading...</p>
      </ConsoleShell>
    );
  }

  const { customer, summary, notifications } = data;
  const health = summary ? HEALTH_STYLE[summary.health] : null;

  return (
    <ConsoleShell>
      <Link href="/clients" className="text-sm text-brand-700/60 hover:underline">
        ← Clients
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            {customer.type === "BUSINESS" && customer.companyName
              ? customer.companyName
              : (customer.fullName ?? customer.phone ?? customer.email)}
          </h1>
          {customer.type === "BUSINESS" && (
            // Surfaced beside the name because it changes how this client is
            // invoiced, not just how they were verified.
            <p className="text-sm text-brand-700/70">
              Company
              {customer.fullName ? ` · signatory ${customer.fullName}` : ""}
              {customer.nib ? ` · NIB ${customer.nib}` : ""}
              {customer.taxId ? ` · NPWP ${customer.taxId}` : ""}
              {" · PPh "}
              {customer.pphWithheld === null
                ? "not answered"
                : customer.pphWithheld
                  ? `withheld${customer.pphType ? ` (${PPH_TYPES.find((t) => t.value === customer.pphType)?.label ?? customer.pphType})` : ""}`
                  : "not withheld"}
            </p>
          )}
          <p className="text-sm text-brand-700/60">
            {customer.phone ?? "no phone"} · {customer.email ?? "no email"} · messages via {customer.preferredChannel === "EMAIL" ? "email" : "WhatsApp"} · KYC {kycLabel(customer.kycStatus)}
            {customer.isBlocklisted ? ` · BLOCKLISTED${customer.blocklistReason ? ` (${customer.blocklistReason})` : ""}` : ""}
          </p>
          <p className="text-xs text-brand-700/40">
            {customer.customerNumber !== null ? `Customer #${customer.customerNumber} · ` : ""}Customer since {fmtDate(customer.createdAt)}
          </p>
        </div>
        {health && summary && (
          <div className="text-right">
            <span className={`rounded-full px-3 py-1 text-sm font-medium ${health.className}`}>{health.label}</span>
            <p className="mt-1 text-xs text-brand-700/60">{health.hint}</p>
            {summary.nextDueDate && (
              <p className="text-xs text-brand-700/60">
                Next due {fmtDate(summary.nextDueDate)} · {summary.nextDueAmount ? formatIDR(summary.nextDueAmount) : ""}
              </p>
            )}
            {Number(summary.outstandingAmount) > 0 && <p className="text-xs text-red-700">Outstanding {formatIDR(summary.outstandingAmount)}</p>}
          </div>
        )}
      </div>

      <section className="mt-8">
        <h2 className="text-lg font-medium">Rentals</h2>
        {customer.bookings.length === 0 && <p className="mt-2 text-sm text-brand-700/60">No rentals yet.</p>}
        <div className="mt-3 space-y-4">
          {customer.bookings.map((b) => (
            <div key={b.id} className="rounded-lg border border-brand-600/10 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <Link href={`/bookings/${b.id}`} className="font-medium hover:underline">
                    {b.contracts[0]?.contractNumber ? `Contract #${b.contracts[0].contractNumber} · ` : ""}
                    {b.assetType.name}
                    {b.asset ? ` — ${b.asset.code}` : ""}
                  </Link>
                  <p className="text-sm text-brand-700/60">
                    {b.location?.name ? `${b.location.name} · ` : ""}
                    {fmtDate(b.startDate)}
                    {b.endDate ? ` → ${fmtDate(b.endDate)}` : " → open-ended"}
                    {b.termMonths ? ` · ${b.termMonths}-month term` : ""}
                    {b.legacyBookingNumber ? ` · legacy booking #${b.legacyBookingNumber}` : ""}
                    {b.paidThrough ? ` · paid through ${fmtDate(b.paidThrough)} (legacy)` : ""}
                  </p>
                </div>
                <span className="rounded-full bg-brand-700/10 px-3 py-1 text-xs font-medium">{b.status}</span>
              </div>

              {b.invoices.length > 0 && (
                <table className="mt-3 w-full text-xs">
                  <thead className="text-left text-brand-700/60">
                    <tr>
                      <th className="py-1">Payment</th>
                      <th className="py-1">Due</th>
                      <th className="py-1">Status</th>
                      <th className="py-1 text-right">Amount</th>
                      <th className="py-1 text-right">Paid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.invoices.map((inv) => (
                      <tr key={inv.id} className="border-t border-brand-600/10">
                        <td className="py-1">
                          <Link href={`/invoices/${inv.id}`} className="hover:underline">
                            {inv.scheduleIndex === 0 ? "Proforma" : inv.scheduleIndex !== null ? `#${inv.scheduleIndex + 1}` : ""}{" "}
                            {inv.invoiceNumber.startsWith("SCHEDULED/") ? "(numbered when issued)" : `Invoice #${inv.invoiceNumber}`}
                          </Link>
                        </td>
                        <td className="py-1">{fmtDate(inv.dueDate)}</td>
                        <td className="py-1">
                          <span className={`rounded-full px-2 py-0.5 ${INVOICE_STYLE[inv.status] ?? ""}`}>{inv.status}</span>
                        </td>
                        <td className="py-1 text-right">{formatIDR(inv.totalAmount)}</td>
                        <td className="py-1 text-right">{inv.paidAt ? fmtDate(inv.paidAt) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {(b.deposits.length > 0 || b.contracts.length > 0) && (
                <p className="mt-2 text-xs text-brand-700/60">
                  {b.deposits.map((d) => `Deposit ${formatIDR(d.amount)} (${d.status}${Number(d.appliedAmount) > 0 ? `, ${formatIDR(d.appliedAmount)} applied` : ""})`).join(" · ")}
                  {b.contracts[0]
                    ? ` · Contract${b.contracts[0].contractNumber ? ` #${b.contracts[0].contractNumber}` : ""} ${
                        b.contracts[0].signedAt
                          ? `signed ${fmtDate(b.contracts[0].signedAt)}${b.contracts[0].confirmedAt ? " · CONFIRMED" : ""}`
                          : b.contracts[0].unsignedDocumentUrl
                            ? "generated, unsigned"
                            : "not generated"
                      }`
                    : ""}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="text-lg font-medium">Documents</h2>
          <p className="text-xs text-brand-700/60">Contracts, invoices, payment proofs and KYC files. Each opens in a new tab; opening a KYC file is logged.</p>
          {customer.customerNumber !== null && (
            <p className="mt-1 text-xs">
              <Link href={`/legacy?customer=${customer.customerNumber}`} className="text-amber-800 underline">
                Legacy records from Booqable for this customer
              </Link>{" "}
              <span className="text-brand-700/60">— past orders, invoices, payments and the original signed contracts.</span>
            </p>
          )}
          {docError && <p className="mt-2 text-sm text-red-600">{docError}</p>}
          {!documents ? (
            !docError && <p className="mt-2 text-sm text-brand-700/60">Loading…</p>
          ) : documents.length === 0 ? (
            <p className="mt-2 text-sm text-brand-700/60">No documents yet.</p>
          ) : (
            <ul className="mt-2 max-h-96 space-y-1 overflow-y-auto text-sm">
              {documents.map((d) => (
                <li key={`${d.kind}-${d.href}`} className="flex items-center justify-between gap-3 rounded border border-brand-600/10 bg-white px-3 py-2">
                  <button onClick={() => void openDocument(d)} className="text-left hover:underline">
                    <span className="block font-medium">{d.label}</span>
                    <span className="block text-xs text-brand-700/60">
                      {KIND_LABEL[d.kind]}
                      {d.detail ? ` · ${d.kind === "INVOICE" || d.kind === "PAYMENT_PROOF" ? formatIDR(d.detail) : d.detail}` : ""}
                    </span>
                  </button>
                  <span className="shrink-0 text-right text-xs text-brand-700/60">
                    {d.status ? `${kycLabel(d.status)} · ` : ""}
                    {fmtDate(d.date)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <TaxPanel customer={customer} canEdit={canEditTax} onSaved={load} />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="text-lg font-medium">KYC documents</h2>
          {customer.kycDocuments.length === 0 ? (
            <p className="mt-2 text-sm text-brand-700/60">Nothing uploaded.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {customer.kycDocuments.map((d) => (
                <li key={d.id} className="flex justify-between rounded border border-brand-600/10 bg-white px-3 py-2">
                  <span>{d.documentType}</span>
                  <span className="text-brand-700/60">
                    {kycLabel(d.status)} · {fmtDate(d.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {customer.notes && <p className="mt-3 rounded bg-brand-700/5 p-3 text-sm">{customer.notes}</p>}
        </section>
        <section>
          <h2 className="text-lg font-medium">Messages sent</h2>
          {notifications.length === 0 ? (
            <p className="mt-2 text-sm text-brand-700/60">No messages yet.</p>
          ) : (
            <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto text-xs">
              {notifications.map((n) => (
                <li key={n.id} className="flex justify-between rounded border border-brand-600/10 bg-white px-3 py-1.5">
                  <span>
                    {n.templateKey} <span className="text-brand-700/50">· {n.channel.toLowerCase()}</span>
                  </span>
                  <span className={n.status === "FAILED" ? "text-red-600" : "text-brand-700/60"}>
                    {n.status} · {fmtDateTime(n.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </ConsoleShell>
  );
}
