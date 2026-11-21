"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useT } from "@/lib/i18n";

type LinkedState =
  | "unpaired"
  | "pairing"
  | "connecting"
  | "connected"
  | "disconnected"
  | "logged_out"
  | "replaced"
  | "banned"
  | "unreachable";

interface LinkedStatus {
  configured: boolean;
  state: LinkedState;
  detail: string | null;
  phone: string | null;
  pushName: string | null;
  pairCode: string | null;
  pairExpiresAt: string | null;
  sentToday: number;
  dailyCap: number;
}

/** Badge colour per state; the words are `panels.linked.state.<state>`. */
const STATE_TONE: Record<LinkedState, string> = {
  unpaired: "bg-slate-200 text-slate-700",
  pairing: "bg-amber-100 text-amber-800",
  connecting: "bg-amber-100 text-amber-800",
  connected: "bg-green-100 text-green-800",
  disconnected: "bg-amber-100 text-amber-800",
  logged_out: "bg-red-100 text-red-800",
  replaced: "bg-red-100 text-red-800",
  banned: "bg-red-100 text-red-800",
  unreachable: "bg-red-100 text-red-800",
};

/** States that change on their own, so the panel keeps polling while in them. */
const TRANSIENT: LinkedState[] = ["pairing", "connecting", "disconnected"];

/**
 * The organization's WhatsApp linked device — Project Smile's pairing flow: ask
 * for a code, the number's owner types it into WhatsApp → Linked devices →
 * Link with phone number, and this flips to Connected by itself.
 */
export function LinkedDevicePanel({ canEdit }: { canEdit: boolean }) {
  const { t } = useT();
  const [status, setStatus] = useState<LinkedStatus | null>(null);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setStatus(
        await apiFetch<LinkedStatus>("/organization/messaging/linked", {
          token: authClient.getToken(),
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const polling = status ? TRANSIENT.includes(status.state) : false;
  useEffect(() => {
    if (!polling) return;
    const poll = setInterval(() => void load(), 3000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [polling, load]);

  async function pair(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/organization/messaging/linked/pair", {
        token: authClient.getToken(),
        method: "POST",
        body: { phone: phone.trim() },
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (
      !confirm(t("panels.linked.confirmUnlink"))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      setStatus(
        await apiFetch<LinkedStatus>("/organization/messaging/linked/logout", {
          token: authClient.getToken(),
          method: "POST",
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  if (!status.configured) {
    return (
      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{t("panels.linked.notConfigured")}</div>
    );
  }

  const copy = { label: t(`panels.linked.state.${status.state}`), tone: STATE_TONE[status.state] };
  const secondsLeft = status.pairExpiresAt
    ? Math.max(0, Math.round((new Date(status.pairExpiresAt).getTime() - now) / 1000))
    : 0;
  const canPair =
    ["unpaired", "logged_out"].includes(status.state) ||
    (status.state === "pairing" && secondsLeft === 0);
  const isLinked = Boolean(status.phone) && !["unpaired", "logged_out"].includes(status.state);

  return (
    <div className="space-y-4 rounded border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-slate-800">{t("panels.linked.title")}</h2>
        <span className={`rounded px-2 py-1 text-xs font-medium ${copy.tone}`}>{copy.label}</span>
        {isLinked && (
          <span className="font-mono text-xs text-slate-600">
            +{status.phone}
            {status.pushName ? ` · ${status.pushName}` : ""}
          </span>
        )}
      </div>
      <p className="text-xs text-slate-500">{t("panels.linked.explain")}</p>
      {status.detail && <p className="text-sm text-slate-700">{status.detail}</p>}
      {status.dailyCap > 0 && (
        <p className="text-xs text-slate-500">{t("panels.linked.sentToday", { sent: status.sentToday, cap: status.dailyCap })}</p>
      )}

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}

      {status.state === "pairing" && status.pairCode && secondsLeft > 0 && (
        <div className="rounded border border-slate-200 bg-slate-50 p-4">
          <p className="font-mono text-3xl tracking-widest text-slate-900">
            {status.pairCode.slice(0, 4)}-{status.pairCode.slice(4)}
          </p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-700">
            <li>{t("panels.linked.step1")}</li>
            <li>{t("panels.linked.step2")}</li>
            <li>{t("panels.linked.step3")}</li>
          </ol>
          <p className="mt-2 font-mono text-xs text-slate-500">
            {t("panels.linked.expiresIn", { time: `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}` })}
          </p>
        </div>
      )}

      {canEdit && canPair && (
        <form onSubmit={pair} className="flex gap-2">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t("panels.linked.phonePlaceholder")}
            className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy || phone.trim().length < 8}
            className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? t("panels.linked.requesting") : t("panels.linked.getCode")}
          </button>
        </form>
      )}

      {canEdit && isLinked && (
        <button
          type="button"
          onClick={unlink}
          disabled={busy}
          className="rounded border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
        >
          {t("panels.linked.unlink")}
        </button>
      )}
    </div>
  );
}
