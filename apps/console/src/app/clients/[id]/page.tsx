"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ClientListItem } from "@rentos/contracts";

import { HEALTH_STYLE } from "@/components/ClientList";
import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

interface ClientDetail {
  customer: {
    id: string;
    fullName: string | null;
    phone: string | null;
    email: string | null;
    preferredChannel: "WHATSAPP" | "EMAIL";
    kycStatus: string;
    isBlocklisted: boolean;
    blocklistReason: string | null;
    notes: string | null;
    createdAt: string;
    bookings: Array<{
      id: string;
      status: string;
      startDate: string;
      endDate: string | null;
      termMonths: number | null;
      asset: { id: string; code: string } | null;
      assetType: { id: string; name: string };
      location: { id: string; name: string } | null;
      invoices: Array<{ id: string; invoiceNumber: string; status: string; scheduleIndex: number | null; dueDate: string; totalAmount: string; paidAt: string | null; payments: Array<{ id: string; method: string; status: string; amount: string; paidAt: string | null }> }>;
      deposits: Array<{ id: string; amount: string; status: string; appliedAmount: string }>;
      contracts: Array<{ id: string; signedAt: string | null; unsignedDocumentUrl: string | null }>;
    }>;
    kycDocuments: Array<{ id: string; documentType: string; status: string; createdAt: string }>;
  };
  summary: ClientListItem | null;
  notifications: Array<{ id: string; templateKey: string; channel: string; status: string; recipient: string; createdAt: string }>;
}

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}
function fmtDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" }) : "—";
}
function fmtDateTime(value: string): string {
  return new Date(value).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const INVOICE_STYLE: Record<string, string> = {
  SCHEDULED: "bg-gray-100 text-gray-700",
  ISSUED: "bg-blue-100 text-blue-800",
  OVERDUE: "bg-red-100 text-red-800",
  PAID: "bg-green-100 text-green-800",
  VOID: "bg-gray-200 text-gray-600",
  CREDITED: "bg-amber-100 text-amber-800",
};

/** PRD v2 §5.2 — "When they click on the client they can look closer": profile, rentals with their payment schedules, deposits, KYC, message log. */
export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<ClientDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    apiFetch<ClientDetail>(`/customers/clients/${id}`, { token })
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load client."));
  }, [id, router]);

  if (error) {
    return (
      <ConsoleShell>
        <p className="text-sm text-red-600">{error}</p>
      </ConsoleShell>
    );
  }
  if (!data) {
    return (
      <ConsoleShell>
        <p>Loading...</p>
      </ConsoleShell>
    );
  }

  const { customer, summary, notifications } = data;
  const health = summary ? HEALTH_STYLE[summary.health] : null;

  return (
    <ConsoleShell>
      <Link href="/clients" className="text-sm text-brand-700/60 hover:underline">
        ← Clients
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{customer.fullName ?? customer.phone ?? customer.email}</h1>
          <p className="text-sm text-brand-700/60">
            {customer.phone ?? "no phone"} · {customer.email ?? "no email"} · messages via {customer.preferredChannel === "EMAIL" ? "email" : "WhatsApp"} · KYC {customer.kycStatus}
            {customer.isBlocklisted ? ` · BLOCKLISTED${customer.blocklistReason ? ` (${customer.blocklistReason})` : ""}` : ""}
          </p>
          <p className="text-xs text-brand-700/40">Customer since {fmtDate(customer.createdAt)}</p>
        </div>
        {health && summary && (
          <div className="text-right">
            <span className={`rounded-full px-3 py-1 text-sm font-medium ${health.className}`}>{health.label}</span>
            <p className="mt-1 text-xs text-brand-700/60">{health.hint}</p>
            {summary.nextDueDate && (
              <p className="text-xs text-brand-700/60">
                Next due {fmtDate(summary.nextDueDate)} · {summary.nextDueAmount ? formatIDR(summary.nextDueAmount) : ""}
              </p>
            )}
            {Number(summary.outstandingAmount) > 0 && <p className="text-xs text-red-700">Outstanding {formatIDR(summary.outstandingAmount)}</p>}
          </div>
        )}
      </div>

      <section className="mt-8">
        <h2 className="text-lg font-medium">Rentals</h2>
        {customer.bookings.length === 0 && <p className="mt-2 text-sm text-brand-700/60">No rentals yet.</p>}
        <div className="mt-3 space-y-4">
          {customer.bookings.map((b) => (
            <div key={b.id} className="rounded-lg border border-brand-600/10 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <Link href={`/bookings/${b.id}`} className="font-medium hover:underline">
                    {b.assetType.name}
                    {b.asset ? ` — ${b.asset.code}` : ""}
                  </Link>
                  <p className="text-sm text-brand-700/60">
                    {b.location?.name ? `${b.location.name} · ` : ""}
                    {fmtDate(b.startDate)}
                    {b.endDate ? ` → ${fmtDate(b.endDate)}` : " → open-ended"}
                    {b.termMonths ? ` · ${b.termMonths}-month term` : ""}
                  </p>
                </div>
                <span className="rounded-full bg-brand-700/10 px-3 py-1 text-xs font-medium">{b.status}</span>
              </div>

              {b.invoices.length > 0 && (
                <table className="mt-3 w-full text-xs">
                  <thead className="text-left text-brand-700/60">
                    <tr>
                      <th className="py-1">Payment</th>
                      <th className="py-1">Due</th>
                      <th className="py-1">Status</th>
                      <th className="py-1 text-right">Amount</th>
                      <th className="py-1 text-right">Paid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.invoices.map((inv) => (
                      <tr key={inv.id} className="border-t border-brand-600/10">
                        <td className="py-1">
                          <Link href={`/invoices/${inv.id}`} className="hover:underline">
                            {inv.scheduleIndex === 0 ? "Proforma" : inv.scheduleIndex !== null ? `#${inv.scheduleIndex + 1}` : ""} {inv.invoiceNumber}
                          </Link>
                        </td>
                        <td className="py-1">{fmtDate(inv.dueDate)}</td>
                        <td className="py-1">
                          <span className={`rounded-full px-2 py-0.5 ${INVOICE_STYLE[inv.status] ?? ""}`}>{inv.status}</span>
                        </td>
                        <td className="py-1 text-right">{formatIDR(inv.totalAmount)}</td>
                        <td className="py-1 text-right">{inv.paidAt ? fmtDate(inv.paidAt) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {(b.deposits.length > 0 || b.contracts.length > 0) && (
                <p className="mt-2 text-xs text-brand-700/60">
                  {b.deposits.map((d) => `Deposit ${formatIDR(d.amount)} (${d.status}${Number(d.appliedAmount) > 0 ? `, ${formatIDR(d.appliedAmount)} applied` : ""})`).join(" · ")}
                  {b.contracts[0] ? ` · Contract ${b.contracts[0].signedAt ? `signed ${fmtDate(b.contracts[0].signedAt)}` : b.contracts[0].unsignedDocumentUrl ? "generated, unsigned" : "not generated"}` : ""}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="text-lg font-medium">KYC documents</h2>
          {customer.kycDocuments.length === 0 ? (
            <p className="mt-2 text-sm text-brand-700/60">Nothing uploaded.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {customer.kycDocuments.map((d) => (
                <li key={d.id} className="flex justify-between rounded border border-brand-600/10 bg-white px-3 py-2">
                  <span>{d.documentType}</span>
                  <span className="text-brand-700/60">
                    {d.status} · {fmtDate(d.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {customer.notes && <p className="mt-3 rounded bg-brand-700/5 p-3 text-sm">{customer.notes}</p>}
        </section>
        <section>
          <h2 className="text-lg font-medium">Messages sent</h2>
          {notifications.length === 0 ? (
            <p className="mt-2 text-sm text-brand-700/60">No messages yet.</p>
          ) : (
            <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto text-xs">
              {notifications.map((n) => (
                <li key={n.id} className="flex justify-between rounded border border-brand-600/10 bg-white px-3 py-1.5">
                  <span>
                    {n.templateKey} <span className="text-brand-700/50">· {n.channel.toLowerCase()}</span>
                  </span>
                  <span className={n.status === "FAILED" ? "text-red-600" : "text-brand-700/60"}>
                    {n.status} · {fmtDateTime(n.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </ConsoleShell>
  );
}
