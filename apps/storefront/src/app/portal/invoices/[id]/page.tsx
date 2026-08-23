"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { InvoiceDto, PaymentDto } from "@rentos/contracts";

import { apiFetch, ApiError, openPdf } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { getClientTenantSlug } from "@/lib/tenant-client";

const TENANT_SLUG = getClientTenantSlug();

type InvoiceWithPayments = InvoiceDto & { payments: PaymentDto[] };

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(
    Number(amount),
  );
}

const PAYMENT_METHODS = [
  { value: "VIRTUAL_ACCOUNT", label: "Virtual Account (BCA/Mandiri/BNI/BRI)" },
  { value: "QRIS", label: "QRIS" },
  { value: "EWALLET", label: "E-wallet (OVO/GoPay/DANA/ShopeePay)" },
  { value: "CARD", label: "Credit/debit card" },
] as const;

/** PRD §7.1.3 checkout: pick a method, POST /payments/initiate, show the result. */
export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [invoice, setInvoice] = useState<InvoiceWithPayments | null>(null);
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]["value"]>("VIRTUAL_ACCOUNT");
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<Record<string, unknown> | null>(null);

  async function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const data = await apiFetch<InvoiceWithPayments>(`/invoices/${id}`, { tenantSlug: TENANT_SLUG, token });
      setInvoice(data);
    } catch {
      router.push("/portal");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function pay() {
    const token = authClient.getToken();
    if (!token) return;
    setPaying(true);
    setError(null);
    try {
      const result = await apiFetch<{ status: string; instructions: Record<string, unknown> }>("/payments/initiate", {
        tenantSlug: TENANT_SLUG,
        token,
        method: "POST",
        body: { invoiceId: id, method },
      });
      setInstructions(result.instructions);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Payment failed.");
    } finally {
      setPaying(false);
    }
  }

  if (!invoice) return <p>Loading...</p>;

  const payable = invoice.status === "ISSUED" || invoice.status === "OVERDUE";
  const isProforma = invoice.scheduleIndex === 0 && invoice.status !== "PAID";
  const isScheduled = invoice.status === "SCHEDULED";

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-accent-500">
          {isProforma ? "Proforma invoice" : isScheduled ? "Upcoming payment" : "Invoice"}
        </p>
        <h1 className="text-2xl font-semibold">{isScheduled ? `Payment ${(invoice.scheduleIndex ?? 0) + 1}` : invoice.invoiceNumber}</h1>
        <p className="mt-1 text-brand-700/70">
          Status: {invoice.status} · Due {new Date(invoice.dueDate).toLocaleDateString("id-ID")}
          {invoice.periodStart && invoice.periodEnd
            ? ` · ${new Date(invoice.periodStart).toLocaleDateString("id-ID")} – ${new Date(invoice.periodEnd).toLocaleDateString("id-ID")}`
            : ""}
        </p>
        {!isScheduled && (
          <button
            type="button"
            onClick={() => {
              const token = authClient.getToken();
              if (token) openPdf(`/invoices/${id}/pdf`, { tenantSlug: TENANT_SLUG, token }).catch(() => setError("Could not open the PDF."));
            }}
            className="mt-2 text-sm text-accent-500 underline"
          >
            Download PDF
          </button>
        )}
        {isScheduled && (
          <p className="mt-2 rounded-lg bg-brand-700/5 p-3 text-sm text-brand-700/70">
            This payment is scheduled — it will be issued about a week before it&apos;s due and you&apos;ll get a message with a pay link.
          </p>
        )}
      </div>

      <div className="rounded-xl border border-brand-600/10 bg-white p-6">
        <table className="w-full text-sm">
          <tbody>
            {invoice.lines.map((line, i) => (
              <tr key={i} className="border-b border-brand-600/10 last:border-0">
                <td className="py-2">{line.description}</td>
                <td className="py-2 text-right">{formatIDR(line.amount)}</td>
              </tr>
            ))}
            <tr>
              <td className="pt-3 font-semibold">Total</td>
              <td className="pt-3 text-right font-semibold">{formatIDR(invoice.totalAmount)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {invoice.status === "CREDITED" && (
        <div className="rounded-lg bg-amber-50 p-4 text-sm text-amber-800">
          {invoice.supersededByInvoiceId ? (
            <>
              This invoice was corrected.{" "}
              <Link href={`/portal/invoices/${invoice.supersededByInvoiceId}`} className="underline">
                View and pay the corrected invoice
              </Link>
              .
            </>
          ) : (
            "This invoice was credited in full — there's nothing left to pay."
          )}
        </div>
      )}

      {payable && !instructions && (
        <div className="space-y-4 rounded-xl border border-brand-600/10 bg-white p-6">
          <h3 className="font-medium">Pay this invoice</h3>
          <div className="space-y-2">
            {PAYMENT_METHODS.map((m) => (
              <label key={m.value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="method"
                  checked={method === m.value}
                  onChange={() => setMethod(m.value)}
                />
                {m.label}
              </label>
            ))}
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            onClick={pay}
            disabled={paying}
            className="w-full rounded bg-brand-700 py-2 font-medium text-white disabled:opacity-50"
          >
            {paying ? "Processing..." : `Pay ${formatIDR(invoice.totalAmount)}`}
          </button>
        </div>
      )}

      {instructions && (
        <div className="rounded-lg bg-green-50 p-4 text-sm text-green-800">
          <p className="font-medium">Payment submitted.</p>
          {typeof instructions.redirectUrl === "string" && (
            <p className="mt-1">
              Complete payment at{" "}
              <a href={instructions.redirectUrl} className="underline" target="_blank" rel="noreferrer">
                {instructions.redirectUrl}
              </a>
            </p>
          )}
          {typeof instructions.note === "string" && <p className="mt-1">{instructions.note}</p>}
        </div>
      )}

      {invoice.status === "PAID" && (
        <div className="rounded-lg bg-green-50 p-4 text-sm text-green-800">This invoice is fully paid. Thank you!</div>
      )}
    </div>
  );
}
