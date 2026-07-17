"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

type AssetStatus = "AVAILABLE" | "RESERVED" | "OCCUPIED" | "MAINTENANCE" | "RETIRED";

interface UnitMapAsset {
  id: string;
  code: string;
  status: AssetStatus;
  statusReason: string | null;
  assetType: { name: string };
  location: { id: string; name: string };
  bookings: Array<{
    startDate: string;
    customer: { fullName: string | null; phone: string };
    invoices: Array<{ periodEnd: string | null }>;
  }>;
}

const STATUS_COLORS: Record<AssetStatus, string> = {
  AVAILABLE: "bg-green-100 text-green-800",
  RESERVED: "bg-amber-100 text-amber-800",
  OCCUPIED: "bg-blue-100 text-blue-800",
  MAINTENANCE: "bg-gray-200 text-gray-700",
  RETIRED: "bg-red-100 text-red-800",
};

const GRID_COLORS: Record<AssetStatus, string> = {
  AVAILABLE: "bg-green-500 hover:bg-green-600",
  RESERVED: "bg-amber-500 hover:bg-amber-600",
  OCCUPIED: "bg-blue-500 hover:bg-blue-600",
  MAINTENANCE: "bg-gray-400 hover:bg-gray-500",
  RETIRED: "bg-red-500 hover:bg-red-600",
};

/** Groups by the unit code's leading letters ("A-01" -> row "A") — a pragmatic grid without requiring tenants to have populated explicit x/y coordinates. */
function rowOf(code: string): string {
  return code.match(/^[A-Za-z]+/)?.[0] ?? code;
}

function formatDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString("id-ID") : "—";
}

/** PRD §7.2.2: visual unit map (grid/floor layout, P1) + occupancy view (who's in which unit, since when, paid-through date; P0), combined into one staff-only view. */
export default function AssetsPage() {
  const router = useRouter();
  const [assets, setAssets] = useState<UnitMapAsset[] | null>(null);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selected, setSelected] = useState<UnitMapAsset | null>(null);

  useEffect(() => {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    apiFetch<UnitMapAsset[]>("/catalog/assets/unit-map", { token })
      .then(setAssets)
      .catch(() => router.push("/login"));
  }, [router]);

  const groups = useMemo(() => {
    if (!assets) return [];
    const byLocation = new Map<string, Map<string, UnitMapAsset[]>>();
    for (const asset of assets) {
      const locKey = asset.location.name;
      if (!byLocation.has(locKey)) byLocation.set(locKey, new Map());
      const byRow = byLocation.get(locKey)!;
      const rowKey = rowOf(asset.code);
      if (!byRow.has(rowKey)) byRow.set(rowKey, []);
      byRow.get(rowKey)!.push(asset);
    }
    return [...byLocation.entries()].map(([location, rows]) => ({
      location,
      rows: [...rows.entries()].sort(([a], [b]) => a.localeCompare(b)),
    }));
  }, [assets]);

  return (
    <ConsoleShell>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Inventory</h1>
        <div className="flex gap-2 text-sm">
          <button
            onClick={() => setView("grid")}
            className={`rounded px-3 py-1.5 font-medium ${view === "grid" ? "bg-brand-700 text-white" : "border border-brand-600/20 hover:bg-brand-700/5"}`}
          >
            Unit map
          </button>
          <button
            onClick={() => setView("list")}
            className={`rounded px-3 py-1.5 font-medium ${view === "list" ? "bg-brand-700 text-white" : "border border-brand-600/20 hover:bg-brand-700/5"}`}
          >
            List
          </button>
        </div>
      </div>

      {!assets ? (
        <p className="mt-6">Loading...</p>
      ) : view === "list" ? (
        <div className="mt-6 overflow-hidden rounded-lg border border-brand-600/10 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-brand-700/5 text-left">
              <tr>
                <th className="p-3">Code</th>
                <th className="p-3">Location</th>
                <th className="p-3">Type</th>
                <th className="p-3">Status</th>
                <th className="p-3">Occupant</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => {
                const booking = a.bookings[0];
                return (
                  <tr key={a.id} className="border-t border-brand-600/10">
                    <td className="p-3 font-medium">{a.code}</td>
                    <td className="p-3">{a.location.name}</td>
                    <td className="p-3">{a.assetType.name}</td>
                    <td className="p-3">
                      <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_COLORS[a.status]}`}>
                        {a.status}
                      </span>
                    </td>
                    <td className="p-3 text-brand-700/70">
                      {booking ? (booking.customer.fullName ?? booking.customer.phone) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-6 space-y-8">
          <div className="flex flex-wrap gap-4 text-xs">
            {(Object.keys(GRID_COLORS) as AssetStatus[]).map((s) => (
              <div key={s} className="flex items-center gap-1.5">
                <span className={`h-3 w-3 rounded ${GRID_COLORS[s].split(" ")[0]}`} />
                {s}
              </div>
            ))}
          </div>

          {groups.map((g) => (
            <div key={g.location}>
              <h2 className="text-lg font-medium">{g.location}</h2>
              <div className="mt-3 space-y-3">
                {g.rows.map(([row, units]) => (
                  <div key={row} className="flex items-center gap-2">
                    <span className="w-6 shrink-0 text-xs font-semibold text-brand-700/50">{row}</span>
                    <div className="flex flex-wrap gap-2">
                      {units.map((a) => (
                        <button
                          key={a.id}
                          onClick={() => setSelected(a)}
                          title={a.code}
                          className={`flex h-10 w-14 items-center justify-center rounded text-xs font-medium text-white transition ${GRID_COLORS[a.status]} ${selected?.id === a.id ? "ring-2 ring-offset-2 ring-brand-700" : ""}`}
                        >
                          {a.code}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {selected && (
            <div className="rounded-lg border border-brand-600/10 bg-white p-5">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-medium">
                    {selected.code} · {selected.assetType.name}
                  </h3>
                  <p className="mt-1 text-sm text-brand-700/60">
                    {selected.location.name} · <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[selected.status]}`}>{selected.status}</span>
                  </p>
                </div>
                <button onClick={() => setSelected(null)} className="text-sm text-brand-700/50 hover:text-brand-700">
                  Close
                </button>
              </div>
              {selected.statusReason && <p className="mt-2 text-sm text-brand-700/70">Reason: {selected.statusReason}</p>}
              {selected.bookings[0] ? (
                <dl className="mt-3 grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <dt className="text-brand-700/50">Occupant</dt>
                    <dd>{selected.bookings[0].customer.fullName ?? selected.bookings[0].customer.phone}</dd>
                  </div>
                  <div>
                    <dt className="text-brand-700/50">Since</dt>
                    <dd>{formatDate(selected.bookings[0].startDate)}</dd>
                  </div>
                  <div>
                    <dt className="text-brand-700/50">Paid through</dt>
                    <dd>{formatDate(selected.bookings[0].invoices[0]?.periodEnd)}</dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-3 text-sm text-brand-700/60">No active tenant.</p>
              )}
            </div>
          )}
        </div>
      )}
    </ConsoleShell>
  );
}
