"use client";

import type { SalesGroupBy, SalesReportResponse, SalesTransactionStatus } from "@rentos/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";

import { rangeQuery, type ReportRangeValue } from "@/components/ReportRange";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { tr, useT } from "@/lib/i18n";

import { DownloadCsvButton, formatDay, formatIDR, LoadError, paymentMethodLabel, paymentStatusLabel, SectionHeader, Tile } from "./report-ui";

/**
 * PRD go-live 2 §2.2 — "Penjualan": how much was sold and how much came in,
 * live, over any range. Finance uses the transaction list to enter the bank
 * mutasi, so it defaults to successful payments only.
 */

/** Labels are message keys (PRD go-live 2 §9.1). */
const GROUPS: Array<{ value: SalesGroupBy; label: string }> = [
  { value: "day", label: "reports.sales.daily" },
  { value: "week", label: "reports.sales.weekly" },
  { value: "month", label: "reports.sales.monthly" },
];

const STATUSES: Array<{ value: SalesTransactionStatus; label: string }> = [
  { value: "SUCCEEDED", label: "reports.sales.statusSucceededOnly" },
  { value: "PENDING", label: "reports.paymentStatus.PENDING" },
  { value: "FAILED", label: "reports.paymentStatus.FAILED" },
  { value: "ALL", label: "reports.sales.statusAll" },
];

const METHODS = ["MANUAL_TRANSFER", "CASH", "VIRTUAL_ACCOUNT", "QRIS", "EWALLET", "CARD"] as const;

function periodLabel(period: string, groupBy: SalesGroupBy): string {
  if (groupBy === "week") return tr("reports.sales.weekOf", { day: formatDay(period) });
  return formatDay(period);
}

