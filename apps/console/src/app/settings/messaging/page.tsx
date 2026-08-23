"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient, isAdmin } from "@/lib/auth-client";

type ProviderName = "console_log" | "whatsapp_cloud";

interface MessagingConfig {
  provider: ProviderName;
  phoneNumberId: string | null;
  businessAccountId: string | null;
  accessTokenHint: string | null;
  hasAccessToken: boolean;
  updatedAt: string | null;
  updatedByUserId: string | null;
  source: "organization" | "environment" | "default";
  canStoreSecrets: boolean;
}

interface TestResult {
  ok: boolean;
  provider: ProviderName;
  providerRef: string | null;
  error: string | null;
}

const SOURCE_COPY: Record<MessagingConfig["source"], { label: string; tone: string; detail: string }> = {
  organization: {
    label: "Using your saved number",
    tone: "bg-green-100 text-green-800",
    detail: "Messages to customers go out through the WhatsApp number configured here, for every branch in the organization.",
  },
  environment: {
    label: "Using deployment credentials",
    tone: "bg-amber-100 text-amber-800",
    detail:
      "Nothing is saved here yet, so messages use the credentials set on the server. Saving a number below takes over from them.",
  },
  default: {
    label: "Not sending — logging only",
    tone: "bg-slate-200 text-slate-700",
    detail:
      "Customer messages are written to the notification log but never delivered. Add a WhatsApp number below to start sending.",
  },
};

export default function MessagingSettingsPage() {
  const router = useRouter();
  const me = authClient.getUser();
  const canEdit = isAdmin(me);

  const [config, setConfig] = useState<MessagingConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const [provider, setProvider] = useState<ProviderName>("console_log");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [accessToken, setAccessToken] = useState("");

  const [testTo, setTestTo] = useState("");
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  async function load() {
    try {
      const data = await apiFetch<MessagingConfig>("/organization/messaging", { token: authClient.getToken() });
      setConfig(data);
      setProvider(data.provider);
      setPhoneNumberId(data.phoneNumberId ?? "");
      setBusinessAccountId(data.businessAccountId ?? "");
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return router.push("/login");
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const data = await apiFetch<MessagingConfig>("/organization/messaging", {
        token: authClient.getToken(),
        method: "PUT",
        body: {
          provider,
          phoneNumberId: phoneNumberId.trim() || null,
          businessAccountId: businessAccountId.trim() || null,
          // Blank means "keep what's stored" — the token is never sent back to
          // the browser, so an empty field can't mean "clear it".
          ...(accessToken.trim() ? { accessToken: accessToken.trim() } : {}),
        },
      });
      setConfig(data);
      setAccessToken("");
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiFetch<TestResult>("/organization/messaging/test", {
        token: authClient.getToken(),
        method: "POST",
        body: {
          to: testTo.trim(),
          // Unsaved values in the form are used for the test, so a credential
          // can be proven before it's committed.
          ...(phoneNumberId.trim() && accessToken.trim()
            ? { phoneNumberId: phoneNumberId.trim(), accessToken: accessToken.trim() }
            : {}),
        },
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, provider, providerRef: null, error: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }

  const status = config ? SOURCE_COPY[config.source] : null;

  return (
    <ConsoleShell>
      <div className="max-w-3xl space-y-6">
        <h1 className="text-2xl font-semibold">Messaging</h1>
        <p className="text-sm text-slate-600">
          WhatsApp is how customers hear from you — booking confirmations, waitlist places, KYC links, invoices and payment
          reminders. One number serves every branch in the organization.
        </p>

        {error && <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

        {config && status && (
          <div className="rounded border border-slate-200 bg-white p-4">
            <div className="flex items-center gap-3">
              <span className={`rounded px-2 py-1 text-xs font-medium ${status.tone}`}>{status.label}</span>
              {config.accessTokenHint && (
                <span className="text-xs text-slate-500">token ending ····{config.accessTokenHint}</span>
              )}
            </div>
            <p className="mt-2 text-sm text-slate-600">{status.detail}</p>
            {config.updatedAt && (
              <p className="mt-1 text-xs text-slate-400">Last changed {new Date(config.updatedAt).toLocaleString()}</p>
            )}
          </div>
        )}

        {config && !config.canStoreSecrets && (
          <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            The API has no <code>MESSAGING_CONFIG_KEY</code> set, so an access token can&apos;t be stored securely and saving one
            will be refused. Generate a key with <code>openssl rand -hex 32</code>, set it on the API and restart.
          </div>
        )}

        <form onSubmit={save} className="space-y-4 rounded border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-800">WhatsApp Business (Meta Cloud API)</h2>

          <label className="block text-sm">
            <span className="text-slate-700">Sending</span>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as ProviderName)}
              disabled={!canEdit}
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
            >
              <option value="console_log">Off — log messages only</option>
              <option value="whatsapp_cloud">On — send via WhatsApp Cloud API</option>
            </select>
          </label>

          <label className="block text-sm">
            <span className="text-slate-700">Phone number ID</span>
            <input
              value={phoneNumberId}
              onChange={(e) => setPhoneNumberId(e.target.value)}
              disabled={!canEdit}
              placeholder="From Meta Business Suite → WhatsApp → API Setup"
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
            />
          </label>

          <label className="block text-sm">
            <span className="text-slate-700">
              WhatsApp Business account ID <span className="text-slate-400">(optional)</span>
            </span>
            <input
              value={businessAccountId}
              onChange={(e) => setBusinessAccountId(e.target.value)}
              disabled={!canEdit}
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
            />
          </label>

          <label className="block text-sm">
            <span className="text-slate-700">Permanent access token</span>
            <input
              type="password"
              autoComplete="off"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              disabled={!canEdit}
              placeholder={config?.hasAccessToken ? "Saved — leave blank to keep it" : "Paste the system user token"}
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
            />
            <span className="mt-1 block text-xs text-slate-500">
              Stored encrypted and never shown again. Leave blank to keep the current one.
            </span>
          </label>

          {canEdit && (
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={busy}
                className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save"}
              </button>
              {saved && <span className="text-sm text-green-700">Saved.</span>}
            </div>
          )}
        </form>

        {canEdit && (
          <div className="space-y-3 rounded border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-800">Send a test message</h2>
            <p className="text-xs text-slate-500">
              Sends the OTP template to one number so you can confirm the credentials work. If you&apos;ve typed a new number
              and token above, the test uses those — you can check before saving. Test sends aren&apos;t recorded against any
              customer.
            </p>
            <div className="flex gap-2">
              <input
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="628123456789"
                className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={sendTest}
                disabled={testing || testTo.trim().length < 8}
                className="rounded border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-50"
              >
                {testing ? "Sending…" : "Send test"}
              </button>
            </div>
            {testResult && (
              <div
                className={`rounded px-3 py-2 text-sm ${
                  testResult.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"
                }`}
              >
                {testResult.ok
                  ? testResult.provider === "console_log"
                    ? "Sending is off, so the message was written to the log instead of delivered."
                    : `Delivered. Meta message id ${testResult.providerRef}.`
                  : testResult.error}
              </div>
            )}
          </div>
        )}
      </div>
    </ConsoleShell>
  );
}
