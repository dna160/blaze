"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ClientListItem } from "@rentos/contracts";

import { ChangeRequestActions, ChangeRequestPanel } from "@/components/ChangeRequests";
import { HEALTH_STYLE } from "@/components/ClientList";
import { ConsoleShell } from "@/components/ConsoleShell";
import { KycPanel } from "@/components/KycPanel";
import { SignedScanUpload } from "@/components/SignedScanUpload";
import { apiFetch, apiFetchBlob, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { canDo } from "@/lib/capabilities";
import { getLocale, tr, useT } from "@/lib/i18n";

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
      contracts: Array<{ id: string; contractNumber: string | null; signedAt: string | null; confirmedAt: string | null; unsignedDocumentUrl: string | null; signMethod?: string; signDeadlineAt?: string | null; esignStatus?: string | null; createdAt?: string }>;
    }>;
    kycDocuments: Array<{ id: string; documentType: string; status: string; createdAt: string }>;
  };
  summary: ClientListItem | null;
  notifications: Array<{ id: string; templateKey: string; channel: string; status: string; recipient: string; createdAt: string }>;
}

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}
const intl = () => (getLocale() === "en" ? "en-GB" : "id-ID");
function fmtDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString(intl(), { day: "numeric", month: "short", year: "numeric" }) : "—";
}
function fmtDateTime(value: string): string {
  return new Date(value).toLocaleString(intl(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
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

const kindLabel = (k: VaultDocument["kind"]) => tr(`client.kind.${k}`);

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
  const { t } = useT();
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
      setMsg(t("common.saved"));
      onSaved();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : t("client.tax.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3 rounded-lg border border-brand-600/10 bg-white p-4 text-sm">
      <h2 className="text-lg font-medium">{t("client.tax.title")}</h2>
      <fieldset className="space-y-1" disabled={!canEdit}>
        <legend className="font-medium">{t("client.tax.question")}</legend>
        <div className="flex gap-4">
          {(["yes", "no", "unknown"] as const).map((v) => (
            <label key={v} className="flex items-center gap-1.5">
              <input type="radio" name="pph" checked={withheld === v} onChange={() => setWithheld(v)} />
              {t(`client.tax.${v}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block">
        <span className="text-brand-700/70">{t("client.tax.type")}</span>
        <select
          value={pphType}
          onChange={(e) => setPphType(e.target.value)}
          disabled={!canEdit || withheld !== "yes"}
          className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2 disabled:bg-brand-700/5"
        >
          <option value="">{t("client.tax.typeDefault")}</option>
          {PPH_TYPES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-brand-700/70">NPWP</span>
        <input value={taxId} onChange={(e) => setTaxId(e.target.value)} disabled={!canEdit} className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2 disabled:bg-brand-700/5" />
      </label>
      <label className="block">
        <span className="text-brand-700/70">{t("client.tax.address")}</span>
        <textarea value={address} onChange={(e) => setAddress(e.target.value)} disabled={!canEdit} rows={2} maxLength={300} className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2 disabled:bg-brand-700/5" />
      </label>
      <p className="text-xs text-brand-700/60">{t("client.tax.note")}</p>
      {canEdit && (
        <div className="flex items-center gap-3">
          <button disabled={busy} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? t("common.saving") : t("common.save")}
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
  const { t, s } = useT();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<ClientDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<VaultDocument[] | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const me = authClient.getUser();
  const canEditTax = canDo(me, "approve_booking") || canDo(me, "record_payment");
  const canUploadScan = canDo(me, "create_booking") || canDo(me, "approve_booking");
  const [changeReload, setChangeReload] = useState(0);

  function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    apiFetch<ClientDetail>(`/customers/clients/${id}`, { token })
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : t("client.loadFailed")));
    apiFetch<VaultDocument[]>(`/customers/${id}/documents`, { token })
      .then(setDocuments)
      .catch((err) => setDocError(err instanceof ApiError ? err.message : t("client.docsFailed")));
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
      setDocError(err instanceof ApiError ? `${doc.label}: ${err.message || `HTTP ${err.status}`}` : t("client.openFailed", { label: doc.label }));
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
        <p>{t("common.loading")}</p>
      </ConsoleShell>
    );
  }

  const { customer, summary, notifications } = data;
  const health = summary ? { className: HEALTH_STYLE[summary.health].className, label: t(`clients.health.${summary.health}`), hint: t(`clients.health.${summary.health}Hint`) } : null;

  return (
    <ConsoleShell>
      <Link href="/clients" className="text-sm text-brand-700/60 hover:underline">
        {t("client.back")}
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
              {t("client.company")}
              {customer.fullName ? <> · {t("client.signatory", { name: customer.fullName })}</> : null}
              {customer.nib ? ` · NIB ${customer.nib}` : ""}
              {customer.taxId ? ` · NPWP ${customer.taxId}` : ""}
              {" · "}
              {customer.pphWithheld === null
                ? t("client.pphNotAnswered")
                : customer.pphWithheld
                  ? `${t("client.pphWithheld")}${customer.pphType ? ` (${PPH_TYPES.find((p) => p.value === customer.pphType)?.label ?? customer.pphType})` : ""}`
                  : t("client.pphNotWithheld")}
            </p>
          )}
          <p className="text-sm text-brand-700/60">
            {customer.phone ?? t("booking.noPhone")} · {customer.email ?? t("booking.noEmail")} ·{" "}
            {customer.preferredChannel === "EMAIL" ? t("booking.viaEmail") : t("booking.viaWhatsapp")} · {t("booking.kyc", { status: s(customer.kycStatus) })}
            {customer.isBlocklisted ? <> · {t("client.blocklisted")}{customer.blocklistReason ? ` (${customer.blocklistReason})` : null}</> : null}
          </p>
          <p className="text-xs text-brand-700/40">
            {customer.customerNumber !== null ? <>{t("client.customerNo", { number: customer.customerNumber })} · </> : null}
            {t("client.since", { date: fmtDate(customer.createdAt) })}
          </p>
        </div>
        {health && summary && (
          <div className="text-right">
            <span className={`rounded-full px-3 py-1 text-sm font-medium ${health.className}`}>{health.label}</span>
            <p className="mt-1 text-xs text-brand-700/60">{health.hint}</p>
            {summary.nextDueDate && (
              <p className="text-xs text-brand-700/60">
                {t("client.nextDue", { date: fmtDate(summary.nextDueDate) })} · {summary.nextDueAmount ? formatIDR(summary.nextDueAmount) : ""}
              </p>
            )}
            {Number(summary.outstandingAmount) > 0 && <p className="text-xs text-red-700">{t("client.outstanding", { amount: formatIDR(summary.outstandingAmount) })}</p>}
          </div>
        )}
      </div>

      <section className="mt-8">
        <h2 className="text-lg font-medium">{t("client.changeRequests")}</h2>
        <div className="mt-2">
          <ChangeRequestPanel customerId={customer.id} reloadKey={changeReload} />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-medium">{t("client.rentals")}</h2>
        {customer.bookings.length === 0 && <p className="mt-2 text-sm text-brand-700/60">{t("client.noRentals")}</p>}
        <div className="mt-3 space-y-4">
          {customer.bookings.map((b) => (
            <div key={b.id} className="rounded-lg border border-brand-600/10 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <Link href={`/bookings/${b.id}`} className="font-medium hover:underline">
                    {b.contracts[0]?.contractNumber ? <>{t("client.contractNo", { number: b.contracts[0].contractNumber })} · </> : null}
                    {b.assetType.name}
                    {b.asset ? ` — ${b.asset.code}` : ""}
                  </Link>
                  <p className="text-sm text-brand-700/60">
                    {b.location?.name ? `${b.location.name} · ` : ""}
                    {fmtDate(b.startDate)}
                    {" → "}
                    {b.endDate ? fmtDate(b.endDate) : t("client.openEnded")}
                    {b.termMonths ? <> · {t("client.termMonths", { months: b.termMonths })}</> : null}
                    {b.legacyBookingNumber ? <> · {t("client.legacyBooking", { number: b.legacyBookingNumber })}</> : null}
                    {b.paidThrough ? <> · {t("client.paidThrough", { date: fmtDate(b.paidThrough) })}</> : null}
                  </p>
                </div>
                <span className="rounded-full bg-brand-700/10 px-3 py-1 text-xs font-medium">{s(b.status)}</span>
              </div>
              {canDo(me, "request_booking_change") && ["PENDING_APPROVAL", "NEEDS_INFO", "APPROVED"].includes(b.status) && (
                <div className="mt-2">
                  <ChangeRequestActions bookingId={b.id} compact onChanged={() => setChangeReload((n) => n + 1)} />
                </div>
              )}

              {b.invoices.length > 0 && (
                <table className="mt-3 w-full text-xs">
                  <thead className="text-left text-brand-700/60">
                    <tr>
                      <th className="py-1">{t("client.colPayment")}</th>
                      <th className="py-1">{t("common.dueDate")}</th>
                      <th className="py-1">{t("common.status")}</th>
                      <th className="py-1 text-right">{t("common.amount")}</th>
                      <th className="py-1 text-right">{t("client.colPaid")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.invoices.map((inv) => (
                      <tr key={inv.id} className="border-t border-brand-600/10">
                        <td className="py-1">
                          <Link href={`/invoices/${inv.id}`} className="hover:underline">
                            {inv.scheduleIndex === 0 ? t("client.proforma") : inv.scheduleIndex !== null ? `#${inv.scheduleIndex + 1}` : ""}{" "}
                            {inv.invoiceNumber.startsWith("SCHEDULED/") ? t("client.numberedWhenIssued") : t("client.invoiceNo", { number: inv.invoiceNumber })}
                          </Link>
                        </td>
                        <td className="py-1">{fmtDate(inv.dueDate)}</td>
                        <td className="py-1">
                          <span className={`rounded-full px-2 py-0.5 ${INVOICE_STYLE[inv.status] ?? ""}`}>{s(inv.status)}</span>
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
                  {b.deposits
                    .map((d) =>
                      Number(d.appliedAmount) > 0
                        ? t("client.depositApplied", { amount: formatIDR(d.amount), status: s(d.status), applied: formatIDR(d.appliedAmount) })
                        : t("client.deposit", { amount: formatIDR(d.amount), status: s(d.status) }),
                    )
                    .join(" · ")}
                  {b.contracts[0] ? (
                    <>
                      {" · "}
                      {b.contracts[0].contractNumber ? t("client.contractNo", { number: b.contracts[0].contractNumber }) : t("client.contract")}{" "}
                      {b.contracts[0].signedAt
                        ? `${t("client.contractSigned", { date: fmtDate(b.contracts[0].signedAt) })}${b.contracts[0].confirmedAt ? " · CONFIRMED" : ""}`
                        : b.contracts[0].unsignedDocumentUrl
                          ? t("client.contractUnsigned")
                          : t("client.contractNotGenerated")}
                    </>
                  ) : null}
                  {b.contracts[0] && !b.contracts[0].signedAt && b.contracts[0].signMethod === "OFFLINE" ? (
                    <> · {t("client.offlineDeadline", { date: fmtDate(b.contracts[0].signDeadlineAt ?? null) })}</>
                  ) : null}
                </p>
              )}
              {/* PRD go-live 2 §5.3 — record a paper contract from here too, not only from the booking page. */}
              {b.status === "APPROVED" && b.contracts[0]?.unsignedDocumentUrl && !b.contracts[0].signedAt && b.contracts[0].esignStatus !== "PENDING" && canUploadScan && (
                <details className="mt-3 rounded border border-brand-600/10 p-3">
                  <summary className="cursor-pointer text-sm">{t("client.uploadPaper")}</summary>
                  <div className="mt-2">
                    <SignedScanUpload bookingId={b.id} isCompany={customer.type === "BUSINESS"} onDone={() => void load()} />
                  </div>
                </details>
              )}
            </div>
          ))}
        </div>
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="text-lg font-medium">{t("client.documents")}</h2>
          <p className="text-xs text-brand-700/60">{t("client.documentsHint")}</p>
          {customer.customerNumber !== null && (
            <p className="mt-1 text-xs">
              <Link href={`/legacy?customer=${customer.customerNumber}`} className="text-amber-800 underline">
                {t("client.legacyLink")}
              </Link>{" "}
              <span className="text-brand-700/60">{t("client.legacyLinkHint")}</span>
            </p>
          )}
          {docError && <p className="mt-2 text-sm text-red-600">{docError}</p>}
          {!documents ? (
            !docError && <p className="mt-2 text-sm text-brand-700/60">{t("common.loading")}</p>
          ) : documents.length === 0 ? (
            <p className="mt-2 text-sm text-brand-700/60">{t("client.noDocuments")}</p>
          ) : (
            <ul className="mt-2 max-h-96 space-y-1 overflow-y-auto text-sm">
              {documents.map((d) => (
                <li key={`${d.kind}-${d.href}`} className="flex items-center justify-between gap-3 rounded border border-brand-600/10 bg-white px-3 py-2">
                  <button onClick={() => void openDocument(d)} className="text-left hover:underline">
                    <span className="block font-medium">{d.label}</span>
                    <span className="block text-xs text-brand-700/60">
                      {kindLabel(d.kind)}
                      {d.detail ? ` · ${d.kind === "INVOICE" || d.kind === "PAYMENT_PROOF" ? formatIDR(d.detail) : d.detail}` : ""}
                    </span>
                  </button>
                  <span className="shrink-0 text-right text-xs text-brand-700/60">
                    {d.status ? `${s(d.status)} · ` : ""}
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
          {/* PRD go-live 2 §5.1 — staff take a walk-in's documents here. */}
          <KycPanel customerId={customer.id} bookingId={customer.bookings.find((b) => b.status === "APPROVED")?.id ?? null} onChanged={() => void load()} />
          {customer.notes && <p className="mt-3 rounded bg-brand-700/5 p-3 text-sm">{customer.notes}</p>}
        </section>
        <section>
          <h2 className="text-lg font-medium">{t("client.messages")}</h2>
          {notifications.length === 0 ? (
            <p className="mt-2 text-sm text-brand-700/60">{t("client.noMessages")}</p>
          ) : (
            <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto text-xs">
              {notifications.map((n) => (
                <li key={n.id} className="flex justify-between rounded border border-brand-600/10 bg-white px-3 py-1.5">
                  <span>
                    {n.templateKey} <span className="text-brand-700/50">· {n.channel.toLowerCase()}</span>
                  </span>
                  <span className={n.status === "FAILED" ? "text-red-600" : "text-brand-700/60"}>
                    {s(n.status)} · {fmtDateTime(n.createdAt)}
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
