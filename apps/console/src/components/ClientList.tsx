"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ClientListResponse, CustomerHealthValue } from "@rentos/contracts";

import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

export const HEALTH_STYLE: Record<CustomerHealthValue, { label: string; className: string; hint: string }> = {
  HEALTHY: { label: "Healthy", className: "bg-green-100 text-green-800", hint: "Paid ahead — nothing due within 7 days" },
  RISKY: { label: "Risky", className: "bg-amber-100 text-amber-800", hint: "Payment due within 7 days" },
  OVERDUE: { label: "Overdue", className: "bg-red-100 text-red-800", hint: "Payment already past due" },
  INACTIVE: { label: "Inactive", className: "bg-gray-200 text-gray-700", hint: "No current rental" },
};

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}

function fmtDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" }) : "—";
}

/**
 * PRD v2 §5.2 — the client list: search (name / phone / email / unit),
 * status filter, and the four-way health status. Rendered under the
 * export buttons on Reports and on its own /clients page; clicking a row
 * opens /clients/:id.
 */
export function ClientList({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<ClientListResponse | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<CustomerHealthValue | "">("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = authClient.getToken();
    if (!token) return;
    const params = new URLSearchParams({ page: String(page), pageSize: compact ? "10" : "25" });
    if (search.trim()) params.set("search", search.trim());
    if (status) params.set("status", status);
    const handle = setTimeout(() => {
      apiFetch<ClientListResponse>(`/customers/clients?${params.toString()}`, { token })
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load clients."));
    }, 200);
    return () => clearTimeout(handle);
  }, [search, status, page, compact]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder="Search name, phone, email, or unit…"
          className="w-72 rounded border border-brand-600/20 px-3 py-1.5 text-sm"
        />
        <div className="flex gap-1 rounded border border-brand-600/20 p-0.5 text-xs">
          {(["", "HEALTHY", "RISKY", "OVERDUE", "INACTIVE"] as const).map((s) => (
            <button
              key={s || "ALL"}
              onClick={() => {
                setStatus(s);
                setPage(1);
              }}
              className={`rounded px-2.5 py-1 font-medium ${status === s ? "bg-brand-700 text-white" : "hover:bg-brand-700/5"}`}
              title={s ? HEALTH_STYLE[s].hint : "Everyone"}
            >
              {s ? HEALTH_STYLE[s].label : "All"}
              {data && s ? ` (${data.counts[s]})` : data && !s ? ` (${Object.values(data.counts).reduce((a, b) => a + b, 0)})` : ""}
            </button>
          ))}
        </div>
        {!compact && (
          <Link href="/clients" className="ml-auto text-sm text-brand-700/60 underline">
            Open full client list
          </Link>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-3 overflow-x-auto rounded-lg border border-brand-600/10 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-brand-700/5 text-left">
            <tr>
              <th className="p-3">Client</th>
              <th className="p-3">Unit(s)</th>
              <th className="p-3">Move-in</th>
              <th className="p-3">Status</th>
              <th className="p-3">Next due</th>
              <th className="p-3 text-right">Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {!data && (
              <tr>
                <td className="p-3 text-brand-700/60" colSpan={6}>
                  Loading…
                </td>
              </tr>
            )}
            {data && data.items.length === 0 && (
              <tr>
                <td className="p-3 text-brand-700/60" colSpan={6}>
                  No clients match.
                </td>
              </tr>
            )}
            {data?.items.map((c) => {
              const style = HEALTH_STYLE[c.health];
              return (
                <tr key={c.id} className="border-t border-brand-600/10 hover:bg-brand-700/5">
                  <td className="p-3">
                    <Link href={`/clients/${c.id}`} className="font-medium hover:underline">
                      {c.fullName ?? c.phone ?? c.email ?? "—"}
                    </Link>
                    <p className="text-xs text-brand-700/60">
                      {c.preferredChannel === "EMAIL" ? c.email : c.phone}
                      {c.kycStatus === "VERIFIED" ? " · KYC ✓" : ""}
                    </p>
                  </td>
                  <td className="p-3">
                    {c.units.length === 0 ? (
                      <span className="text-brand-700/40">—</span>
                    ) : (
                      c.units.map((u) => (
                        <p key={u.bookingId} className="text-xs">
                          <span className="font-medium">{u.code ?? "(no unit)"}</span> · {u.assetTypeName}
                          {u.locationName ? ` · ${u.locationName}` : ""}
                          <span className="text-brand-700/50"> · {u.status.replace(/_/g, " ").toLowerCase()}</span>
                        </p>
                      ))
                    )}
                  </td>
                  <td className="p-3">{fmtDate(c.moveInDate)}</td>
                  <td className="p-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${style.className}`} title={style.hint}>
                      {style.label}
                    </span>
                    {c.overdueCount > 0 && <p className="text-xs text-red-700">{c.overdueCount} overdue</p>}
                  </td>
                  <td className="p-3">
                    {c.nextDueDate ? (
                      <>
                        {fmtDate(c.nextDueDate)}
                        {c.nextDueAmount && <p className="text-xs text-brand-700/60">{formatIDR(c.nextDueAmount)}</p>}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="p-3 text-right">{Number(c.outstandingAmount) > 0 ? formatIDR(c.outstandingAmount) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data && totalPages > 1 && (
        <div className="mt-2 flex items-center justify-end gap-2 text-xs text-brand-700/60">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border border-brand-600/20 px-2 py-1 disabled:opacity-40">
            Prev
          </button>
          Page {page} / {totalPages}
          <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded border border-brand-600/20 px-2 py-1 disabled:opacity-40">
            Next
          </button>
        </div>
      )}
    </div>
  );
}
