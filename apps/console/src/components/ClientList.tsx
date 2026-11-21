"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ClientListResponse, CustomerHealthValue } from "@rentos/contracts";

import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { getLocale, tr, useT } from "@/lib/i18n";

/** Badge colour per health; the words are `clients.health.<VALUE>` and `…Hint`. */
export const HEALTH_STYLE: Record<CustomerHealthValue, { className: string }> = {
  HEALTHY: { className: "bg-green-100 text-green-800" },
  RISKY: { className: "bg-amber-100 text-amber-800" },
  OVERDUE: { className: "bg-red-100 text-red-800" },
  INACTIVE: { className: "bg-gray-200 text-gray-700" },
};
const healthLabel = (h: CustomerHealthValue) => tr(`clients.health.${h}`);
const healthHint = (h: CustomerHealthValue) => tr(`clients.health.${h}Hint`);

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}

function fmtDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString(getLocale() === "en" ? "en-GB" : "id-ID", { day: "numeric", month: "short", year: "numeric" }) : "—";
}

/**
 * PRD v2 §5.2 — the client list: search (name / phone / email / unit),
 * status filter, and the four-way health status. Rendered under the
 * export buttons on Reports and on its own /clients page; clicking a row
 * opens /clients/:id.
 */
export function ClientList({ compact = false }: { compact?: boolean }) {
  const { t, s: statusWord } = useT();
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
        .catch((err) => setError(err instanceof ApiError ? err.message : tr("clients.loadFailed")));
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
          placeholder={t("clients.searchPlaceholder")}
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
              title={s ? healthHint(s) : t("clients.everyone")}
            >
              {s ? healthLabel(s) : t("common.all")}
              {data && s ? ` (${data.counts[s]})` : data && !s ? ` (${Object.values(data.counts).reduce((a, b) => a + b, 0)})` : ""}
            </button>
          ))}
        </div>
        {!compact && (
          <Link href="/clients" className="ml-auto text-sm text-brand-700/60 underline">
            {t("clients.openFull")}
          </Link>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-3 overflow-x-auto rounded-lg border border-brand-600/10 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-brand-700/5 text-left">
            <tr>
              <th className="p-3">{t("clients.colClient")}</th>
              <th className="p-3">{t("clients.colUnits")}</th>
              <th className="p-3">{t("clients.colMoveIn")}</th>
              <th className="p-3">{t("common.status")}</th>
              <th className="p-3">{t("clients.colNextDue")}</th>
              <th className="p-3 text-right">{t("clients.colOutstanding")}</th>
            </tr>
          </thead>
          <tbody>
            {!data && (
              <tr>
                <td className="p-3 text-brand-700/60" colSpan={6}>
                  {t("common.loading")}
                </td>
              </tr>
            )}
            {data && data.items.length === 0 && (
              <tr>
                <td className="p-3 text-brand-700/60" colSpan={6}>
                  {t("clients.noMatch")}
                </td>
              </tr>
            )}
            {data?.items.map((c) => {
              const style = { className: HEALTH_STYLE[c.health].className, label: healthLabel(c.health), hint: healthHint(c.health) };
              return (
                <tr key={c.id} className="border-t border-brand-600/10 hover:bg-brand-700/5">
                  <td className="p-3">
                    <Link href={`/clients/${c.id}`} className="font-medium hover:underline">
                      {c.fullName ?? c.phone ?? c.email ?? "—"}
                    </Link>
                    <p className="text-xs text-brand-700/60">
                      {c.preferredChannel === "EMAIL" ? c.email : c.phone}
                      {c.kycStatus === "VERIFIED" ? ` · ${t("clients.kycOk")}` : c.kycStatus === "VERIFIED_LEGACY" ? ` · ${t("clients.kycOkLegacy")}` : ""}
                    </p>
                  </td>
                  <td className="p-3">
                    {c.units.length === 0 ? (
                      <span className="text-brand-700/40">—</span>
                    ) : (
                      c.units.map((u) => (
                        <p key={u.bookingId} className="text-xs">
                          <span className="font-medium">{u.code ?? t("clients.noUnit")}</span> · {u.assetTypeName}
                          {u.locationName ? ` · ${u.locationName}` : ""}
                          <span className="text-brand-700/50"> · {statusWord(u.status)}</span>
                        </p>
                      ))
                    )}
                  </td>
                  <td className="p-3">{fmtDate(c.moveInDate)}</td>
                  <td className="p-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${style.className}`} title={style.hint}>
                      {style.label}
                    </span>
                    {c.overdueCount > 0 && <p className="text-xs text-red-700">{t("clients.overdueCount", { count: c.overdueCount })}</p>}
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
            {t("clients.prev")}
          </button>
          {t("clients.page", { page, pages: totalPages })}
          <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded border border-brand-600/20 px-2 py-1 disabled:opacity-40">
            {t("clients.next")}
          </button>
        </div>
      )}
    </div>
  );
}
