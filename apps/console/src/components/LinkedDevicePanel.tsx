"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

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

const STATE_COPY: Record<LinkedState, { label: string; tone: string }> = {
  unpaired: { label: "Not linked", tone: "bg-slate-200 text-slate-700" },
  pairing: { label: "Waiting for the code", tone: "bg-amber-100 text-amber-800" },
  connecting: { label: "Connecting", tone: "bg-amber-100 text-amber-800" },
  connected: { label: "Connected", tone: "bg-green-100 text-green-800" },
  disconnected: { label: "Reconnecting", tone: "bg-amber-100 text-amber-800" },
  logged_out: { label: "Unlinked from the phone", tone: "bg-red-100 text-red-800" },
  replaced: { label: "Session taken over", tone: "bg-red-100 text-red-800" },
  banned: { label: "Temporarily banned", tone: "bg-red-100 text-red-800" },
  unreachable: { label: "Bridge unreachable", tone: "bg-red-100 text-red-800" },
};

/** States that change on their own, so the panel keeps polling while in them. */
const TRANSIENT: LinkedState[] = ["pairing", "connecting", "disconnected"];

/**
 * The organization's WhatsApp linked device — Project Smile's pairing flow: ask
 * for a code, the number's owner types it into WhatsApp → Linked devices →
 * Link with phone number, and this flips to Connected by itself.
 */
export function LinkedDevicePanel({ canEdit }: { canEdit: boolean }) {
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
      !confirm("Unlink this WhatsApp number? RentOS stops sending until a number is paired again.")
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
      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        The WhatsApp bridge isn&apos;t set up on this deployment. Deploy <code>apps/wa-bridge</code>{" "}
        and set <code>WA_BRIDGE_URL</code> and <code>WA_BRIDGE_TOKEN</code> on the API and worker to
        link a number here.
      </div>
    );
  }

  const copy = STATE_COPY[status.state];
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
        <h2 className="text-sm font-semibold text-slate-800">Linked WhatsApp number</h2>
        <span className={`rounded px-2 py-1 text-xs font-medium ${copy.tone}`}>{copy.label}</span>
        {isLinked && (
          <span className="font-mono text-xs text-slate-600">
            +{status.phone}
            {status.pushName ? ` · ${status.pushName}` : ""}
          </span>
        )}
      </div>
      <p className="text-xs text-slate-500">
        RentOS sends from your own WhatsApp number as a linked device, the same way WhatsApp Web
        does. There&apos;s no Meta approval and no templates: booking, KYC, invoice and reminder
        messages go out as soon as the number is connected. The phone stays the main device; keep it
        online at least every few days, or WhatsApp unlinks it after about 14.
      </p>
      {status.detail && <p className="text-sm text-slate-700">{status.detail}</p>}
      {status.state === "connected" && (
        <p className="text-xs text-slate-500">
          Sent today: {status.sentToday} of {status.dailyCap}. Messages are spaced a few seconds
          apart to keep the number in good standing.
        </p>
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
            <li>On the phone with this number, open WhatsApp → Settings → Linked devices.</li>
            <li>Tap Link a device, then Link with phone number instead.</li>
            <li>Type the code above. This page turns Connected by itself.</li>
          </ol>
          <p className="mt-2 font-mono text-xs text-slate-500">
            Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
          </p>
        </div>
      )}

      {canEdit && canPair && (
        <form onSubmit={pair} className="flex gap-2">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Number to link, e.g. 6281234567890"
            className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy || phone.trim().length < 8}
            className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Requesting…" : "Get pairing code"}
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
          Unlink number
        </button>
      )}
    </div>
  );
}
