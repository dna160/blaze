"use client";

import { useEffect, useState } from "react";

import { apiFetch, apiFetchBlob, apiUpload, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useT } from "@/lib/i18n";

/**
 * PRD go-live 2 §10.1 (part 1 §8.4) — recording a payment net of PPh, and
 * short payments, on the invoice page. Shown only when the organization has
 * PPh net settlement on (taxConfig.pphWithholdingEnabled); otherwise the page's
 * usual full-payment form stands and nothing changes.
 */

interface Plan {
  total: number;
  settled: number;
  pending: number;
  outstanding: number;
  pphEnabled: boolean;
  customerWithholds: boolean;
  expected: { type: "PPH_4_2_FINAL" | "PPH_23"; rate: number; amount: number } | null;
}

export interface SettlementPayment {
  id: string;
  status: string;
  amount: string;
  pphWithheldAmount?: string;
  buktiPotongKey?: string | null;
}

const idr = (n: number) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);

export function InvoiceSettlement({
  invoiceId,
  payments,
  canRecord,
  payable,
  onChanged,
  onEnabled,
}: {
  invoiceId: string;
  payments: SettlementPayment[];
  canRecord: boolean;
  payable: boolean;
  onChanged: () => void;
  /** Tells the page to hide its full-payment-only form. */
  onEnabled?: (enabled: boolean) => void;
}) {
  const { t, s } = useT();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [method, setMethod] = useState<"MANUAL_TRANSFER" | "CASH">("MANUAL_TRANSFER");
  const [amount, setAmount] = useState("");
  const [withheld, setWithheld] = useState("");
  const [proof, setProof] = useState<File | null>(null);
  const [bukti, setBukti] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function loadPlan() {
    apiFetch<Plan>(`/payments/settlement/${invoiceId}`, { token: authClient.getToken() })
      .then((p) => {
        setPlan(p);
        onEnabled?.(p.pphEnabled);
        const w = p.expected && p.settled === 0 && p.pending === 0 ? p.expected.amount : 0;
        setWithheld(String(w));
        setAmount(String(Math.max(0, p.outstanding - p.pending - w)));
      })
      .catch(() => setPlan(null));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadPlan, [invoiceId, payments.length]);

  if (!plan || !plan.pphEnabled) return null;

  const a = Number(amount) || 0;
  const w = Number(withheld) || 0;
  const left = plan.outstanding - plan.pending - a - w;

  async function record(e: React.FormEvent) {
    e.preventDefault();
    if (!proof) return;
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append("invoiceId", invoiceId);
      fd.append("method", method);
      fd.append("amount", String(a));
      fd.append("pphWithheldAmount", String(w));
      fd.append("file", proof);
      if (bukti) fd.append("buktiPotong", bukti);
      await apiUpload("/payments/manual", authClient.getToken(), fd);
      setMsg({ ok: true, text: t("settlement.recorded") });
      setProof(null);
      setBukti(null);
      onChanged();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : t("settlement.recordFailed") });
    } finally {
      setBusy(false);
    }
  }

  async function uploadBukti(paymentId: string, file: File) {
    const fd = new FormData();
    fd.append("file", file);
    try {
      await apiUpload(`/payments/${paymentId}/bukti-potong`, authClient.getToken(), fd);
      setMsg({ ok: true, text: t("settlement.buktiSaved") });
      onChanged();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : t("settlement.buktiFailed") });
    }
  }

  async function viewBukti(paymentId: string) {
    const tab = window.open("", "_blank");
    const blob = await apiFetchBlob(`/payments/${paymentId}/bukti-potong`, authClient.getToken());
    if (tab) tab.location.href = URL.createObjectURL(blob);
  }

  const withheldPayments = payments.filter((p) => Number(p.pphWithheldAmount ?? 0) > 0);

  return (
    <div className="mt-4 rounded border border-brand-600/15 bg-brand-700/[0.02] p-3 text-sm" data-testid="invoice-settlement">
      <h3 className="font-medium">{t("settlement.title")}</h3>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="text-brand-700/60">{t("settlement.total")}</dt>
        <dd className="text-right">{idr(plan.total)}</dd>
        <dt className="text-brand-700/60">{t("settlement.settled")}</dt>
        <dd className="text-right">{idr(plan.settled)}</dd>
        {plan.pending > 0 && (
          <>
            <dt className="text-brand-700/60">{t("settlement.pending")}</dt>
            <dd className="text-right">{idr(plan.pending)}</dd>
          </>
        )}
        <dt className="font-medium">{t("settlement.outstanding")}</dt>
        <dd className="text-right font-medium">{idr(plan.outstanding)}</dd>
        {plan.expected && (
          <>
            <dt className="text-brand-700/60">
              {t("settlement.withheldByTenant", { tax: plan.expected.type === "PPH_23" ? "PPh 23" : t("settlement.pphFinal"), rate: Math.round(plan.expected.rate * 1000) / 10 })}
            </dt>
            <dd className="text-right">{idr(plan.expected.amount)}</dd>
          </>
        )}
      </dl>

      {withheldPayments.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs">
          {withheldPayments.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {t("settlement.withheldLine", { amount: idr(Number(p.pphWithheldAmount)), status: s(p.status) })}
              </span>
              {p.buktiPotongKey ? (
                <button type="button" onClick={() => viewBukti(p.id)} className="underline">
                  {t("settlement.viewBukti")}
                </button>
              ) : canRecord ? (
                <label className="cursor-pointer text-amber-700 underline">
                  {t("settlement.buktiMissingUpload")}
                  <input type="file" className="hidden" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => e.target.files?.[0] && uploadBukti(p.id, e.target.files[0])} />
                </label>
              ) : (
                <span className="text-amber-700">{t("settlement.buktiMissing")}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {payable && canRecord && plan.outstanding - plan.pending > 1 && (
        <form onSubmit={record} className="mt-3 space-y-2 border-t border-brand-600/10 pt-3">
          <h4 className="text-xs font-medium">{t("settlement.record")}</h4>
          <select value={method} onChange={(e) => setMethod(e.target.value as "CASH" | "MANUAL_TRANSFER")} className="w-full rounded border border-brand-600/20 px-2 py-1">
            <option value="MANUAL_TRANSFER">{s("MANUAL_TRANSFER")}</option>
            <option value="CASH">{s("CASH")}</option>
          </select>
          <label className="block text-xs">
            {t("settlement.transferred")}
            <input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 w-full rounded border border-brand-600/20 px-2 py-1" />
          </label>
          <label className="block text-xs">
            {t("settlement.withheld")}
            <input type="number" min={0} value={withheld} onChange={(e) => setWithheld(e.target.value)} className="mt-1 w-full rounded border border-brand-600/20 px-2 py-1" />
          </label>
          <p className={`text-xs ${left < -1 ? "text-red-600" : "text-brand-700/70"}`}>
            {left > 1 ? t("settlement.leftAfter", { amount: idr(left) }) : left < -1 ? t("settlement.over") : t("settlement.paidAfterVerify")}
          </p>
          <label className="block text-xs">
            {t("settlement.proof")}
            <input type="file" required accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setProof(e.target.files?.[0] ?? null)} className="mt-1 w-full" />
          </label>
          {w > 0 && (
            <label className="block text-xs">
              {t("settlement.buktiLater")}
              <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setBukti(e.target.files?.[0] ?? null)} className="mt-1 w-full" />
            </label>
          )}
          <button disabled={busy || !proof || a + w <= 0 || left < -1} className="w-full rounded bg-brand-700 py-1.5 font-medium text-white disabled:opacity-50">
            {busy ? t("common.saving") : t("settlement.record")}
          </button>
        </form>
      )}
      {msg && <p className={`mt-2 text-xs ${msg.ok ? "text-green-700" : "text-red-600"}`}>{msg.text}</p>}
    </div>
  );
}
