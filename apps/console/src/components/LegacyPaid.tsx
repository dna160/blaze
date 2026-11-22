"use client";

import Link from "next/link";

import { useT } from "@/lib/i18n";

/**
 * PRD go-live 2 §7.3 — "Dibayar di Booqable / Paid in Booqable".
 *
 * An invoice imported from Booqable and paid there after the import is voided
 * by the re-sync; staff then saw "no payments yet". These show where the money
 * went, linking to the read-only Booqable archive (/legacy).
 */

export interface LegacyPaymentRef {
  recordId: string;
  orderNumber: string | null;
  occurredAt: string | null;
  amount: number | null;
  status: string | null;
  title: string | null;
}

export interface LegacyInvoiceSettlement {
  settledInLegacy: boolean;
  basis: "VOIDED_AS_SETTLED" | "LEGACY_INVOICE_PAID" | "LEGACY_PAYMENTS" | null;
  invoiceRecordId: string | null;
  legacyStatus: string | null;
  orderNumber: string | null;
  payments: LegacyPaymentRef[];
}

export interface CustomerLegacyPayments {
  payments: LegacyPaymentRef[];
  totalPaid: number;
  paymentCount: number;
  rentals: Array<{ bookingId: string; legacyBookingNumber: string; unitCode: string | null; status: string; paidThrough: string | null }>;
}

const idr = (n: number) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);
const day = (iso: string | null, intl: string) => (iso ? new Date(iso).toLocaleDateString(intl, { timeZone: "Asia/Jakarta" }) : "-");

function recordHref(recordId: string) {
  return `/legacy?record=${encodeURIComponent(recordId)}`;
}

/** The chip, for an invoice that has any Booqable trace. Nothing when it has none. */
export function LegacyPaidChip({ settlement }: { settlement: LegacyInvoiceSettlement | null | undefined }) {
  const { t } = useT();
  if (!settlement) return null;
  const target = settlement.invoiceRecordId ?? settlement.payments[0]?.recordId ?? null;
  const paid = settlement.settledInLegacy;
  const label = paid ? t("legacyPaid.paid") : t("legacyPaid.hasRecord");
  const title =
    settlement.basis === "VOIDED_AS_SETTLED"
      ? t("legacyPaid.voidedAsSettled")
      : settlement.basis === "LEGACY_INVOICE_PAID"
        ? t("legacyPaid.legacyInvoicePaid")
        : t("legacyPaid.legacyPayments", { count: settlement.payments.length, order: settlement.orderNumber ?? "-" });
  const cls = paid ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-amber-300 bg-amber-50 text-amber-800";
  const chip = (
    <span title={title} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
  return target ? (
    <Link href={recordHref(target)} className="hover:opacity-80" data-testid="legacy-paid-chip">
      {chip}
    </Link>
  ) : (
    chip
  );
}

/** The invoice page's block: the chip plus the Booqable payments on the same order. */
export function LegacyPaymentsBlock({ settlement }: { settlement: LegacyInvoiceSettlement | null | undefined }) {
  const { t, intl } = useT();
  if (!settlement) return null;
  return (
    <section className="mt-4 rounded border border-emerald-200 bg-emerald-50/40 p-4" data-testid="legacy-payments">
      <div className="flex flex-wrap items-center gap-2">
        <LegacyPaidChip settlement={settlement} />
        <span className="text-xs text-brand-700/70">
          {t("legacyPaid.statusInBooqable", { status: settlement.legacyStatus ?? "-" })}
          {settlement.orderNumber ? t("legacyPaid.orderSuffix", { order: settlement.orderNumber }) : ""}
        </span>
      </div>
      {settlement.payments.length > 0 ? (
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs text-brand-700/60">
            <tr>
              <th className="py-1">{t("common.date")}</th>
              <th>{t("legacyPaid.description")}</th>
              <th>{t("common.status")}</th>
              <th className="text-right">{t("common.amount")}</th>
            </tr>
          </thead>
          <tbody>
            {settlement.payments.map((p) => (
              <tr key={p.recordId} className="border-t border-emerald-200/70">
                <td className="py-1">{day(p.occurredAt, intl)}</td>
                <td>
                  <Link href={recordHref(p.recordId)} className="underline">
                    {p.title ?? t("legacyPaid.payment")}
                  </Link>
                </td>
                <td>{p.status ?? "-"}</td>
                <td className="text-right">{p.amount === null ? "-" : idr(p.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-2 text-xs text-brand-700/60">{t("legacyPaid.noPayments")}</p>
      )}
    </section>
  );
}

/** The client page's block: Booqable payments and each imported rental's paid-through date. */
export function CustomerLegacyPaymentsBlock({ legacy }: { legacy: CustomerLegacyPayments | null | undefined }) {
  const { t, intl } = useT();
  if (!legacy || (legacy.paymentCount === 0 && legacy.rentals.length === 0)) return null;
  return (
    <section className="mt-6 rounded border border-emerald-200 bg-white p-4" data-testid="customer-legacy-payments">
      <h2 className="text-lg font-medium">{t("legacyPaid.customerTitle")}</h2>
      <p className="text-xs text-brand-700/60">{t("legacyPaid.customerIntro", { count: legacy.paymentCount, total: idr(legacy.totalPaid) })}</p>
      {legacy.rentals.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {legacy.rentals.map((r) => (
            <li key={r.bookingId}>
              {t("legacyPaid.rentalLine", { unit: r.unitCode ?? "-", order: r.legacyBookingNumber })}
              <b>{t("legacyPaid.paidThrough", { date: r.paidThrough ?? "-" })}</b>
            </li>
          ))}
        </ul>
      )}
      {legacy.payments.length > 0 && (
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs text-brand-700/60">
            <tr>
              <th className="py-1">{t("common.date")}</th>
              <th>{t("legacyPaid.description")}</th>
              <th>{t("common.status")}</th>
              <th className="text-right">{t("common.amount")}</th>
            </tr>
          </thead>
          <tbody>
            {legacy.payments.map((p) => (
              <tr key={p.recordId} className="border-t border-brand-600/10">
                <td className="py-1">{day(p.occurredAt, intl)}</td>
                <td>
                  <Link href={recordHref(p.recordId)} className="underline">
                    {p.title ?? t("legacyPaid.payment")}
                  </Link>
                </td>
                <td>{p.status ?? "-"}</td>
                <td className="text-right">{p.amount === null ? "-" : idr(p.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {legacy.paymentCount > legacy.payments.length && (
        <p className="mt-2 text-xs text-brand-700/60">{t("legacyPaid.showingLatest", { count: legacy.payments.length })}</p>
      )}
    </section>
  );
}
