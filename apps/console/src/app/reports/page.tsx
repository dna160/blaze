"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import type { ArAgingResponse } from "@rentos/contracts";

import { ClientList } from "@/components/ClientList";
import { ConsoleShell } from "@/components/ConsoleShell";
import { apiDownload, apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

interface Occupancy {
  totalAssets: number;
  occupiedAssets: number;
  occupancyRate: number;
}
type ArAging = ArAgingResponse;

const HORIZONS = [30, 60, 90] as const;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
interface BookingFunnel {
  requested: number;
  approved: number;
  active: number;
}
interface MonthEndClose {
  period: { year: number; month: number };
  revenueRecognized: string;
  depositsHeld: string;
  accountsReceivable: string;
  refunds: string;
  taxPayable: string;
}

const FINANCE_ROLES = ["SUPER_ADMIN", "FINANCE_ADMIN", "VIEWER"];

function formatIDR(amount: number | string): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(
    Number(amount),
  );
}

function monthRange(yearMonth: string): { from: string; to: string } {
  const [year, month] = yearMonth.split("-").map(Number);
  const from = new Date(Date.UTC(year!, month! - 1, 1));
  const to = new Date(Date.UTC(year!, month!, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

/** PRD §7.2.6 P0 basic reporting: occupancy %, AR aging, booking funnel. */
function currentYearMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function ReportsPage() {
  const router = useRouter();
  const user = authClient.getUser();
  const canSeeFinance = user && FINANCE_ROLES.some((r) => user.roles.includes(r));

  const [occupancy, setOccupancy] = useState<Occupancy | null>(null);
  const [arAging, setArAging] = useState<ArAging | null>(null);
  const [asOf, setAsOf] = useState(todayIso());
  const [horizon, setHorizon] = useState<(typeof HORIZONS)[number]>(30);
  const [funnel, setFunnel] = useState<BookingFunnel | null>(null);
  const [yearMonth, setYearMonth] = useState(currentYearMonth());
  const [monthEnd, setMonthEnd] = useState<MonthEndClose | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    Promise.all([
      apiFetch<Occupancy>("/reports/occupancy", { token }),
      apiFetch<BookingFunnel>("/reports/booking-funnel", { token }),
    ])
      .then(([o, f]) => {
        setOccupancy(o);
        setFunnel(f);
      })
      .catch(() => router.push("/login"));
  }, [router]);

  // PRD v2 §5.2 — AR aging as of any date, with a 30/60/90-day forward horizon.
  useEffect(() => {
    const token = authClient.getToken();
    if (!token || !asOf) return;
    apiFetch<ArAging>(`/reports/ar-aging?asOf=${asOf}&horizonDays=${horizon}`, { token })
      .then(setArAging)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load AR aging."));
  }, [asOf, horizon]);

  useEffect(() => {
    if (!canSeeFinance) return;
    const token = authClient.getToken();
    if (!token) return;
    const [year, month] = yearMonth.split("-");
    apiFetch<MonthEndClose>(`/reports/month-end?year=${year}&month=${month}`, { token })
      .then(setMonthEnd)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load month-end close."));
  }, [canSeeFinance, yearMonth]);

  async function exportCsv(kind: "invoices" | "payments" | "ledger") {
    setExporting(kind);
    setError(null);
    try {
      const { from, to } = monthRange(yearMonth);
      await apiDownload(
        `/reports/export/${kind}.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        authClient.getToken(),
        `${kind}-${yearMonth}.csv`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Export failed.");
    } finally {
      setExporting(null);
    }
  }

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">Reports</h1>

      <div className="mt-6 grid gap-6 sm:grid-cols-3">
        <div className="rounded-lg border border-brand-600/10 bg-white p-5">
          <p className="text-sm text-brand-700/60">Occupancy</p>
          <p className="mt-2 text-3xl font-semibold">
            {occupancy ? `${Math.round(occupancy.occupancyRate * 100)}%` : "—"}
          </p>
          {occupancy && (
            <p className="mt-1 text-sm text-brand-700/60">
              {occupancy.occupiedAssets} / {occupancy.totalAssets} units
            </p>
          )}
        </div>
        <div className="rounded-lg border border-brand-600/10 bg-white p-5">
          <p className="text-sm text-brand-700/60">Bookings this cycle</p>
          <p className="mt-2 text-3xl font-semibold">{funnel?.active ?? "—"}</p>
          {funnel && (
            <p className="mt-1 text-sm text-brand-700/60">
              {funnel.requested} requested · {funnel.approved} approved
            </p>
          )}
        </div>
        <div className="rounded-lg border border-brand-600/10 bg-white p-5">
          <p className="text-sm text-brand-700/60">Overdue AR</p>
          <p className="mt-2 text-3xl font-semibold">{arAging ? formatIDR(arAging.overdue.total) : "—"}</p>
          {arAging && <p className="mt-1 text-sm text-brand-700/60">{formatIDR(arAging.comingDue.total)} coming due in {arAging.horizonDays} days</p>}
        </div>
      </div>

      <div className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">Accounts receivable aging</h2>
            <p className="text-sm text-brand-700/60">Pick a date to see what was overdue then and what falls due within the horizon after it.</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-brand-700/60">As of</label>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="rounded border border-brand-600/20 px-2 py-1 text-sm" />
            <div className="flex gap-1 rounded border border-brand-600/20 p-0.5 text-xs">
              {HORIZONS.map((h) => (
                <button key={h} onClick={() => setHorizon(h)} className={`rounded px-2.5 py-1 font-medium ${horizon === h ? "bg-brand-700 text-white" : "hover:bg-brand-700/5"}`}>
                  Next {h} days
                </button>
              ))}
            </div>
          </div>
        </div>
        {arAging && (
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <div className="overflow-hidden rounded-lg border border-brand-600/10 bg-white">
              <p className="border-b border-brand-600/10 bg-red-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-red-800">Overdue as of {new Date(arAging.asOf).toLocaleDateString("id-ID")} · {formatIDR(arAging.overdue.total)}</p>
              <table className="w-full text-sm">
                <thead className="bg-brand-700/5 text-left">
                  <tr>
                    <th className="p-3">Due today</th>
                    <th className="p-3">1–30 days</th>
                    <th className="p-3">31–60 days</th>
                    <th className="p-3">60+ days</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-brand-600/10">
                    <td className="p-3">{formatIDR(arAging.overdue.current)}</td>
                    <td className="p-3">{formatIDR(arAging.overdue.d1_30)}</td>
                    <td className="p-3">{formatIDR(arAging.overdue.d31_60)}</td>
                    <td className="p-3">{formatIDR(arAging.overdue.d60_plus)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="overflow-hidden rounded-lg border border-brand-600/10 bg-white">
              <p className="border-b border-brand-600/10 bg-blue-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-blue-800">Coming due in the next {arAging.horizonDays} days · {formatIDR(arAging.comingDue.total)}</p>
              <table className="w-full text-sm">
                <thead className="bg-brand-700/5 text-left">
                  <tr>
                    <th className="p-3">0–30 days</th>
                    <th className="p-3">31–60 days</th>
                    <th className="p-3">61–90 days</th>
                    <th className="p-3">Beyond horizon</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-brand-600/10">
                    <td className="p-3">{formatIDR(arAging.comingDue.d0_30)}</td>
                    <td className="p-3">{arAging.horizonDays >= 31 ? formatIDR(arAging.comingDue.d31_60) : "—"}</td>
                    <td className="p-3">{arAging.horizonDays >= 61 ? formatIDR(arAging.comingDue.d61_90) : "—"}</td>
                    <td className="p-3 text-brand-700/60">{formatIDR(arAging.comingDue.beyondHorizon)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-brand-700/50 lg:col-span-2">
              {arAging.invoiceCount} unpaid invoice{arAging.invoiceCount === 1 ? "" : "s"} · total outstanding {formatIDR(arAging.totalOutstanding)} (includes scheduled payments from term contracts).
            </p>
          </div>
        )}
      </div>

      {canSeeFinance && (
        <div className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Month-end close</h2>
            <input
              type="month"
              value={yearMonth}
              onChange={(e) => setYearMonth(e.target.value)}
              className="rounded border border-brand-600/20 px-2 py-1 text-sm"
            />
          </div>
          <p className="mt-1 text-sm text-brand-700/60">
            Revenue recognized and refunds are this month's movement; deposits held, AR, and tax payable are the
            balance as of the end of this month.
          </p>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

          <div className="mt-4 grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {[
              { label: "Revenue recognized", value: monthEnd?.revenueRecognized },
              { label: "Deposits held", value: monthEnd?.depositsHeld },
              { label: "Accounts receivable", value: monthEnd?.accountsReceivable },
              { label: "Refunds", value: monthEnd?.refunds },
              { label: "Tax payable", value: monthEnd?.taxPayable },
            ].map((tile) => (
              <div key={tile.label} className="rounded-lg border border-brand-600/10 bg-white p-4">
                <p className="text-xs text-brand-700/60">{tile.label}</p>
                <p className="mt-1 text-xl font-semibold">{tile.value !== undefined ? formatIDR(tile.value) : "—"}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {(["invoices", "payments", "ledger"] as const).map((kind) => (
              <button
                key={kind}
                onClick={() => exportCsv(kind)}
                disabled={exporting === kind}
                className="rounded border border-brand-600/20 px-3 py-2 text-sm font-medium hover:bg-brand-700/5 disabled:opacity-50"
              >
                {exporting === kind ? "Exporting..." : `Export ${kind}.csv`}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* PRD v2 §5.2 — "Right below Export invoices": the client list with search, filter and status. */}
      <div className="mt-8">
        <h2 className="text-lg font-medium">Clients</h2>
        <p className="mb-3 text-sm text-brand-700/60">
          Who&apos;s renting what, since when, and whether they&apos;re healthy (paid ahead), risky (due within 7 days), overdue, or inactive. Click a client for details.
        </p>
        <ClientList compact />
      </div>
    </ConsoleShell>
  );
}
