"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiDownload, apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

interface Occupancy {
  totalAssets: number;
  occupiedAssets: number;
  occupancyRate: number;
}
interface ArAging {
  current: number;
  d1_30: number;
  d31_60: number;
  d60_plus: number;
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
      apiFetch<ArAging>("/reports/ar-aging", { token }),
      apiFetch<BookingFunnel>("/reports/booking-funnel", { token }),
    ])
      .then(([o, a, f]) => {
        setOccupancy(o);
        setArAging(a);
        setFunnel(f);
      })
      .catch(() => router.push("/login"));
  }, [router]);

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
          <p className="text-sm text-brand-700/60">AR &gt; 30 days</p>
          <p className="mt-2 text-3xl font-semibold">
            {arAging ? formatIDR(arAging.d31_60 + arAging.d60_plus) : "—"}
          </p>
        </div>
      </div>

      {arAging && (
        <div className="mt-8">
          <h2 className="text-lg font-medium">AR aging</h2>
          <div className="mt-3 overflow-hidden rounded-lg border border-brand-600/10 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-brand-700/5 text-left">
                <tr>
                  <th className="p-3">Current</th>
                  <th className="p-3">1-30 days</th>
                  <th className="p-3">31-60 days</th>
                  <th className="p-3">60+ days</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-brand-600/10">
                  <td className="p-3">{formatIDR(arAging.current)}</td>
                  <td className="p-3">{formatIDR(arAging.d1_30)}</td>
                  <td className="p-3">{formatIDR(arAging.d31_60)}</td>
                  <td className="p-3">{formatIDR(arAging.d60_plus)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

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
    </ConsoleShell>
  );
}
