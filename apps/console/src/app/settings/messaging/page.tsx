"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ConsoleShell } from "@/components/ConsoleShell";
import { LinkedDevicePanel } from "@/components/LinkedDevicePanel";
import { TestAllowlistPanel } from "@/components/TestAllowlistPanel";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient, isOrgAdmin } from "@/lib/auth-client";
import { useT } from "@/lib/i18n";
import { notifyMessagingPauseChanged } from "@/lib/messaging-pause";

type ProviderName = "console_log" | "whatsapp_cloud" | "whatsapp_linked";

interface MessagingConfig {
  provider: ProviderName;
  phoneNumberId: string | null;
  businessAccountId: string | null;
  autoReplyEnabled: boolean;
  autoReplyText: string | null;
  autoReplyCooldownHours: number;
  systemWhatsapp: string | null;
  pause: { paused: boolean; reason: string | null; pausedAt: string | null; pausedByUserId: string | null };
  accessTokenHint: string | null;
  hasAccessToken: boolean;
  updatedAt: string | null;
  updatedByUserId: string | null;
  source: "organization" | "environment" | "default";
  canStoreSecrets: boolean;
  linkedBridgeConfigured: boolean;
}

interface TestResult {
  ok: boolean;
  provider: ProviderName;
  providerRef: string | null;
  error: string | null;
}

/** Message keys under `msgSettings.source.` and the badge colour, per credential source. */
const SOURCE_TONE: Record<MessagingConfig["source"], string> = {
  organization: "bg-green-100 text-green-800",
  environment: "bg-amber-100 text-amber-800",
  default: "bg-slate-200 text-slate-700",
};

