"use client";

import type { FinancialSummaryResponse } from "@rentos/contracts";
import { useEffect, useState } from "react";

import { rangeQuery, type ReportRangeValue } from "@/components/ReportRange";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

import { DownloadCsvButton, formatDay, formatIDR, LEDGER_ACCOUNT_LABEL, LoadError, SectionHeader, Tile } from "./report-ui";

/**
 * PRD go-live 2 §2.3 — "Ringkasan keuangan": what used to be the month-end
 * close, over any range. "Bulan ini" and "Bulan lalu" in the range control
 * close a month in one click.
 */
export function FinancialSummarySection({ range }: { range: ReportRangeValue }) {
  const [data, setData] = useState<FinancialSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = rangeQuery(range);

  useEffect(() => {
    const token = authClient.getToken();
    if (!token) return;
    let cancelled = false;
    setError(null);
    apiFetch<FinancialSummaryResponse>(`/reports/financial-summary?${query}`, { token })
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Ringkasan keuangan gagal dimuat.");
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const end = formatDay(range.to);
  const accounts = data ? data.accounts.filter((a) => data.branch.isPkp || a.account !== "TAX_PAYABLE") : [];

  return (
    <section data-testid="financial-summary-section">
      <SectionHeader
        title="Ringkasan keuangan"
        hint="Pendapatan, penjualan, penerimaan dan deposit adalah pergerakan dalam rentang. AR dan deposit dihitung per akhir rentang."
        action={<DownloadCsvButton path={`/reports/export/financial-summary.csv?${query}`} fallbackName="financial-summary.csv" />}
      />
      <LoadError message={error} />

      <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-brand-700/60">Dalam rentang</p>
      <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Tile label="Pendapatan diakui" value={formatIDR(data?.revenueRecognized)} sub="Diakui saat invoice terbit" />
        <Tile label="Penjualan (invoice terbit)" value={formatIDR(data?.invoiced.amount)} sub={data ? `${data.invoiced.count} invoice, tanpa deposit` : undefined} />
        <Tile label="Penerimaan" value={formatIDR(data?.received.amount)} sub={data ? `${data.received.count} pembayaran sukses` : undefined} />
        <Tile label="Deposit diterima" value={formatIDR(data?.depositsReceived)} />
        <Tile label="Deposit dikembalikan" value={formatIDR(data?.refunds)} />
      </div>

      <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-brand-700/60">Saldo per akhir rentang ({end})</p>
      <div className="mt-2 grid gap-4 sm:grid-cols-3">
        <Tile label="Piutang usaha (AR)" value={formatIDR(data?.accountsReceivable)} sub={`Per ${end}`} />
        <Tile label="Deposit ditahan" value={formatIDR(data?.depositsHeld)} sub={`Per ${end}`} />
        {data && data.taxPayable === null ? (
          <Tile label="Utang PPN" value="Tidak PKP" sub="Cabang ini tidak memungut PPN" />
        ) : (
          <Tile label="Utang PPN" value={formatIDR(data?.taxPayable)} sub={`Per ${end}`} />
        )}
      </div>

      <div className="mt-8">
        <SectionHeader title="Buku besar per akun" hint="Saldo awal sebelum rentang, mutasi debit dan kredit dalam rentang, dan saldo akhir." />
        <div className="mt-3 overflow-x-auto rounded-lg border border-brand-600/10 bg-white">
          <table className="w-full text-sm" data-testid="ledger-accounts">
            <thead className="bg-brand-700/5 text-left">
              <tr>
                <th className="p-3">Akun</th>
                <th className="p-3 text-right">Saldo awal</th>
                <th className="p-3 text-right">Debit</th>
                <th className="p-3 text-right">Kredit</th>
                <th className="p-3 text-right">Saldo akhir</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.account} className="border-t border-brand-600/10">
                  <td className="p-3">
                    {LEDGER_ACCOUNT_LABEL[a.account] ?? a.account}
                    <span className="block text-xs text-brand-700/50">{a.normalSide === "DEBIT" ? "Saldo normal debit" : "Saldo normal kredit"}</span>
                  </td>
                  <td className="p-3 text-right tabular-nums">{formatIDR(a.opening)}</td>
                  <td className="p-3 text-right tabular-nums">{formatIDR(a.debit)}</td>
                  <td className="p-3 text-right tabular-nums">{formatIDR(a.credit)}</td>
                  <td className="p-3 text-right font-medium tabular-nums">{formatIDR(a.closing)}</td>
                </tr>
              ))}
              {data && accounts.length === 0 && (
                <tr className="border-t border-brand-600/10">
                  <td colSpan={5} className="p-4 text-center text-brand-700/60">
                    Belum ada catatan buku besar sampai akhir rentang ini.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
