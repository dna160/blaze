"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useT } from "@/lib/i18n";
import { notifyMessagingPauseChanged } from "@/lib/messaging-pause";

/**
 * PRD go-live 2 §8.1 — the test allowlist ("Hanya kirim ke nomor uji").
 *
 * While the toggle is on, a message to any number that is not on this list is
 * recorded as suppressed (NOT_ON_TEST_ALLOWLIST) instead of sent — the client's
 * test period, when the branch holds test renters and, later, the re-imported
 * real customers. The organization's, like the pause: an org-scoped Admin only.
 */

interface Allowlist {
  enabled: boolean;
  numbers: string[];
}

const MAX_NUMBERS = 50;
const PHONE = /^\+?[\d\s().-]{8,24}$/;

export function TestAllowlistPanel({ canEdit }: { canEdit: boolean }) {
  const { t } = useT();
  const [state, setState] = useState<Allowlist | null>(null);
  const [numbers, setNumbers] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!canEdit) return;
    try {
      const data = await apiFetch<Allowlist>("/organization/messaging/allowlist", { token: authClient.getToken() });
      setState(data);
      setNumbers(data.numbers);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("panels.allowlist.loadFailed"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t only changes the fallback text
  }, [canEdit]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canEdit) {
    return (
      <div className="space-y-2 rounded border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">{t("panels.allowlist.title")}</h2>
        <p className="text-xs text-slate-500">{t("panels.allowlist.onlyOrgAdmin")}</p>
      </div>
    );
  }

  const dirty = state !== null && (numbers.length !== state.numbers.length || numbers.some((n, i) => n !== state.numbers[i]));

  function addDraft() {
    const parts = draft
      .split(/[\n,;]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const bad = parts.find((p) => !PHONE.test(p));
    if (bad) {
      setError(t("panels.allowlist.notPhone", { value: bad }));
      return;
    }
    const next = [...numbers];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    if (next.length > MAX_NUMBERS) {
      setError(t("panels.allowlist.tooMany", { max: MAX_NUMBERS }));
      return;
    }
    setError(null);
    setSaved(false);
    setNumbers(next);
    setDraft("");
  }

  async function save(enabled: boolean) {
    if (state === null) return;
    if (enabled && !state.enabled) {
      const question =
        numbers.length === 0
          ? t("panels.allowlist.confirmEmpty")
          : t("panels.allowlist.confirmOn", { count: numbers.length });
      if (!window.confirm(question)) return;
    }
    if (!enabled && state.enabled) {
      if (!window.confirm(t("panels.allowlist.confirmOff"))) return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const data = await apiFetch<Allowlist>("/organization/messaging/allowlist", {
        token: authClient.getToken(),
        method: "PUT",
        body: { enabled, numbers },
      });
      setState(data);
      setNumbers(data.numbers);
      setSaved(true);
      notifyMessagingPauseChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("panels.allowlist.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`space-y-3 rounded border p-4 ${state?.enabled ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white"}`} data-testid="test-allowlist">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-800">{t("panels.allowlist.title")}</h2>
        {state && (
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${state.enabled ? "bg-amber-200 text-amber-900" : "bg-slate-200 text-slate-700"}`}>
            {state.enabled ? t("panels.allowlist.on") : t("panels.allowlist.off")}
          </span>
        )}
      </div>
      <p className="text-xs text-slate-600">{t("panels.allowlist.explain")}</p>

      <ul className="flex flex-wrap gap-2">
        {numbers.length === 0 && <li className="text-xs text-slate-500">{t("panels.allowlist.empty")}</li>}
        {numbers.map((n) => (
          <li key={n} className="flex items-center gap-1 rounded-full border border-slate-300 bg-white px-3 py-1 text-sm">
            <span>{n}</span>
            <button
              type="button"
              aria-label={t("panels.allowlist.removeNumber", { number: n })}
              onClick={() => {
                setSaved(false);
                setNumbers(numbers.filter((x) => x !== n));
              }}
              className="text-slate-400 hover:text-red-600"
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addDraft();
            }
          }}
          placeholder={t("panels.allowlist.placeholder")}
          className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
        />
        <button type="button" onClick={addDraft} disabled={!draft.trim()} className="rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-50">
          {t("panels.allowlist.add")}
        </button>
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}
      {saved && !error && <p className="text-sm text-green-700">{t("common.saved")}</p>}

      {state && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void save(state.enabled)}
            disabled={busy || !dirty}
            className="rounded border border-brand-700 px-4 py-2 text-sm font-medium text-brand-700 disabled:opacity-40"
          >
            {busy ? t("common.saving") : t("panels.allowlist.saveList")}
          </button>
          {state.enabled ? (
            <button type="button" onClick={() => void save(false)} disabled={busy} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {t("panels.allowlist.turnOff")}
            </button>
          ) : (
            <button type="button" onClick={() => void save(true)} disabled={busy} className="rounded bg-amber-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {t("panels.allowlist.turnOn")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
