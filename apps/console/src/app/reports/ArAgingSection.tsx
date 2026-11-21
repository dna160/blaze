"use client";

import { zonedDateString, type ArAgingBucketKey, type ArAgingResponse, type ArAgingRow } from "@rentos/contracts";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import type { ReportRangeValue } from "@/components/ReportRange";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { getLocale, tr, useT } from "@/lib/i18n";

import { DownloadCsvButton, formatDay, formatIDR, invoiceStatusLabel, LoadError, SectionHeader } from "./report-ui";

/**
 * PRD go-live 2 §2.5 — AR aging keeps its buckets; every bucket opens into
 * the invoices behind it, and "Per pelanggan" groups the same rows by
 * customer. The report date is the end of the selected range (or today, when
 * the range runs into the future — what is unpaid is only known up to now).
 */

const HORIZONS = [30, 60, 90] as const;

/** A bucket's name in the reader's language (`reports.ar.bucket.<key>`). */
const bucketLabel = (b: ArAgingBucketKey) => tr(`reports.ar.bucket.${b}`);

const OVERDUE: ArAgingBucketKey[] = ["overdue_current", "overdue_1_30", "overdue_31_60", "overdue_60_plus"];
const COMING: ArAgingBucketKey[] = ["coming_0_30", "coming_31_60", "coming_61_90", "beyond_horizon"];

function bucketAmount(a: ArAgingResponse, b: ArAgingBucketKey): string {
  switch (b) {
    case "overdue_current":
      return a.overdue.current;
    case "overdue_1_30":
      return a.overdue.d1_30;
    case "overdue_31_60":
      return a.overdue.d31_60;
    case "overdue_60_plus":
      return a.overdue.d60_plus;
    case "coming_0_30":
      return a.comingDue.d0_30;
    case "coming_31_60":
      return a.comingDue.d31_60;
    case "coming_61_90":
      return a.comingDue.d61_90;
    case "beyond_horizon":
      return a.comingDue.beyondHorizon;
  }
}

function lateness(days: number): string {
  if (days > 0) return tr("reports.ar.daysLate", { count: days, days });
  if (days === 0) return tr("reports.ar.dueThatDay");
  return tr("reports.ar.daysToGo", { count: -days, days: -days });
}