export default function MessagingSettingsPage() {
  const { t, intl } = useT();
  const router = useRouter();
  const me = authClient.getUser();
  // PRD go-live §9.5 — the number, pairing, auto-reply and pause belong to the
  // whole organization, so only an organization-scoped Admin changes them.
  const canEdit = isOrgAdmin(me);

  const [config, setConfig] = useState<MessagingConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const [provider, setProvider] = useState<ProviderName>("console_log");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [autoReplyText, setAutoReplyText] = useState("");
  const [cooldownHours, setCooldownHours] = useState("12");
  const [systemWhatsapp, setSystemWhatsapp] = useState("");

  const [pauseReason, setPauseReason] = useState("");
  const [pauseBusy, setPauseBusy] = useState(false);

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
      setAutoReplyEnabled(data.autoReplyEnabled);
      setAutoReplyText(data.autoReplyText ?? "");
      setCooldownHours(String(data.autoReplyCooldownHours ?? 12));
      setSystemWhatsapp(data.systemWhatsapp ?? "");
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
          autoReplyEnabled,
          autoReplyText: autoReplyText.trim() || null,
          autoReplyCooldownHours: Number(cooldownHours) > 0 ? Number(cooldownHours) : null,
          systemWhatsapp: systemWhatsapp.trim() || null,
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

  /** PRD go-live §9.1 — the organization-wide kill switch, behind a confirmation. */
  async function togglePause(next: boolean) {
    if (next && !pauseReason.trim()) {
      setError(t("msgSettings.pause.reasonRequired"));
      return;
    }
    const question = next ? t("msgSettings.pause.confirmPause") : t("msgSettings.pause.confirmResume");
    if (!window.confirm(question)) return;
    setPauseBusy(true);
    setError(null);
    try {
      await apiFetch("/organization/messaging/pause", {
        token: authClient.getToken(),
        method: "PUT",
        body: next ? { paused: true, reason: pauseReason.trim() } : { paused: false },
      });
      setPauseReason("");
      notifyMessagingPauseChanged();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPauseBusy(false);
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
          // The linked device can be tested before the organization switches to it.
          ...(provider === "whatsapp_linked" ? { provider } : {}),
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

  const status = config
    ? { label: t(`msgSettings.source.${config.source}`), tone: SOURCE_TONE[config.source], detail: t(`msgSettings.source.${config.source}Detail`) }
    : null;

  return (
    <ConsoleShell>
      <div className="max-w-3xl space-y-6">
        <h1 className="text-2xl font-semibold">{t("msgSettings.title")}</h1>
        <p className="text-sm text-slate-600">{t("msgSettings.intro")}</p>

        {error && <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

        {config && status && (
          <div className="rounded border border-slate-200 bg-white p-4">
            <div className="flex items-center gap-3">
              <span className={`rounded px-2 py-1 text-xs font-medium ${status.tone}`}>{status.label}</span>
              {config.accessTokenHint && (
                <span className="text-xs text-slate-500">{t("msgSettings.tokenEnding", { hint: config.accessTokenHint })}</span>
              )}
            </div>
            <p className="mt-2 text-sm text-slate-600">{status.detail}</p>
            {config.updatedAt && (
              <p className="mt-1 text-xs text-slate-400">{t("msgSettings.lastChanged", { when: new Date(config.updatedAt).toLocaleString(intl) })}</p>
            )}
          </div>
        )}

        {config && (
          <div className={`space-y-3 rounded border p-4 ${config.pause.paused ? "border-red-300 bg-red-50" : "border-slate-200 bg-white"}`}>
            <h2 className="text-sm font-semibold text-slate-800">{t("msgSettings.pause.title")}</h2>
            {config.pause.paused ? (
              <p className="text-sm text-red-800">
                <b>{t("msgSettings.pause.paused")}</b>
                {config.pause.reason ? `: ${config.pause.reason}` : null}
                {config.pause.pausedAt ? <> — {t("msgSettings.pause.since", { when: new Date(config.pause.pausedAt).toLocaleString(intl) })}</> : null}.{" "}
                {t("msgSettings.pause.pausedBody")}
              </p>
            ) : (
              <p className="text-xs text-slate-500">{t("msgSettings.pause.explain")}</p>
            )}
            {canEdit ? (
              config.pause.paused ? (
                <button
                  onClick={() => void togglePause(false)}
                  disabled={pauseBusy}
                  className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {pauseBusy ? t("msgSettings.pause.working") : t("msgSettings.pause.resume")}
                </button>
              ) : (
                <div className="flex gap-2">
                  <input
                    value={pauseReason}
                    onChange={(e) => setPauseReason(e.target.value)}
                    maxLength={300}
                    placeholder={t("msgSettings.pause.reasonPlaceholder")}
                    className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
                  />
                  <button
                    onClick={() => void togglePause(true)}
                    disabled={pauseBusy}
                    className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {pauseBusy ? t("msgSettings.pause.working") : t("msgSettings.pause.pauseButton")}
                  </button>
                </div>
              )
            ) : (
              <p className="text-xs text-slate-500">{t("msgSettings.pause.onlyOrgAdmin")}</p>
            )}
          </div>
        )}

        <TestAllowlistPanel canEdit={canEdit} />

        {!canEdit && (
          <div className="rounded border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">{t("msgSettings.readOnlyNote")}</div>
        )}

        <LinkedDevicePanel canEdit={canEdit} />

        {config && !config.canStoreSecrets && provider === "whatsapp_cloud" && (
          <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{t("msgSettings.noSecretKey")}</div>
        )}

        <form onSubmit={save} className="space-y-4 rounded border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-800">{t("msgSettings.how.title")}</h2>

          <label className="block text-sm">
            <span className="text-slate-700">{t("msgSettings.how.sending")}</span>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as ProviderName)}
              disabled={!canEdit}
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
            >
              <option value="console_log">{t("msgSettings.how.off")}</option>
              <option value="whatsapp_linked" disabled={!config?.linkedBridgeConfigured}>
                {t("msgSettings.how.linked")}
              </option>
              <option value="whatsapp_cloud">{t("msgSettings.how.cloud")}</option>
            </select>
          </label>

          {provider === "whatsapp_cloud" && (
            <>
              <label className="block text-sm">
                <span className="text-slate-700">{t("msgSettings.how.phoneNumberId")}</span>
                <input
                  value={phoneNumberId}
                  onChange={(e) => setPhoneNumberId(e.target.value)}
                  disabled={!canEdit}
                  placeholder={t("msgSettings.how.phoneNumberIdPlaceholder")}
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
                />
              </label>

              <label className="block text-sm">
                <span className="text-slate-700">
                  {t("msgSettings.how.businessAccountId")} <span className="text-slate-400">({t("common.optional")})</span>
                </span>
                <input
                  value={businessAccountId}
                  onChange={(e) => setBusinessAccountId(e.target.value)}
                  disabled={!canEdit}
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
                />
              </label>

              <label className="block text-sm">
                <span className="text-slate-700">{t("msgSettings.how.token")}</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  disabled={!canEdit}
                  placeholder={config?.hasAccessToken ? t("msgSettings.how.tokenSaved") : t("msgSettings.how.tokenPaste")}
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
                />
                <span className="mt-1 block text-xs text-slate-500">{t("msgSettings.how.tokenHint")}</span>
              </label>
            </>
          )}

          {canEdit && (
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={busy}
                className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? t("common.saving") : t("common.save")}
              </button>
              {saved && <span className="text-sm text-green-700">{t("common.saved")}</span>}
            </div>
          )}
        </form>

        {canEdit && (
          <form onSubmit={save} className="space-y-4 rounded border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-800">{t("msgSettings.auto.title")}</h2>
            <p className="text-xs text-slate-500">{t("msgSettings.auto.intro")}</p>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoReplyEnabled}
                onChange={(e) => setAutoReplyEnabled(e.target.checked)}
                disabled={!canEdit}
              />
              <span className="text-slate-700">{t("msgSettings.auto.toggle")}</span>
            </label>

            <label className="block text-sm">
              <span className="text-slate-700">{t("msgSettings.auto.text")}</span>
              <textarea
                value={autoReplyText}
                onChange={(e) => setAutoReplyText(e.target.value)}
                disabled={!canEdit || !autoReplyEnabled}
                rows={3}
                maxLength={1000}
                placeholder={t("msgSettings.auto.placeholder")}
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
              />
              <span className="mt-1 block text-xs text-slate-500">{t("msgSettings.auto.placeholders")}</span>
            </label>

            <label className="block text-sm">
              <span className="text-slate-700">{t("msgSettings.auto.cooldown")}</span>
              <input
                type="number"
                min={1}
                max={336}
                value={cooldownHours}
                onChange={(e) => setCooldownHours(e.target.value)}
                disabled={!canEdit || !autoReplyEnabled}
                className="mt-1 w-32 rounded border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
              />
              <span className="mt-1 block text-xs text-slate-500">{t("msgSettings.auto.cooldownHint")}</span>
            </label>

            <label className="block text-sm">
              <span className="text-slate-700">{t("msgSettings.auto.systemNumber")}</span>
              <input
                value={systemWhatsapp}
                onChange={(e) => setSystemWhatsapp(e.target.value)}
                placeholder="+628111877838"
                disabled={!canEdit}
                className="mt-1 w-56 rounded border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
              />
              <span className="mt-1 block text-xs text-slate-500">{t("msgSettings.auto.systemNumberHint")}</span>
            </label>

            <button type="submit" disabled={busy} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {busy ? t("common.saving") : t("common.save")}
            </button>
          </form>
        )}

        {canEdit && (
          <div className="space-y-3 rounded border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-800">{t("msgSettings.test.title")}</h2>
            <p className="text-xs text-slate-500">{t("msgSettings.test.intro")}</p>
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
                {testing ? t("common.sending") : t("msgSettings.test.send")}
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
                    ? t("msgSettings.test.loggedOnly")
                    : t("msgSettings.test.sent", { id: testResult.providerRef })
                  : testResult.error}
              </div>
            )}
          </div>
        )}
      </div>
    </ConsoleShell>
  );
}
