"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ConsoleShell } from "@/components/ConsoleShell";
import { formatDay, formatIDR, rentalOrderStatusLabel, RentalOrderStatusChip } from "@/components/RentalOrderStatus";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useT } from "@/lib/i18n";

/**
 * PRD go-live 2 §10.2 (part 1 §13) — "Pesanan sewa": the monthly rental
 * orders (C4 model: each month is its own closed-ended order, renewals chain
 * to the previous one). Read-mostly list; actions live on the detail page.
 */

interface OrderRow {
  id: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  customer: { id: string; customerNumber: number | null; fullName: string | null; companyName: string | null; phone: string | null };
  asset: { id: string; code: string } | null;
  assetType: { id: string; name: string };
  previousOrderId: string | null;
  latestInvoice: { id: string; invoiceNumber: string; status: string; totalAmount: string; dueDate: string } | null;
}

const FILTERS = ["", "PENDING_APPROVAL", "AWAITING_PAYMENT", "ACTIVE", "RENEWAL_OFFERED", "EXPIRING", "COMPLETED", "CANCELLED"];

export default function RentalOrdersPage() {
  const { t: tt, s: sl } = useT();
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [data, setData] = useState<{ items: OrderRow[]; counts: Record<string, number> } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    const q = new URLSearchParams();
    if (status) q.set("status", status);
    if (search.trim()) q.set("search", search.trim());
    const t = window.setTimeout(() => {
      apiFetch<{ items: OrderRow[]; counts: Record<string, number> }>(`/rental-orders?${q}`, { token })
        .then((r) => {
          setData(r);
          setError(null);
        })
        .catch((e) => setError(e instanceof ApiError ? e.message : tt("rentalOrders.loadFailed")));
    }, 200);
    return () => window.clearTimeout(t);
  }, [router, status, search]);

  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">{tt("rentalOrders.title")}</h1>
      <p className="mt-1 text-sm text-brand-700/70">{tt("rentalOrders.intro")}</p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {FILTERS.map((s) => (
          <button
            key={s || "all"}
            type="button"
            onClick={() => setStatus(s)}
            aria-pressed={status === s}
            className={`rounded px-3 py-1.5 text-sm ${status === s ? "bg-brand-700 text-white" : "border border-brand-600/15 bg-white hover:bg-brand-700/5"}`}
          >
            {s ? rentalOrderStatusLabel(s) : tt("common.all")} ({s ? (data?.counts[s] ?? 0) : total})
          </button>
        ))}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={tt("rentalOrders.searchPlaceholder")}
          className="ml-auto w-72 rounded border border-brand-600/20 px-3 py-1.5 text-sm"
        />
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      {!data && !error && <p className="mt-4 text-sm text-brand-700/60">{tt("common.loading")}</p>}
      {data && data.items.length === 0 && <p className="mt-6 text-sm text-brand-700/60">{tt("rentalOrders.empty")}</p>}
      {data && data.items.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded border border-brand-600/10 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-brand-700/5 text-left text-xs text-brand-700/70">
              <tr>
                <th className="px-3 py-2">{tt("common.period")}</th>
                <th className="px-3 py-2">{tt("common.customer")}</th>
                <th className="px-3 py-2">{tt("common.unit")}</th>
                <th className="px-3 py-2">{tt("common.status")}</th>
                <th className="px-3 py-2">{tt("rentalOrders.latestInvoice")}</th>
                <th className="px-3 py-2 text-right">{tt("common.amount")}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((o) => (
                <tr key={o.id} className="border-t border-brand-600/10 hover:bg-brand-700/5">
                  <td className="px-3 py-2">
                    <Link href={`/rental-orders/${o.id}`} className="font-medium hover:underline">
                      {formatDay(o.periodStart)} – {formatDay(o.periodEnd)}
                    </Link>
                    {o.previousOrderId && <span className="ml-1 text-xs text-brand-700/60">{tt("rentalOrders.renewalTag")}</span>}
                  </td>
                  <td className="px-3 py-2">
                    <Link href={`/clients/${o.customer.id}`} className="hover:underline">
                      #{o.customer.customerNumber ?? "-"} {o.customer.companyName ?? o.customer.fullName ?? o.customer.phone}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    {o.asset?.code ?? "-"} <span className="text-xs text-brand-700/60">{o.assetType.name}</span>
                  </td>
                  <td className="px-3 py-2">
                    <RentalOrderStatusChip status={o.status} />
                  </td>
                  <td className="px-3 py-2">
                    {o.latestInvoice ? (
                      <Link href={`/invoices/${o.latestInvoice.id}`} className="hover:underline">
                        {o.latestInvoice.invoiceNumber} · {sl(o.latestInvoice.status)}
                      </Link>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">{o.latestInvoice ? formatIDR(o.latestInvoice.totalAmount) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ConsoleShell>
  );
}
