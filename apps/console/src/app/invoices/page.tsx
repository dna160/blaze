"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { InvoiceDto } from "@rentos/contracts";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

const STATUS_COLORS: Record<string, string> = {
  ISSUED: "bg-blue-100 text-blue-800",
  OVERDUE: "bg-red-100 text-red-800",
  PAID: "bg-green-100 text-green-800",
  VOID: "bg-gray-200 text-gray-700",
  CREDITED: "bg-amber-100 text-amber-800",
};

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(
    Number(amount),
  );
}

/** PRD §7.2.4 Finance module — invoice list (P0 core; AR aging lives on /reports). */
export default function InvoicesPage() {
  const router = useRouter();
  const [invoices, setInvoices] = useState<InvoiceDto[] | null>(null);

  useEffect(() => {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    apiFetch<InvoiceDto[]>("/invoices", { token })
      .then(setInvoices)
      .catch(() => router.push("/login"));
  }, [router]);

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">Invoices</h1>
      {!invoices ? (
        <p className="mt-6">Loading...</p>
      ) : (
        <div className="mt-6 overflow-hidden rounded-lg border border-brand-600/10 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-brand-700/5 text-left">
              <tr>
                <th className="p-3">Invoice #</th>
                <th className="p-3">Status</th>
                <th className="p-3">Issued</th>
                <th className="p-3">Due</th>
                <th className="p-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-t border-brand-600/10">
                  <td className="p-3 font-medium">{inv.invoiceNumber}</td>
                  <td className="p-3">
                    <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_COLORS[inv.status] ?? ""}`}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="p-3">{new Date(inv.issueDate).toLocaleDateString("id-ID")}</td>
                  <td className="p-3">{new Date(inv.dueDate).toLocaleDateString("id-ID")}</td>
                  <td className="p-3 text-right">{formatIDR(inv.totalAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ConsoleShell>
  );
}
