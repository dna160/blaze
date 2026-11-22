"use client";

import type { BranchSettings, MoneyRules } from "@rentos/contracts";
import { useState } from "react";

import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useT } from "@/lib/i18n";

/**
 * PRD go-live 2 §10.3 — the T&C money rules for this branch, each OFF until
 * City Storage confirms it (part 1 §16 Q7). Saved on its own, separately from
 * the branch profile form, through the same audited PUT /branch/settings.
 */
export function MoneyRulesPanel({ settings, onSaved }: { settings: BranchSettings; onSaved?: (s: BranchSettings) => void }) {
  const { t } = useT();
  const [rules, setRules] = useState<MoneyRules>(settings.moneyRules);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const ro = !settings.canEdit;

  function patch<K extends keyof MoneyRules>(key: K, value: Partial<MoneyRules[K]>) {
    setRules({ ...rules, [key]: { ...rules[key], ...value } });
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const s = await apiFetch<BranchSettings>("/branch/settings", { token: authClient.getToken(), method: "PUT", body: { moneyRules: rules } });
      setRules(s.moneyRules);
      setMsg({ ok: true, text: t("moneyRules.saved") });
      onSaved?.(s);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : t("moneyRules.saveFailed") });
    } finally {
      setBusy(false);
    }
  }

  const pct = (r: number) => Math.round(r * 10000) / 100;

  return (
    <section className="mt-8 max-w-3xl rounded-lg border border-brand-600/10 bg-white p-5" data-testid="money-rules">
      <h2 className="text-lg font-medium">{t("moneyRules.title")}</h2>
      <p className="mt-1 text-xs text-brand-700/60">{t("moneyRules.intro")}</p>
      <fieldset disabled={ro || busy} className="mt-4 space-y-4 text-sm">
        <div>
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={rules.lateFee.enabled} onChange={(e) => patch("lateFee", { enabled: e.target.checked })} />
            {t("moneyRules.lateFee")}
          </label>
          <div className="ml-6 mt-1 flex flex-wrap items-center gap-2 text-xs">
            <input type="number" step="0.1" min={0} max={10} value={pct(rules.lateFee.ratePerDay)} onChange={(e) => patch("lateFee", { ratePerDay: Number(e.target.value) / 100 })} className="w-20 rounded border border-brand-600/20 px-2 py-1" />
            {t("moneyRules.ofBillPerDay")}
            <input type="number" min={1} max={90} value={rules.lateFee.maxDays} onChange={(e) => patch("lateFee", { maxDays: Number(e.target.value) })} className="w-16 rounded border border-brand-600/20 px-2 py-1" />
            {t("moneyRules.days")}
          </div>
        </div>
        <div>
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={rules.overstay.enabled} onChange={(e) => patch("overstay", { enabled: e.target.checked })} />
            {t("moneyRules.overstay")}
          </label>
          <div className="ml-6 mt-1 flex flex-wrap items-center gap-2 text-xs">
            <input type="number" step="0.1" min={0} max={10} value={pct(rules.overstay.ratePerDay)} onChange={(e) => patch("overstay", { ratePerDay: Number(e.target.value) / 100 })} className="w-20 rounded border border-brand-600/20 px-2 py-1" />
            {t("moneyRules.ofRentPerDay")}
            <input type="number" min={1} max={180} value={rules.overstay.maxDays} onChange={(e) => patch("overstay", { maxDays: Number(e.target.value) })} className="w-16 rounded border border-brand-600/20 px-2 py-1" />
            {t("moneyRules.days")}
          </div>
        </div>
        <div>
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={rules.overtime.enabled} onChange={(e) => patch("overtime", { enabled: e.target.checked })} />
            {t("moneyRules.overtime")}
          </label>
          <div className="ml-6 mt-1 flex flex-wrap items-center gap-2 text-xs">
            Rp
            <input type="number" min={0} step={1000} value={rules.overtime.hourlyRate} onChange={(e) => patch("overtime", { hourlyRate: Number(e.target.value) })} className="w-28 rounded border border-brand-600/20 px-2 py-1" />
            {t("moneyRules.perHour")}
          </div>
        </div>
        <div>
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={rules.depositRefundTask.enabled} onChange={(e) => patch("depositRefundTask", { enabled: e.target.checked })} />
            {t("moneyRules.refundTask")}
          </label>
          <p className="ml-6 mt-1 text-xs text-brand-700/60">{t("moneyRules.refundTaskHint", { days: rules.depositRefundTask.days })}</p>
        </div>
        <div>
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={rules.arrearsBadge.enabled} onChange={(e) => patch("arrearsBadge", { enabled: e.target.checked })} />
            {t("moneyRules.arrears")}
          </label>
          <div className="ml-6 mt-1 flex flex-wrap items-center gap-2 text-xs">
            {t("moneyRules.arrearsHint")}
            <input type="number" min={0} max={365} value={rules.arrearsBadge.thresholdDays} onChange={(e) => patch("arrearsBadge", { thresholdDays: Number(e.target.value) })} className="w-16 rounded border border-brand-600/20 px-2 py-1" />
            {t("moneyRules.days")}
          </div>
        </div>
      </fieldset>
      {!ro && (
        <div className="mt-4 flex items-center gap-3">
          <button type="button" disabled={busy} onClick={save} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? t("common.saving") : t("moneyRules.save")}
          </button>
          {msg && <span className={`text-sm ${msg.ok ? "text-green-700" : "text-red-600"}`}>{msg.text}</span>}
        </div>
      )}
    </section>
  );
}
