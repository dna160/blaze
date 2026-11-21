"use client";

import Link from "next/link";

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
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" }) : "-");

function recordHref(recordId: string) {
  return `/legacy?record=${encodeURIComponent(recordId)}`;
}

/** The chip, for an invoice that has any Booqable trace. Nothing when it has none. */
export function LegacyPaidChip({ settlement }: { settlement: LegacyInvoiceSettlement | null | undefined }) {
  if (!settlement) return null;
  const target = settlement.invoiceRecordId ?? settlement.payments[0]?.recordId ?? null;
  const paid = settlement.settledInLegacy;
  const label = paid ? "Dibayar di Booqable" : "Ada catatan di Booqable";
  const title =
    settlement.basis === "VOIDED_AS_SETTLED"
      ? "Invoice ini dibatalkan di RentOS karena sudah dilunasi di Booqable setelah impor."
      : settlement.basis === "LEGACY_INVOICE_PAID"
        ? "Booqable mencatat invoice ini lunas."
        : `Booqable mencatat ${settlement.payments.length} pembayaran untuk pesanan #${settlement.orderNumber ?? "-"}.`;
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
  if (!settlement) return null;
  return (
    <section className="mt-4 rounded border border-emerald-200 bg-emerald-50/40 p-4" data-testid="legacy-payments">
      <div className="flex flex-wrap items-center gap-2">
        <LegacyPaidChip settlement={settlement} />
        <span className="text-xs text-brand-700/70">
          Status di Booqable: {settlement.legacyStatus ?? "-"}
          {settlement.orderNumber ? ` · pesanan #${settlement.orderNumber}` : ""}
        </span>
      </div>
      {settlement.payments.length > 0 ? (
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs text-brand-700/60">
            <tr>
              <th className="py-1">Tanggal</th>
              <th>Keterangan</th>
              <th>Status</th>
              <th className="text-right">Jumlah</th>
            </tr>
          </thead>
          <tbody>
            {settlement.payments.map((p) => (
              <tr key={p.recordId} className="border-t border-emerald-200/70">
                <td className="py-1">{day(p.occurredAt)}</td>
                <td>
                  <Link href={recordHref(p.recordId)} className="underline">
                    {p.title ?? "Pembayaran"}
                  </Link>
                </td>
                <td>{p.status ?? "-"}</td>
                <td className="text-right">{p.amount === null ? "-" : idr(p.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-2 text-xs text-brand-700/60">Tidak ada pembayaran Booqable yang tercatat untuk pesanan ini.</p>
      )}
    </section>
  );
}

/** The client page's block: Booqable payments and each imported rental's paid-through date. */
export function CustomerLegacyPaymentsBlock({ legacy }: { legacy: CustomerLegacyPayments | null | undefined }) {
  if (!legacy || (legacy.paymentCount === 0 && legacy.rentals.length === 0)) return null;
  return (
    <section className="mt-6 rounded border border-emerald-200 bg-white p-4" data-testid="customer-legacy-payments">
      <h2 className="text-lg font-medium">Pembayaran di Booqable</h2>
      <p className="text-xs text-brand-700/60">
        Dari arsip Booqable (hanya baca). {legacy.paymentCount} transaksi, total bersih {idr(legacy.totalPaid)}.
      </p>
      {legacy.rentals.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {legacy.rentals.map((r) => (
            <li key={r.bookingId}>
              {r.unitCode ?? "-"} · pesanan Booqable #{r.legacyBookingNumber} · <b>dibayar sampai {r.paidThrough ?? "-"}</b>
            </li>
          ))}
        </ul>
      )}
      {legacy.payments.length > 0 && (
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs text-brand-700/60">
            <tr>
              <th className="py-1">Tanggal</th>
              <th>Keterangan</th>
              <th>Status</th>
              <th className="text-right">Jumlah</th>
            </tr>
          </thead>
          <tbody>
            {legacy.payments.map((p) => (
              <tr key={p.recordId} className="border-t border-brand-600/10">
                <td className="py-1">{day(p.occurredAt)}</td>
                <td>
                  <Link href={recordHref(p.recordId)} className="underline">
                    {p.title ?? "Pembayaran"}
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
        <p className="mt-2 text-xs text-brand-700/60">Menampilkan {legacy.payments.length} terbaru. Lihat semuanya di Arsip Booqable.</p>
      )}
    </section>
  );
}
