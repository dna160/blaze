"use client";

import type { SalesGroupBy, SalesReportResponse, SalesTransactionStatus } from "@rentos/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";

import { rangeQuery, type ReportRangeValue } from "@/components/ReportRange";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

import { DownloadCsvButton, formatDay, formatIDR, LoadError, PAYMENT_METHOD_LABEL, PAYMENT_STATUS_LABEL, SectionHeader, Tile } from "./report-ui";

/**
 * PRD go-live 2 §2.2 — "Penjualan": how much was sold and how much came in,
 * live, over any range. Finance uses the transaction list to enter the bank
 * mutasi, so it defaults to successful payments only.
 */

const GROUPS: Array<{ value: SalesGroupBy; label: string }> = [
  { value: "day", label: "Harian" },
  { value: "week", label: "Mingguan" },
  { value: "month", label: "Bulanan" },
];

const STATUSES: Array<{ value: SalesTransactionStatus; label: string }> = [
  { value: "SUCCEEDED", label: "Sukses saja" },
  { value: "PENDING", label: "Menunggu verifikasi" },
  { value: "FAILED", label: "Gagal" },
  { value: "ALL", label: "Semua status" },
];

const METHODS = ["MANUAL_TRANSFER", "CASH", "VIRTUAL_ACCOUNT", "QRIS", "EWALLET", "CARD"] as const;

function periodLabel(period: string, groupBy: SalesGroupBy): string {
  if (groupBy === "week") return `Minggu ${formatDay(period)}`;
  return formatDay(period);
}

