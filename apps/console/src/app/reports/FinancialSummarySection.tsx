"use client";

import type { FinancialSummaryResponse } from "@rentos/contracts";
import { useEffect, useState } from "react";

import { rangeQuery, type ReportRangeValue } from "@/components/ReportRange";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { tr, useT } from "@/lib/i18n";

import { DownloadCsvButton, formatDay, formatIDR, ledgerAccountLabel, LoadError, SectionHeader, Tile } from "./report-ui";

/**
 * PRD go-live 2 §2.3 — "Ringkasan keuangan": what used to be the month-end
 * close, over any range. "Bulan ini" and "Bulan lalu" in the range control
 * close a month in one click.
 */
export function FinancialSummarySection({ range }: { range: ReportRangeValue }) {
  const { t } = useT();
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
        if (!cancelled) setError(err instanceof ApiError ? err.message : tr("reports.summary.loadFailed"));
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
        title={t("reports.summary.title")}
        hint={t("reports.summary.hint")}
        action={<DownloadCsvButton path={`/reports/export/financial-summary.csv?${query}`} fallbackName="financial-summary.csv" />}
      />
      <LoadError message={error} />

      <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-brand-700/60">{t("reports.summary.inRange")}</p>
      <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Tile label={t("reports.summary.revenue")} value={formatIDR(data?.revenueRecognized)} sub={t("reports.summary.revenueSub")} />
        <Tile label={t("reports.sales.tileSales")} value={formatIDR(data?.invoiced.amount)} sub={data ? t("reports.summary.invoicedSub", { count: data.invoiced.count }) : undefined} />
        <Tile label={t("reports.summary.received")} value={formatIDR(data?.received.amount)} sub={data ? t("reports.summary.receivedSub", { count: data.received.count }) : undefined} />
        <Tile label={t("reports.sales.tileDepositsReceived")} value={formatIDR(data?.depositsReceived)} />
        <Tile label={t("reports.sales.tileDepositsRefunded")} value={formatIDR(data?.refunds)} />
      </div>

      <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-brand-700/60">{t("reports.summary.balancesAt", { date: end })}</p>
      <div className="mt-2 grid gap-4 sm:grid-cols-3">
        <Tile label={t("reports.summary.ar")} value={formatIDR(data?.accountsReceivable)} sub={t("reports.summary.asOf", { date: end })} />
        <Tile label={t("reports.summary.depositsHeld")} value={formatIDR(data?.depositsHeld)} sub={t("reports.summary.asOf", { date: end })} />
        {data && data.taxPayable === null ? (
          <Tile label={t("reports.summary.taxPayable")} value={t("reports.summary.notPkp")} sub={t("reports.summary.notPkpSub")} />
        ) : (
          <Tile label={t("reports.summary.taxPayable")} value={formatIDR(data?.taxPayable)} sub={t("reports.summary.asOf", { date: end })} />
        )}
      </div>

      <div className="mt-8">
        <SectionHeader title={t("reports.summary.ledgerTitle")} hint={t("reports.summary.ledgerHint")} />
        <div className="mt-3 overflow-x-auto rounded-lg border border-brand-600/10 bg-white">
          <table className="w-full text-sm" data-testid="ledger-accounts">
            <thead className="bg-brand-700/5 text-left">
              <tr>
                <th className="p-3">{t("reports.summary.colAccount")}</th>
                <th className="p-3 text-right">{t("reports.summary.colOpening")}</th>
                <th className="p-3 text-right">{t("status.DEBIT")}</th>
                <th className="p-3 text-right">{t("status.CREDIT")}</th>
                <th className="p-3 text-right">{t("reports.summary.colClosing")}</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.account} className="border-t border-brand-600/10">
                  <td className="p-3">
                    {ledgerAccountLabel(a.account)}
                    <span className="block text-xs text-brand-700/50">{a.normalSide === "DEBIT" ? t("reports.summary.normalDebit") : t("reports.summary.normalCredit")}</span>
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
                    {t("reports.summary.noLedger")}
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
