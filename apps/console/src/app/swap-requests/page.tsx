"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

interface SwapRequestWithRelations {
  id: string;
  reason: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
  booking: {
    customer: { fullName: string | null; phone: string };
    asset: { code: string } | null;
    assetType: { name: string };
  };
  requestedAssetType: { id: string; name: string };
}

interface AvailableAsset {
  id: string;
  code: string;
}

interface ApprovalResult {
  customerLabel: string;
  unitCode: string;
  prorationNetAdjustment: string | null;
  prorationDaysRemaining: number | null;
}

function formatIDR(amount: string): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(
    Math.abs(Number(amount)),
  );
}

/** PRD §7.1.4 / persona table "Grow/Shrink" — swap-request approval queue. */
export default function SwapRequestsPage() {
  const router = useRouter();
  const [requests, setRequests] = useState<SwapRequestWithRelations[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [availableAssets, setAvailableAssets] = useState<AvailableAsset[] | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [approvalResult, setApprovalResult] = useState<ApprovalResult | null>(null);

  async function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const data = await apiFetch<SwapRequestWithRelations[]>("/swap-requests?status=PENDING", { token });
      setRequests(data);
    } catch {
      router.push("/login");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function expand(req: SwapRequestWithRelations) {
    if (expandedId === req.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(req.id);
    setSelectedAssetId("");
    setAvailableAssets(null);
    try {
      const assets = await apiFetch<AvailableAsset[]>(
        `/catalog/assets?assetTypeId=${req.requestedAssetType.id}&status=AVAILABLE`,
        { token: authClient.getToken() },
      );
      setAvailableAssets(assets);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load available units.");
    }
  }

  async function approve(req: SwapRequestWithRelations) {
    if (!selectedAssetId) return;
    setBusyId(req.id);
    setError(null);
    try {
      const unitCode = availableAssets?.find((a) => a.id === selectedAssetId)?.code ?? "the new unit";
      const result = await apiFetch<{ prorationNetAdjustment: string | null; prorationDaysRemaining: number | null }>(
        `/swap-requests/${req.id}/approve`,
        { token: authClient.getToken(), method: "POST", body: { newAssetId: selectedAssetId } },
      );
      setApprovalResult({
        customerLabel: req.booking.customer.fullName ?? req.booking.customer.phone,
        unitCode,
        prorationNetAdjustment: result.prorationNetAdjustment,
        prorationDaysRemaining: result.prorationDaysRemaining,
      });
      setExpandedId(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Approval failed.");
    } finally {
      setBusyId(null);
    }
  }

  async function reject(id: string) {
    const reason = window.prompt("Rejection reason?");
    if (!reason) return;
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/swap-requests/${id}/reject`, { token: authClient.getToken(), method: "POST", body: { reason } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Rejection failed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">Swap Requests</h1>
      <p className="mt-1 text-sm text-brand-700/60">Customer-requested unit upgrades/downsizes awaiting a decision.</p>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {approvalResult && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <div className="flex items-start justify-between">
            <p className="font-medium">
              Swap approved: {approvalResult.customerLabel} → unit {approvalResult.unitCode}
            </p>
            <button onClick={() => setApprovalResult(null)} className="text-amber-700/60 hover:text-amber-900">
              Dismiss
            </button>
          </div>
          {approvalResult.prorationNetAdjustment === null ? (
            <p className="mt-1 text-amber-800">
              No prior paid invoice to derive the current billing period from — proration wasn't computed.
            </p>
          ) : Number(approvalResult.prorationNetAdjustment) === 0 ? (
            <p className="mt-1 text-amber-800">
              Rates match, or no days remain in the current period — no manual adjustment needed.
            </p>
          ) : Number(approvalResult.prorationNetAdjustment) > 0 ? (
            <p className="mt-1 text-amber-800">
              For the {approvalResult.prorationDaysRemaining} day(s) left in the current period, the customer owes an
              additional <strong>{formatIDR(approvalResult.prorationNetAdjustment)}</strong> at the new rate. Record a
              manual charge on their next invoice.
            </p>
          ) : (
            <p className="mt-1 text-amber-800">
              For the {approvalResult.prorationDaysRemaining} day(s) left in the current period, the customer is owed
              a credit of <strong>{formatIDR(approvalResult.prorationNetAdjustment)}</strong> for the unused old
              rate. Issue a credit note on their next invoice.
            </p>
          )}
        </div>
      )}

      {!requests ? (
        <p className="mt-6">Loading...</p>
      ) : requests.length === 0 ? (
        <p className="mt-6 text-brand-700/60">Nothing pending — queue is clear.</p>
      ) : (
        <div className="mt-6 space-y-4">
          {requests.map((req) => (
            <div key={req.id} className="rounded-lg border border-brand-600/10 bg-white p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium">{req.booking.customer.fullName ?? req.booking.customer.phone}</p>
                  <p className="mt-1 text-sm text-brand-700/60">
                    Currently {req.booking.assetType.name} (unit {req.booking.asset?.code ?? "—"}) → wants{" "}
                    {req.requestedAssetType.name}
                  </p>
                  {req.reason && <p className="mt-1 text-sm text-brand-700/60">"{req.reason}"</p>}
                  <p className="mt-1 text-xs text-brand-700/40">
                    Requested {new Date(req.createdAt).toLocaleDateString("id-ID")}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => expand(req)}
                    className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white"
                  >
                    {expandedId === req.id ? "Cancel" : "Approve"}
                  </button>
                  <button
                    onClick={() => reject(req.id)}
                    disabled={busyId === req.id}
                    className="rounded border border-red-300 px-4 py-2 text-sm font-medium text-red-600 disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              </div>

              {expandedId === req.id && (
                <div className="mt-4 border-t border-brand-600/10 pt-4">
                  {!availableAssets ? (
                    <p className="text-sm text-brand-700/60">Loading available units...</p>
                  ) : availableAssets.length === 0 ? (
                    <p className="text-sm text-red-600">No {req.requestedAssetType.name} units are currently available.</p>
                  ) : (
                    <div className="flex items-center gap-2">
                      <select
                        value={selectedAssetId}
                        onChange={(e) => setSelectedAssetId(e.target.value)}
                        className="rounded border border-brand-600/20 px-2 py-1.5 text-sm"
                      >
                        <option value="">Choose a unit...</option>
                        {availableAssets.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.code}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => approve(req)}
                        disabled={busyId === req.id || !selectedAssetId}
                        className="rounded bg-brand-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                      >
                        Confirm swap
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </ConsoleShell>
  );
}
