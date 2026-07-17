"use client";

import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

interface DepositWithBooking {
  id: string;
  bookingId: string;
  amount: string;
  appliedAmount: string;
  status: "HELD" | "PARTIALLY_APPLIED" | "APPLIED" | "REFUND_REQUESTED" | "REFUNDED";
  refundedAt: string | null;
  payoutRef: string | null;
  booking: {
    customer: { fullName: string | null; phone: string };
    asset: { code: string } | null;
  };
}

const STATUS_COLORS: Record<string, string> = {
  HELD: "bg-blue-100 text-blue-800",
  REFUND_REQUESTED: "bg-amber-100 text-amber-800",
  REFUNDED: "bg-green-100 text-green-800",
  PARTIALLY_APPLIED: "bg-gray-200 text-gray-700",
  APPLIED: "bg-gray-200 text-gray-700",
};

function formatIDR(amount: string): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(
    Number(amount),
  );
}

function remainingOf(d: DepositWithBooking): number {
  return Number(d.amount) - Number(d.appliedAmount);
}

const REQUEST_ROLES = ["SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN"];
const APPROVE_ROLES = ["SUPER_ADMIN", "FINANCE_ADMIN"];

/** PRD §7.2.4: deposits are applied against damages (Super Admin/Finance Admin) and/or refunded (request by ops as part of move-out -> approve by finance/owner -> payout) — the remaining, unapplied balance is what's ever refunded. */
export default function DepositsPage() {
  const router = useRouter();
  const user = authClient.getUser();
  const [deposits, setDeposits] = useState<DepositWithBooking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [applyAmount, setApplyAmount] = useState("");
  const [applyReason, setApplyReason] = useState("");

  async function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const data = await apiFetch<DepositWithBooking[]>("/deposits", { token });
      setDeposits(data);
    } catch {
      router.push("/login");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function applyToDamages(id: string) {
    if (!applyAmount || !applyReason) return;
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/deposits/${id}/apply`, {
        token: authClient.getToken(),
        method: "POST",
        body: { amount: applyAmount, reason: applyReason },
      });
      setApplyingId(null);
      setApplyAmount("");
      setApplyReason("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to apply deposit.");
    } finally {
      setBusyId(null);
    }
  }

  async function requestRefund(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/deposits/${id}/request-refund`, { token: authClient.getToken(), method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to request refund.");
    } finally {
      setBusyId(null);
    }
  }

  async function approveRefund(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/deposits/${id}/approve-refund`, { token: authClient.getToken(), method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to approve refund.");
    } finally {
      setBusyId(null);
    }
  }

  const canRequest = user && REQUEST_ROLES.some((r) => user.roles.includes(r));
  const canApprove = user && APPROVE_ROLES.some((r) => user.roles.includes(r));

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">Deposits</h1>
      <p className="mt-1 text-sm text-brand-700/60">Security deposits held, applied against damages, requested, and refunded.</p>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {!deposits ? (
        <p className="mt-6">Loading...</p>
      ) : deposits.length === 0 ? (
        <p className="mt-6 text-brand-700/60">No deposits yet.</p>
      ) : (
        <div className="mt-6 overflow-hidden rounded-lg border border-brand-600/10 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-brand-700/5 text-left">
              <tr>
                <th className="p-3">Customer</th>
                <th className="p-3">Unit</th>
                <th className="p-3 text-right">Amount</th>
                <th className="p-3 text-right">Remaining</th>
                <th className="p-3">Status</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {deposits.map((d) => {
                const remaining = remainingOf(d);
                const canApply = (d.status === "HELD" || d.status === "PARTIALLY_APPLIED") && canApprove;
                const canRequestThis = (d.status === "HELD" || d.status === "PARTIALLY_APPLIED") && remaining > 0 && canRequest;
                return (
                  <Fragment key={d.id}>
                    <tr className="border-t border-brand-600/10">
                      <td className="p-3">{d.booking.customer.fullName ?? d.booking.customer.phone}</td>
                      <td className="p-3">{d.booking.asset?.code ?? "—"}</td>
                      <td className="p-3 text-right">{formatIDR(d.amount)}</td>
                      <td className="p-3 text-right">
                        {Number(d.appliedAmount) > 0 ? formatIDR(String(remaining)) : "—"}
                      </td>
                      <td className="p-3">
                        <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_COLORS[d.status] ?? ""}`}>
                          {d.status}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <div className="flex justify-end gap-2">
                          {canApply && (
                            <button
                              onClick={() => setApplyingId(applyingId === d.id ? null : d.id)}
                              className="rounded border border-brand-600/20 px-3 py-1 text-xs font-medium hover:bg-brand-700/5"
                            >
                              Apply to damages
                            </button>
                          )}
                          {canRequestThis && (
                            <button
                              onClick={() => requestRefund(d.id)}
                              disabled={busyId === d.id}
                              className="rounded border border-brand-600/20 px-3 py-1 text-xs font-medium hover:bg-brand-700/5 disabled:opacity-50"
                            >
                              Request refund
                            </button>
                          )}
                          {d.status === "REFUND_REQUESTED" && canApprove && (
                            <button
                              onClick={() => approveRefund(d.id)}
                              disabled={busyId === d.id}
                              className="rounded bg-brand-700 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                            >
                              Approve refund ({formatIDR(String(remaining))})
                            </button>
                          )}
                          {d.status === "REFUNDED" && <span className="text-xs text-brand-700/60">Paid out</span>}
                          {d.status === "APPLIED" && <span className="text-xs text-brand-700/60">Fully applied</span>}
                        </div>
                      </td>
                    </tr>
                    {applyingId === d.id && (
                      <tr className="border-t border-brand-600/10 bg-brand-700/5">
                        <td colSpan={6} className="p-3">
                          <div className="flex items-center gap-2">
                            <input
                              value={applyAmount}
                              onChange={(e) => setApplyAmount(e.target.value)}
                              placeholder={`Amount (max ${remaining})`}
                              className="w-40 rounded border border-brand-600/20 px-2 py-1 text-sm"
                            />
                            <input
                              value={applyReason}
                              onChange={(e) => setApplyReason(e.target.value)}
                              placeholder="Reason (e.g. broken lock, cleaning fee)"
                              className="flex-1 rounded border border-brand-600/20 px-2 py-1 text-sm"
                            />
                            <button
                              onClick={() => applyToDamages(d.id)}
                              disabled={busyId === d.id || !applyAmount || !applyReason}
                              className="rounded bg-brand-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                            >
                              Confirm
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </ConsoleShell>
  );
}