export function SalesSection({ range }: { range: ReportRangeValue }) {
  const [groupBy, setGroupBy] = useState<SalesGroupBy>("day");
  const [status, setStatus] = useState<SalesTransactionStatus>("SUCCEEDED");
  const [method, setMethod] = useState("");
  const [hideEmpty, setHideEmpty] = useState(true);
  const [data, setData] = useState<SalesReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = `${rangeQuery(range)}&groupBy=${groupBy}&status=${status}${method ? `&method=${method}` : ""}`;

  useEffect(() => {
    const token = authClient.getToken();
    if (!token) return;
    let cancelled = false;
    setError(null);
    apiFetch<SalesReportResponse>(`/reports/sales?${query}`, { token })
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Laporan penjualan gagal dimuat.");
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const s = data?.summary;
  const periods = data ? (hideEmpty ? data.periods.filter((p) => Number(p.invoiced) !== 0 || Number(p.received) !== 0 || Number(p.depositsReceived) !== 0 || Number(p.depositsRefunded) !== 0) : data.periods) : [];
  const total = (key: "invoiced" | "received" | "depositsReceived" | "depositsRefunded" | "netCashIn") => (data ? data.periods.reduce((n, p) => n + Number(p[key]), 0) : 0);

  return (
    <section data-testid="sales-section">
      <SectionHeader
        title="Penjualan"
        hint="Berapa yang terjual dan berapa yang masuk pada rentang yang dipilih."
        action={<DownloadCsvButton path={`/reports/export/sales-summary.csv?${rangeQuery(range)}`} fallbackName="sales-summary.csv" label="Unduh CSV ringkasan" />}
      />
      <LoadError message={error} />

      <dl className="mt-3 grid gap-x-6 gap-y-1 rounded border border-brand-600/10 bg-brand-700/[0.03] p-3 text-xs text-brand-700/80 sm:grid-cols-3">
        <div>
          <dt className="font-semibold">Penjualan</dt>
          <dd>Invoice yang terbit dalam rentang, tanpa deposit. Invoice yang dibatalkan atau diganti nota kredit tidak dihitung.</dd>
        </div>
        <div>
          <dt className="font-semibold">Penerimaan</dt>
          <dd>Pembayaran yang sukses dalam rentang, menurut tanggal bayar (bukan tanggal dicatat). Sama dengan mutasi bank, jadi termasuk deposit yang dibayar bersama sewa.</dd>
        </div>
        <div>
          <dt className="font-semibold">Deposit</dt>
          <dd>Ditampilkan terpisah dan tidak pernah dihitung sebagai penjualan. Kas masuk bersih = penerimaan dikurangi deposit yang dikembalikan.</dd>
        </div>
      </dl>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Penjualan (invoice terbit)" value={formatIDR(s?.invoicesIssued.amount)} sub={s ? `${s.invoicesIssued.count} invoice` : undefined} />
        <Tile
          label="Penerimaan (pembayaran sukses)"
          value={formatIDR(s?.paymentsReceived.amount)}
          sub={
            s ? (
              <>
                {s.paymentsReceived.count} pembayaran
                {s.paymentsReceived.byMethod.map((m) => (
                  <span key={m.method} className="block">
                    {PAYMENT_METHOD_LABEL[m.method] ?? m.method}: {formatIDR(m.amount)} ({m.count})
                  </span>
                ))}
              </>
            ) : undefined
          }
        />
        <Tile label="Deposit diterima" value={formatIDR(s?.depositsReceived.amount)} sub={s ? `${s.depositsReceived.count} deposit · termasuk dalam penerimaan` : undefined} />
        <Tile label="Deposit dikembalikan" value={formatIDR(s?.depositsRefunded.amount)} sub={s ? `${s.depositsRefunded.count} pengembalian` : undefined} />
        <Tile label="Kas masuk bersih" value={formatIDR(s?.netCashIn)} sub="Penerimaan dikurangi deposit dikembalikan" />
        <Tile label="Sewa baru dimulai" value={s ? s.rentalsStarted : "—"} sub="Menurut tanggal mulai sewa" />
        <Tile label="Sewa berakhir" value={s ? s.rentalsEnded : "—"} sub="Penyewa keluar dalam rentang" />
        <Tile label="Nota kredit" value={formatIDR(s?.creditNotes.amount)} sub={s ? `${s.creditNotes.count} nota kredit` : undefined} />
      </div>

      <div className="mt-8">
        <SectionHeader
          title="Rekap per periode"
          action={
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex gap-1 rounded border border-brand-600/20 p-0.5 text-xs">
                {GROUPS.map((g) => (
                  <button key={g.value} type="button" onClick={() => setGroupBy(g.value)} aria-pressed={groupBy === g.value} className={`rounded px-2.5 py-1 font-medium ${groupBy === g.value ? "bg-brand-700 text-white" : "hover:bg-brand-700/5"}`}>
                    {g.label}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1.5 text-xs text-brand-700/70">
                <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />
                <span>Sembunyikan periode kosong</span>
              </label>
              <DownloadCsvButton path={`/reports/export/sales-daily.csv?${rangeQuery(range)}&groupBy=${groupBy}`} fallbackName="sales-daily.csv" />
            </div>
          }
        />
        <div className="mt-3 overflow-x-auto rounded-lg border border-brand-600/10 bg-white">
          <table className="w-full text-sm" data-testid="sales-periods">
            <thead className="bg-brand-700/5 text-left">
              <tr>
                <th className="p-3">Periode</th>
                <th className="p-3 text-right">Penjualan</th>
                <th className="p-3 text-right">Penerimaan</th>
                <th className="p-3 text-right">Deposit diterima</th>
                <th className="p-3 text-right">Deposit dikembalikan</th>
                <th className="p-3 text-right">Kas masuk bersih</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.period} className="border-t border-brand-600/10">
                  <td className="p-3">{periodLabel(p.period, groupBy)}</td>
                  <td className="p-3 text-right tabular-nums">{formatIDR(p.invoiced)}</td>
                  <td className="p-3 text-right tabular-nums">{formatIDR(p.received)}</td>
                  <td className="p-3 text-right tabular-nums">{formatIDR(p.depositsReceived)}</td>
                  <td className="p-3 text-right tabular-nums">{formatIDR(p.depositsRefunded)}</td>
                  <td className="p-3 text-right tabular-nums">{formatIDR(p.netCashIn)}</td>
                </tr>
              ))}
              {data && periods.length === 0 && (
                <tr className="border-t border-brand-600/10">
                  <td colSpan={6} className="p-4 text-center text-brand-700/60">
                    Tidak ada transaksi pada rentang ini.
                  </td>
                </tr>
              )}
            </tbody>
            {data && (
              <tfoot className="border-t-2 border-brand-600/20 bg-brand-700/[0.03] font-semibold">
                <tr>
                  <td className="p-3">Total</td>
                  <td className="p-3 text-right tabular-nums">{formatIDR(total("invoiced"))}</td>
                  <td className="p-3 text-right tabular-nums">{formatIDR(total("received"))}</td>
                  <td className="p-3 text-right tabular-nums">{formatIDR(total("depositsReceived"))}</td>
                  <td className="p-3 text-right tabular-nums">{formatIDR(total("depositsRefunded"))}</td>
                  <td className="p-3 text-right tabular-nums">{formatIDR(total("netCashIn"))}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div className="mt-8">
        <SectionHeader
          title="Daftar transaksi"
          hint="Satu baris per pembayaran, dalam waktu WIB."
          action={
            <div className="flex flex-wrap items-center gap-2">
              <select value={status} onChange={(e) => setStatus(e.target.value as SalesTransactionStatus)} aria-label="Status pembayaran" className="rounded border border-brand-600/20 bg-white px-2 py-1.5 text-sm">
                {STATUSES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Metode pembayaran" className="rounded border border-brand-600/20 bg-white px-2 py-1.5 text-sm">
                <option value="">Semua metode</option>
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
              <DownloadCsvButton path={`/reports/export/sales-transactions.csv?${rangeQuery(range)}&status=${status}${method ? `&method=${method}` : ""}`} fallbackName="sales-transactions.csv" />
            </div>
          }
        />
        <div className="mt-3 overflow-x-auto rounded-lg border border-brand-600/10 bg-white">
          <table className="w-full text-sm" data-testid="sales-transactions">
            <thead className="bg-brand-700/5 text-left">
              <tr>
                <th className="p-3">Tanggal &amp; jam (WIB)</th>
                <th className="p-3">Pelanggan</th>
                <th className="p-3">No. kontrak</th>
                <th className="p-3">No. invoice</th>
                <th className="p-3">Unit</th>
                <th className="p-3">Metode</th>
                <th className="p-3">Referensi</th>
                <th className="p-3 text-right">Jumlah</th>
                <th className="p-3">Status</th>
                <th className="p-3">Dicatat oleh</th>
                <th className="p-3">Diverifikasi oleh</th>
              </tr>
            </thead>
            <tbody>
              {data?.transactions.map((t) => (
                <tr key={t.paymentId} className="border-t border-brand-600/10 align-top">
                  <td className="whitespace-nowrap p-3 tabular-nums">{t.atLocal}</td>
                  <td className="p-3">
                    <Link href={`/clients/${t.customerId}`} className="hover:underline">
                      {t.customer ?? "—"}
                    </Link>
                    {t.customerNumber !== null && <span className="block text-xs text-brand-700/60">#{t.customerNumber}</span>}
                  </td>
                  <td className="whitespace-nowrap p-3">{t.contractNumber ?? "—"}</td>
                  <td className="whitespace-nowrap p-3">
                    <Link href={`/invoices/${t.invoiceId}`} className="hover:underline">
                      {t.invoiceNumber}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap p-3">{t.unit ?? "—"}</td>
                  <td className="p-3">{PAYMENT_METHOD_LABEL[t.method] ?? t.method}</td>
                  <td className="p-3">{t.reference ?? "—"}</td>
                  <td className="whitespace-nowrap p-3 text-right tabular-nums">{formatIDR(t.amount)}</td>
                  <td className="p-3">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${t.status === "SUCCEEDED" ? "bg-green-100 text-green-800" : t.status === "PENDING" ? "bg-amber-100 text-amber-800" : t.status === "FAILED" ? "bg-red-100 text-red-800" : "bg-brand-700/10"}`}>
                      {PAYMENT_STATUS_LABEL[t.status] ?? t.status}
                    </span>
                  </td>
                  <td className="p-3">{t.recordedBy ?? "—"}</td>
                  <td className="p-3">{t.verifiedBy ?? "—"}</td>
                </tr>
              ))}
              {data && data.transactions.length === 0 && (
                <tr className="border-t border-brand-600/10">
                  <td colSpan={11} className="p-4 text-center text-brand-700/60">
                    Tidak ada pembayaran yang cocok dengan filter ini.
                  </td>
                </tr>
              )}
            </tbody>
            {data && data.transactions.length > 0 && (
              <tfoot className="border-t-2 border-brand-600/20 bg-brand-700/[0.03] font-semibold">
                <tr>
                  <td className="p-3" colSpan={7}>
                    {data.transactions.length} pembayaran
                  </td>
                  <td className="whitespace-nowrap p-3 text-right tabular-nums">{formatIDR(data.transactions.reduce((n, t) => n + Number(t.amount), 0))}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </section>
  );
}
