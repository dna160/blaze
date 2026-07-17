"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { InvoiceDto, PaymentDto } from "@rentos/contracts";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

type InvoiceWithPayments = InvoiceDto & { payments: PaymentDto[] };
interface CreditNote {
  id: string;
  amount: string;
  reason: string;
  issuedByUserId: string;
  createdAt: string;
}
type PaymentWithMaker = PaymentDto & { recordedByUserId: string | null; verifiedByUserId: string | null; provider: string };

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(
    Number(amount),
  );
}

const FINANCE_ROLES = ["SUPER_ADMIN", "FINANCE_ADMIN"];
const RECORDER_ROLES = ["SUPER_ADMIN", "OPS_ADMIN"];

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const user = authClient.getUser();

  const [invoice, setInvoice] = useState<InvoiceWithPayments | null>(null);
  const [creditNotes, setCreditNotes] = useState<CreditNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [method, setMethod] = useState<"CASH" | "MANUAL_TRANSFER">("MANUAL_TRANSFER");
  const [proofUrl, setProofUrl] = useState("");
  const [cnAmount, setCnAmount] = useState("");
  const [cnReason, setCnReason] = useState("");

  async function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const [inv, notes] = await Promise.all([
        apiFetch<InvoiceWithPayments>(`/invoices/${id}`, { token }),
        apiFetch<CreditNote[]>(`/invoices/${id}/credit-notes`, { token }),
      ]);
      setInvoice(inv);
      setCreditNotes(notes);
    } catch {
      router.push("/invoices");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function recordPayment(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/payments/manual", {
        token: authClient.getToken(),
        method: "POST",
        body: { invoiceId: id, method, proofUrl },
      });
      setProofUrl("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to record payment.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyPayment(paymentId: string) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/payments/${paymentId}/verify`, { token: authClient.getToken(), method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Verification failed.");
    } finally {
      setBusy(false);
    }
  }

  async function issueCreditNote(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/invoices/${id}/credit-notes`, {
        token: authClient.getToken(),
        method: "POST",
        body: { amount: cnAmount, reason: cnReason },
      });
      setCnAmount("");
      setCnReason("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to issue credit note.");
    } finally {
      setBusy(false);
    }
  }

  if (!invoice || !creditNotes) {
    return (
      <ConsoleShell>
        <p>Loading...</p>
      </ConsoleShell>
    );
  }

  const canRecord = user && RECORDER_ROLES.some((r) => user.roles.includes(r));
  const canVerify = user && FINANCE_ROLES.some((r) => user.roles.includes(r));
  const payable = invoice.status === "ISSUED" || invoice.status === "OVERDUE";

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">{invoice.invoiceNumber}</h1>
      <p className="mt-1 text-brand-700/70">
        Status: {invoice.status} · Due {new Date(invoice.dueDate).toLocaleDateString("id-ID")}
      </p>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-brand-600/10 bg-white p-5">
          <h2 className="font-medium">Lines</h2>
          <table className="mt-3 w-full text-sm">
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

        <div className="rounded-lg border border-brand-600/10 bg-white p-5">
          <h2 className="font-medium">Payments</h2>
          {invoice.payments.length === 0 && <p className="mt-2 text-sm text-brand-700/60">No payments yet.</p>}
          <ul className="mt-3 space-y-3">
            {(invoice.payments as PaymentWithMaker[]).map((p) => (
              <li key={p.id} className="rounded border border-brand-600/10 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span>
                    {p.method} · {p.provider} · {formatIDR(p.amount)}
                  </span>
                  <span className="rounded-full bg-brand-700/10 px-2 py-1 text-xs">{p.status}</span>
                </div>
                {p.provider === "MANUAL" && (
                  <div className="mt-2 text-xs text-brand-700/60">
                    Recorded by {p.recordedByUserId === user?.id ? "you" : p.recordedByUserId?.slice(0, 8)}
                    {p.verifiedByUserId && ` · Verified by ${p.verifiedByUserId === user?.id ? "you" : p.verifiedByUserId.slice(0, 8)}`}
                  </div>
                )}
                {p.status === "PENDING" && p.provider === "MANUAL" && canVerify && p.recordedByUserId !== user?.id && (
                  <button
                    onClick={() => verifyPayment(p.id)}
                    disabled={busy}
                    className="mt-2 rounded bg-brand-700 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                  >
                    Verify
                  </button>
                )}
                {p.status === "PENDING" && p.provider === "MANUAL" && p.recordedByUserId === user?.id && (
                  <p className="mt-2 text-xs text-amber-700">
                    Maker-checker: you recorded this — a different Finance Admin must verify it.
                  </p>
                )}
              </li>
            ))}
          </ul>

          {payable && canRecord && (
            <form onSubmit={recordPayment} className="mt-4 space-y-2 border-t border-brand-600/10 pt-4">
              <h3 className="text-sm font-medium">Record manual payment</h3>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as "CASH" | "MANUAL_TRANSFER")}
                className="w-full rounded border border-brand-600/20 px-2 py-1 text-sm"
              >
                <option value="MANUAL_TRANSFER">Bank transfer</option>
                <option value="CASH">Cash</option>
              </select>
              <input
                required
                value={proofUrl}
                onChange={(e) => setProofUrl(e.target.value)}
                placeholder="Proof reference (receipt photo URL)"
                className="w-full rounded border border-brand-600/20 px-2 py-1 text-sm"
              />
              <button
                disabled={busy}
                className="w-full rounded bg-brand-700 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Record payment
              </button>
            </form>
          )}
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-brand-600/10 bg-white p-5">
        <h2 className="font-medium">Credit notes</h2>
        {creditNotes.length === 0 && <p className="mt-2 text-sm text-brand-700/60">None issued.</p>}
        <ul className="mt-2 space-y-2">
          {creditNotes.map((cn) => (
            <li key={cn.id} className="text-sm">
              {formatIDR(cn.amount)} — {cn.reason} ({new Date(cn.createdAt).toLocaleDateString("id-ID")})
            </li>
          ))}
        </ul>

        {payable && canVerify && (
          <form onSubmit={issueCreditNote} className="mt-4 flex gap-2 border-t border-brand-600/10 pt-4">
            <input
              required
              value={cnAmount}
              onChange={(e) => setCnAmount(e.target.value)}
              placeholder="Amount (IDR)"
              className="w-40 rounded border border-brand-600/20 px-2 py-1 text-sm"
            />
            <input
              required
              value={cnReason}
              onChange={(e) => setCnReason(e.target.value)}
              placeholder="Reason"
              className="flex-1 rounded border border-brand-600/20 px-2 py-1 text-sm"
            />
            <button disabled={busy} className="rounded bg-brand-700 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50">
              Issue
            </button>
          </form>
        )}
      </div>
    </ConsoleShell>
  );
}