function reminderTime(iso: string | null, timeZone: string): string {
  if (!iso) return tr("reports.ar.never");
  return new Intl.DateTimeFormat(getLocale() === "en" ? "en-GB" : "id-ID", { timeZone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function ArAgingSection({ range, timeZone }: { range: ReportRangeValue; timeZone: string }) {
  const { t } = useT();
  const today = zonedDateString(new Date(), timeZone);
  const asOf = range.to < today ? range.to : today;
  const [horizon, setHorizon] = useState<(typeof HORIZONS)[number]>(30);
  const [data, setData] = useState<ArAgingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bucket, setBucket] = useState<ArAgingBucketKey | null>(null);
  const [perCustomer, setPerCustomer] = useState(false);

  useEffect(() => {
    const token = authClient.getToken();
    if (!token) return;
    let cancelled = false;
    setError(null);
    apiFetch<ArAgingResponse>(`/reports/ar-aging?asOf=${asOf}&horizonDays=${horizon}`, { token })
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : tr("reports.ar.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [asOf, horizon]);

  const rows = useMemo(() => (data?.rows ?? []).filter((r) => bucket === null || r.bucket === bucket), [data, bucket]);
  const byCustomer = useMemo(() => {
    const groups = new Map<string, { customerId: string; customer: string | null; customerNumber: number | null; rows: ArAgingRow[]; total: number; maxDays: number }>();
    for (const r of rows) {
      const g = groups.get(r.customerId) ?? { customerId: r.customerId, customer: r.customer, customerNumber: r.customerNumber, rows: [], total: 0, maxDays: -Infinity };
      g.rows.push(r);
      g.total += Number(r.amountOutstanding);
      g.maxDays = Math.max(g.maxDays, r.daysOverdue);
      groups.set(r.customerId, g);
    }
    return [...groups.values()].sort((a, b) => b.total - a.total);
  }, [rows]);

  const bucketCard = (b: ArAgingBucketKey) => {
    if (!data) return null;
    const disabled = (b === "coming_31_60" && data.horizonDays < 31) || (b === "coming_61_90" && data.horizonDays < 61);
    const count = (data.rows ?? []).filter((r) => r.bucket === b).length;
    const on = bucket === b;
    return (
      <button
        key={b}
        type="button"
        disabled={disabled}
        onClick={() => setBucket(on ? null : b)}
        aria-pressed={on}
        className={`rounded border p-3 text-left text-sm ${on ? "border-brand-700 bg-brand-700 text-white" : "border-brand-600/15 bg-white hover:bg-brand-700/5"} disabled:opacity-40`}
      >
        <span className={`block text-xs ${on ? "text-white/80" : "text-brand-700/60"}`}>{bucketLabel(b)}</span>
        <span className="mt-1 block text-base font-semibold tabular-nums">{disabled ? "—" : formatIDR(bucketAmount(data, b))}</span>
        <span className={`block text-xs ${on ? "text-white/80" : "text-brand-700/60"}`}>{disabled ? t("reports.ar.bucket.beyond_horizon") : t("reports.sales.invoiceCount", { count })}</span>
      </button>
    );
  };

  return (
    <section data-testid="ar-aging-section">
      <SectionHeader
        title={t("reports.ar.title")}
        hint={t(asOf !== range.to ? "reports.ar.hintFuture" : "reports.ar.hint", { date: formatDay(asOf) })}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 rounded border border-brand-600/20 p-0.5 text-xs">
              {HORIZONS.map((h) => (
                <button key={h} type="button" onClick={() => setHorizon(h)} aria-pressed={horizon === h} className={`rounded px-2.5 py-1 font-medium ${horizon === h ? "bg-brand-700 text-white" : "hover:bg-brand-700/5"}`}>
                  {t("reports.ar.horizon", { days: h })}
                </button>
              ))}
            </div>
            <DownloadCsvButton path={`/reports/export/ar-aging.csv?asOf=${asOf}&horizonDays=${horizon}`} fallbackName="ar-aging.csv" />
          </div>
        }
      />
      <LoadError message={error} />

      {data && (
        <>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <p className="rounded-t border border-b-0 border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-red-800">
                {t("reports.ar.overdueTotal", { amount: formatIDR(data.overdue.total) })}
              </p>
              <div className="grid grid-cols-2 gap-2 rounded-b border border-red-200 bg-red-50/40 p-2 sm:grid-cols-4">{OVERDUE.map(bucketCard)}</div>
            </div>
            <div>
              <p className="rounded-t border border-b-0 border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-blue-800">
                {t("reports.ar.comingTotal", { days: data.horizonDays, amount: formatIDR(data.comingDue.total) })}
              </p>
              <div className="grid grid-cols-2 gap-2 rounded-b border border-blue-200 bg-blue-50/40 p-2 sm:grid-cols-4">{COMING.map(bucketCard)}</div>
            </div>
          </div>
          <p className="mt-2 text-xs text-brand-700/60">{t("reports.ar.totalLine", { count: data.invoiceCount, amount: formatIDR(data.totalOutstanding) })}</p>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-medium">
              {t("reports.ar.groupLine", {
                label: bucket ? bucketLabel(bucket) : t("reports.ar.allUnpaid"),
                count: rows.length,
                amount: formatIDR(rows.reduce((n, r) => n + Number(r.amountOutstanding), 0)),
              })}
            </h3>
            <div className="flex items-center gap-3 text-sm">
              {bucket && (
                <button type="button" onClick={() => setBucket(null)} className="text-brand-700/70 underline">
                  {t("reports.ar.showAll")}
                </button>
              )}
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={perCustomer} onChange={(e) => setPerCustomer(e.target.checked)} />
                <span>{t("reports.ar.perCustomer")}</span>
              </label>
            </div>
          </div>

          <div className="mt-3 overflow-x-auto rounded-lg border border-brand-600/10 bg-white">
            {perCustomer ? (
              <table className="w-full text-sm" data-testid="ar-by-customer">
                <thead className="bg-brand-700/5 text-left">
                  <tr>
                    <th className="p-3">{t("common.customer")}</th>
                    <th className="p-3">{t("common.invoice")}</th>
                    <th className="p-3">{t("common.unit")}</th>
                    <th className="p-3">{t("reports.ar.colMostLate")}</th>
                    <th className="p-3 text-right">{t("reports.ar.colTotalUnpaid")}</th>
                  </tr>
                </thead>
                <tbody>
                  {byCustomer.map((g) => (
                    <tr key={g.customerId} className="border-t border-brand-600/10 align-top">
                      <td className="p-3">
                        <Link href={`/clients/${g.customerId}`} className="hover:underline">
                          {g.customer ?? "—"}
                        </Link>
                        {g.customerNumber !== null && <span className="block text-xs text-brand-700/60">#{g.customerNumber}</span>}
                      </td>
                      <td className="p-3">
                        {g.rows.map((r) => (
                          <Link key={r.invoiceId} href={`/invoices/${r.invoiceId}`} className="block hover:underline">
                            {r.invoiceNumber} <span className="text-xs text-brand-700/60">· {formatDay(r.dueDate)}</span>
                          </Link>
                        ))}
                      </td>
                      <td className="p-3">{[...new Set(g.rows.map((r) => r.unit).filter(Boolean))].join(", ") || "—"}</td>
                      <td className="p-3">{lateness(g.maxDays)}</td>
                      <td className="p-3 text-right font-medium tabular-nums">{formatIDR(g.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="w-full text-sm" data-testid="ar-rows">
                <thead className="bg-brand-700/5 text-left">
                  <tr>
                    <th className="p-3">{t("common.customer")}</th>
                    <th className="p-3">{t("common.contractNumber")}</th>
                    <th className="p-3">{t("common.invoiceNumber")}</th>
                    <th className="p-3">{t("common.unit")}</th>
                    <th className="p-3">{t("common.dueDate")}</th>
                    <th className="p-3">{t("reports.ar.colDaysLate")}</th>
                    <th className="p-3 text-right">{t("reports.ar.colUnpaid")}</th>
                    <th className="p-3">{t("reports.ar.colLastReminder")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.invoiceId} className="border-t border-brand-600/10 align-top">
                      <td className="p-3">
                        <Link href={`/clients/${r.customerId}`} className="hover:underline">
                          {r.customer ?? "—"}
                        </Link>
                        {r.customerNumber !== null && <span className="block text-xs text-brand-700/60">#{r.customerNumber}</span>}
                      </td>
                      <td className="whitespace-nowrap p-3">{r.contractNumber ?? "—"}</td>
                      <td className="whitespace-nowrap p-3">
                        <Link href={`/invoices/${r.invoiceId}`} className="hover:underline">
                          {r.invoiceNumber}
                        </Link>
                        <span className="block text-xs text-brand-700/60">{invoiceStatusLabel(r.status)}</span>
                      </td>
                      <td className="whitespace-nowrap p-3">{r.unit ?? "—"}</td>
                      <td className="whitespace-nowrap p-3">{formatDay(r.dueDate)}</td>
                      <td className={`whitespace-nowrap p-3 ${r.daysOverdue > 0 ? "font-medium text-red-700" : ""}`}>{lateness(r.daysOverdue)}</td>
                      <td className="whitespace-nowrap p-3 text-right tabular-nums">{formatIDR(r.amountOutstanding)}</td>
                      <td className="p-3 text-xs">{reminderTime(r.lastReminderAt, timeZone)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {rows.length === 0 && <p className="p-4 text-center text-sm text-brand-700/60">{t("reports.ar.emptyGroup")}</p>}
          </div>
        </>
      )}
    </section>
  );
}