export function SalesSection({ range }: { range: ReportRangeValue }) {
  const { t } = useT();
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
        if (!cancelled) setError(err instanceof ApiError ? err.message : tr("reports.sales.loadFailed"));
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
        title={t("reports.sales.title")}
        hint={t("reports.sales.hint")}
        action={<DownloadCsvButton path={`/reports/export/sales-summary.csv?${rangeQuery(range)}`} fallbackName="sales-summary.csv" label={t("reports.sales.downloadSummary")} />}
      />
      <LoadError message={error} />

      <dl className="mt-3 grid gap-x-6 gap-y-1 rounded border border-brand-600/10 bg-brand-700/[0.03] p-3 text-xs text-brand-700/80 sm:grid-cols-3">
        <div>
          <dt className="font-semibold">{t("reports.sales.defSales")}</dt>
          <dd>{t("reports.sales.defSalesText")}</dd>
        </div>
        <div>
          <dt className="font-semibold">{t("reports.sales.defReceived")}</dt>
          <dd>{t("reports.sales.defReceivedText")}</dd>
        </div>
        <div>
          <dt className="font-semibold">{t("reports.sales.defDeposit")}</dt>
          <dd>{t("reports.sales.defDepositText")}</dd>
        </div>
      </dl>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label={t("reports.sales.tileSales")} value={formatIDR(s?.invoicesIssued.amount)} sub={s ? t("reports.sales.invoiceCount", { count: s.invoicesIssued.count }) : undefined} />
        <Tile
          label={t("reports.sales.tileReceived")}
          value={formatIDR(s?.paymentsReceived.amount)}
          sub={
            s ? (
              <>
                {t("reports.sales.paymentCount", { count: s.paymentsReceived.count })}
                {s.paymentsReceived.byMethod.map((m) => (
                  <span key={m.method} className="block">
                    {paymentMethodLabel(m.method)}: {formatIDR(m.amount)} ({m.count})
                  </span>
                ))}
              </>
            ) : undefined
          }
        />
        <Tile label={t("reports.sales.tileDepositsReceived")} value={formatIDR(s?.depositsReceived.amount)} sub={s ? t("reports.sales.depositsIncluded", { count: s.depositsReceived.count }) : undefined} />
        <Tile label={t("reports.sales.tileDepositsRefunded")} value={formatIDR(s?.depositsRefunded.amount)} sub={s ? t("reports.sales.refundCount", { count: s.depositsRefunded.count }) : undefined} />
        <Tile label={t("reports.sales.tileNet")} value={formatIDR(s?.netCashIn)} sub={t("reports.sales.netSub")} />
        <Tile label={t("reports.sales.tileStarted")} value={s ? s.rentalsStarted : "—"} sub={t("reports.sales.startedSub")} />
        <Tile label={t("reports.sales.tileEnded")} value={s ? s.rentalsEnded : "—"} sub={t("reports.sales.endedSub")} />
        <Tile label={t("reports.sales.tileCredit")} value={formatIDR(s?.creditNotes.amount)} sub={s ? t("reports.sales.creditCount", { count: s.creditNotes.count }) : undefined} />
      </div>

      <div className="mt-8">
        <SectionHeader
          title={t("reports.sales.byPeriod")}
          action={
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex gap-1 rounded border border-brand-600/20 p-0.5 text-xs">
                {GROUPS.map((g) => (
                  <button key={g.value} type="button" onClick={() => setGroupBy(g.value)} aria-pressed={groupBy === g.value} className={`rounded px-2.5 py-1 font-medium ${groupBy === g.value ? "bg-brand-700 text-white" : "hover:bg-brand-700/5"}`}>
                    {t(g.label)}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1.5 text-xs text-brand-700/70">
                <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />
                <span>{t("reports.sales.hideEmpty")}</span>
              </label>
              <DownloadCsvButton path={`/reports/export/sales-daily.csv?${rangeQuery(range)}&groupBy=${groupBy}`} fallbackName="sales-daily.csv" />
            </div>
          }
        />
        <div className="mt-3 overflow-x-auto rounded-lg border border-brand-600/10 bg-white">
          <table className="w-full text-sm" data-testid="sales-periods">
            <thead className="bg-brand-700/5 text-left">
              <tr>
                <th className="p-3">{t("reports.sales.colPeriod")}</th>
                <th className="p-3 text-right">{t("reports.sales.colSales")}</th>
                <th className="p-3 text-right">{t("reports.sales.colReceived")}</th>
                <th className="p-3 text-right">{t("reports.sales.colDepositsReceived")}</th>
                <th className="p-3 text-right">{t("reports.sales.colDepositsRefunded")}</th>
                <th className="p-3 text-right">{t("reports.sales.colNet")}</th>
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
                    {t("reports.sales.noPeriods")}
                  </td>
                </tr>
              )}
            </tbody>
            {data && (
              <tfoot className="border-t-2 border-brand-600/20 bg-brand-700/[0.03] font-semibold">
                <tr>
                  <td className="p-3">{t("common.total")}</td>
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
          title={t("reports.sales.transactions")}
          hint={t("reports.sales.transactionsHint")}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <select value={status} onChange={(e) => setStatus(e.target.value as SalesTransactionStatus)} aria-label={t("reports.sales.statusFilter")} className="rounded border border-brand-600/20 bg-white px-2 py-1.5 text-sm">
                {STATUSES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(o.label)}
                  </option>
                ))}
              </select>
              <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label={t("reports.sales.methodFilter")} className="rounded border border-brand-600/20 bg-white px-2 py-1.5 text-sm">
                <option value="">{t("reports.sales.allMethods")}</option>
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {paymentMethodLabel(m)}
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
                <th className="p-3">{t("reports.sales.colWhen")}</th>
                <th className="p-3">{t("common.customer")}</th>
                <th className="p-3">{t("common.contractNumber")}</th>
                <th className="p-3">{t("common.invoiceNumber")}</th>
                <th className="p-3">{t("common.unit")}</th>
                <th className="p-3">{t("reports.sales.colMethod")}</th>
                <th className="p-3">{t("reports.sales.colReference")}</th>
                <th className="p-3 text-right">{t("common.amount")}</th>
                <th className="p-3">{t("common.status")}</th>
                <th className="p-3">{t("reports.sales.colRecordedBy")}</th>
                <th className="p-3">{t("reports.sales.colVerifiedBy")}</th>
              </tr>
            </thead>
            <tbody>
              {data?.transactions.map((tx) => (
                <tr key={tx.paymentId} className="border-t border-brand-600/10 align-top">
                  <td className="whitespace-nowrap p-3 tabular-nums">{tx.atLocal}</td>
                  <td className="p-3">
                    <Link href={`/clients/${tx.customerId}`} className="hover:underline">
                      {tx.customer ?? "—"}
                    </Link>
                    {tx.customerNumber !== null && <span className="block text-xs text-brand-700/60">#{tx.customerNumber}</span>}
                  </td>
                  <td className="whitespace-nowrap p-3">{tx.contractNumber ?? "—"}</td>
                  <td className="whitespace-nowrap p-3">
                    <Link href={`/invoices/${tx.invoiceId}`} className="hover:underline">
                      {tx.invoiceNumber}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap p-3">{tx.unit ?? "—"}</td>
                  <td className="p-3">{paymentMethodLabel(tx.method)}</td>
                  <td className="p-3">{tx.reference ?? "—"}</td>
                  <td className="whitespace-nowrap p-3 text-right tabular-nums">{formatIDR(tx.amount)}</td>
                  <td className="p-3">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${tx.status === "SUCCEEDED" ? "bg-green-100 text-green-800" : tx.status === "PENDING" ? "bg-amber-100 text-amber-800" : tx.status === "FAILED" ? "bg-red-100 text-red-800" : "bg-brand-700/10"}`}>
                      {paymentStatusLabel(tx.status)}
                    </span>
                  </td>
                  <td className="p-3">{tx.recordedBy ?? "—"}</td>
                  <td className="p-3">{tx.verifiedBy ?? "—"}</td>
                </tr>
              ))}
              {data && data.transactions.length === 0 && (
                <tr className="border-t border-brand-600/10">
                  <td colSpan={11} className="p-4 text-center text-brand-700/60">
                    {t("reports.sales.noTransactions")}
                  </td>
                </tr>
              )}
            </tbody>
            {data && data.transactions.length > 0 && (
              <tfoot className="border-t-2 border-brand-600/20 bg-brand-700/[0.03] font-semibold">
                <tr>
                  <td className="p-3" colSpan={7}>
                    {t("reports.sales.paymentCount", { count: data.transactions.length })}
                  </td>
                  <td className="whitespace-nowrap p-3 text-right tabular-nums">{formatIDR(data.transactions.reduce((n, tx) => n + Number(tx.amount), 0))}</td>
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
