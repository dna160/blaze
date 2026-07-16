"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch } from "@/lib/api";
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

function formatIDR(amount: number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(amount);
}

/** PRD §7.2.6 P0 basic reporting: occupancy %, AR aging, booking funnel. */
export default function ReportsPage() {
  const router = useRouter();
  const [occupancy, setOccupancy] = useState<Occupancy | null>(null);
  const [arAging, setArAging] = useState<ArAging | null>(null);
  const [funnel, setFunnel] = useState<BookingFunnel | null>(null);

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
    </ConsoleShell>
  );
}
