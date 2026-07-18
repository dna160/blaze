"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { WEBHOOK_EVENT_TYPES, type ApiKeyDto, type CreatedApiKeyResponse, type CreatedWebhookSubscriptionResponse, type WebhookDeliveryDto, type WebhookEventType, type WebhookSubscriptionDto } from "@rentos/contracts";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

/**
 * PRD Phase 4 tenant-facing API + outbound webhooks (docs/HANDOFF.md
 * Session 20). Every mutating/list call here 403s with a clear message
 * for tenants that don't have featureFlags.api_access_enabled — the
 * backend is the real gate (ApiKeysService/TenantWebhooksService
 * .assertEnabled), this page just surfaces that state rather than
 * hiding itself, since the console is deployed one instance per tenant
 * (see lib/api.ts) and there's no cheap client-side way to know the
 * flag before the first request.
 */
export default function ApiAccessPage() {
  const router = useRouter();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [keys, setKeys] = useState<ApiKeyDto[] | null>(null);
  const [subscriptions, setSubscriptions] = useState<WebhookSubscriptionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [revealedKey, setRevealedKey] = useState<CreatedApiKeyResponse | null>(null);
  const [newWebhookUrl, setNewWebhookUrl] = useState("");
  const [newWebhookEvents, setNewWebhookEvents] = useState<WebhookEventType[]>([]);
  const [revealedSecret, setRevealedSecret] = useState<CreatedWebhookSubscriptionResponse | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryDto[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const [k, s] = await Promise.all([
        apiFetch<ApiKeyDto[]>("/api-keys", { token }),
        apiFetch<WebhookSubscriptionDto[]>("/webhook-subscriptions", { token }),
      ]);
      setKeys(k);
      setSubscriptions(s);
      setEnabled(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setEnabled(false);
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        router.push("/login");
      }
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createKey() {
    if (!newKeyLabel.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await apiFetch<CreatedApiKeyResponse>("/api-keys", {
        token: authClient.getToken(),
        method: "POST",
        body: { label: newKeyLabel.trim() },
      });
      setRevealedKey(created);
      setNewKeyLabel("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create API key.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(id: string) {
    if (!window.confirm("Revoke this API key? Any system using it will immediately lose access.")) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api-keys/${id}`, { token: authClient.getToken(), method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to revoke API key.");
    } finally {
      setBusy(false);
    }
  }

  function toggleEvent(evt: WebhookEventType) {
    setNewWebhookEvents((prev) => (prev.includes(evt) ? prev.filter((e) => e !== evt) : [...prev, evt]));
  }

  async function createSubscription() {
    if (!newWebhookUrl.trim() || newWebhookEvents.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const created = await apiFetch<CreatedWebhookSubscriptionResponse>("/webhook-subscriptions", {
        token: authClient.getToken(),
        method: "POST",
        body: { url: newWebhookUrl.trim(), eventTypes: newWebhookEvents },
      });
      setRevealedSecret(created);
      setNewWebhookUrl("");
      setNewWebhookEvents([]);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create webhook subscription.");
    } finally {
      setBusy(false);
    }
  }

  async function viewDeliveries(id: string) {
    if (deliveriesFor === id) {
      setDeliveriesFor(null);
      setDeliveries(null);
      return;
    }
    setDeliveriesFor(id);
    setDeliveries(null);
    try {
      const data = await apiFetch<WebhookDeliveryDto[]>(`/webhook-subscriptions/${id}/deliveries`, {
        token: authClient.getToken(),
      });
      setDeliveries(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load delivery history.");
    }
  }

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">API Access</h1>
      <p className="mt-1 text-sm text-brand-700/60">
        API keys and outbound webhooks for connecting your own systems (PRD Phase 4).
      </p>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {enabled === null && <p className="mt-6">Loading...</p>}

      {enabled === false && (
        <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm text-amber-800">
          External API access is not enabled for this tenant.
        </div>
      )}

      {enabled && (
        <div className="mt-6 space-y-8">
          <section>
            <h2 className="text-lg font-medium">API Keys</h2>
            <p className="mt-1 text-sm text-brand-700/60">
              Bearer tokens for GET /external/bookings and /external/invoices. Shown once, at creation.
            </p>

            {revealedKey && (
              <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm">
                <div className="flex items-start justify-between">
                  <p className="font-medium">API key "{revealedKey.label}" created</p>
                  <button onClick={() => setRevealedKey(null)} className="text-emerald-700/60 hover:text-emerald-900">
                    Dismiss
                  </button>
                </div>
                <p className="mt-2 break-all rounded bg-white px-3 py-2 font-mono text-xs">{revealedKey.key}</p>
                <p className="mt-2 text-emerald-800">
                  Copy this now — it will not be shown again. Use it as <code>Authorization: Bearer &lt;key&gt;</code>.
                </p>
              </div>
            )}

            <div className="mt-3 flex items-center gap-2">
              <input
                value={newKeyLabel}
                onChange={(e) => setNewKeyLabel(e.target.value)}
                placeholder="Label (e.g. Accounting integration)"
                className="rounded border border-brand-600/20 px-3 py-1.5 text-sm"
              />
              <button
                onClick={createKey}
                disabled={busy || !newKeyLabel.trim()}
                className="rounded bg-brand-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Generate key
              </button>
            </div>

            <div className="mt-4 overflow-hidden rounded-lg border border-brand-600/10">
              <table className="w-full text-sm">
                <thead className="bg-brand-700/5 text-left text-xs uppercase text-brand-700/60">
                  <tr>
                    <th className="px-4 py-2">Label</th>
                    <th className="px-4 py-2">Prefix</th>
                    <th className="px-4 py-2">Last used</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {(keys ?? []).map((k) => (
                    <tr key={k.id} className="border-t border-brand-600/10">
                      <td className="px-4 py-2">{k.label}</td>
                      <td className="px-4 py-2 font-mono text-xs">{k.keyPrefix}…</td>
                      <td className="px-4 py-2">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString("id-ID") : "Never"}</td>
                      <td className="px-4 py-2">{k.revokedAt ? "Revoked" : "Active"}</td>
                      <td className="px-4 py-2 text-right">
                        {!k.revokedAt && (
                          <button onClick={() => revokeKey(k.id)} className="text-xs font-medium text-red-600 hover:underline">
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {keys?.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-brand-700/50">
                        No API keys yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-medium">Webhook Subscriptions</h2>
            <p className="mt-1 text-sm text-brand-700/60">
              Get notified at your own URL when booking.approved, invoice.paid, or payment.received happen. Payloads are
              signed with HMAC-SHA256 in the X-RentOS-Signature header.
            </p>

            {revealedSecret && (
              <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm">
                <div className="flex items-start justify-between">
                  <p className="font-medium">Webhook subscribed: {revealedSecret.url}</p>
                  <button onClick={() => setRevealedSecret(null)} className="text-emerald-700/60 hover:text-emerald-900">
                    Dismiss
                  </button>
                </div>
                <p className="mt-2 break-all rounded bg-white px-3 py-2 font-mono text-xs">{revealedSecret.secret}</p>
                <p className="mt-2 text-emerald-800">
                  Copy this signing secret now — it will not be shown again.
                </p>
              </div>
            )}

            <div className="mt-3 space-y-2 rounded-lg border border-brand-600/10 bg-white p-4">
              <input
                value={newWebhookUrl}
                onChange={(e) => setNewWebhookUrl(e.target.value)}
                placeholder="https://your-system.example.com/webhooks/rentos"
                className="w-full rounded border border-brand-600/20 px-3 py-1.5 text-sm"
              />
              <div className="flex flex-wrap gap-3 text-sm">
                {WEBHOOK_EVENT_TYPES.map((evt) => (
                  <label key={evt} className="flex items-center gap-1.5">
                    <input type="checkbox" checked={newWebhookEvents.includes(evt)} onChange={() => toggleEvent(evt)} />
                    {evt}
                  </label>
                ))}
              </div>
              <button
                onClick={createSubscription}
                disabled={busy || !newWebhookUrl.trim() || newWebhookEvents.length === 0}
                className="rounded bg-brand-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Add subscription
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {(subscriptions ?? []).map((s) => (
                <div key={s.id} className="rounded-lg border border-brand-600/10 bg-white p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="break-all font-medium">{s.url}</p>
                      <p className="mt-1 text-xs text-brand-700/60">{s.eventTypes.join(", ")}</p>
                      <p className="mt-1 text-xs text-brand-700/40">{s.isActive ? "Active" : "Inactive"}</p>
                    </div>
                    <button onClick={() => viewDeliveries(s.id)} className="text-xs font-medium text-brand-700 hover:underline">
                      {deliveriesFor === s.id ? "Hide deliveries" : "View deliveries"}
                    </button>
                  </div>
                  {deliveriesFor === s.id && (
                    <div className="mt-3 border-t border-brand-600/10 pt-3">
                      {!deliveries ? (
                        <p className="text-sm text-brand-700/60">Loading...</p>
                      ) : deliveries.length === 0 ? (
                        <p className="text-sm text-brand-700/60">No deliveries yet.</p>
                      ) : (
                        <table className="w-full text-xs">
                          <thead className="text-left uppercase text-brand-700/50">
                            <tr>
                              <th className="py-1 pr-2">Event</th>
                              <th className="py-1 pr-2">Status</th>
                              <th className="py-1 pr-2">HTTP</th>
                              <th className="py-1 pr-2">Attempt</th>
                              <th className="py-1 pr-2">When</th>
                            </tr>
                          </thead>
                          <tbody>
                            {deliveries.map((d) => (
                              <tr key={d.id} className="border-t border-brand-600/5">
                                <td className="py-1 pr-2">{d.eventType}</td>
                                <td className="py-1 pr-2">{d.status}</td>
                                <td className="py-1 pr-2">{d.httpStatus ?? "—"}</td>
                                <td className="py-1 pr-2">{d.attempt}</td>
                                <td className="py-1 pr-2">{new Date(d.createdAt).toLocaleString("id-ID")}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {subscriptions?.length === 0 && <p className="text-sm text-brand-700/50">No webhook subscriptions yet.</p>}
            </div>
          </section>
        </div>
      )}
    </ConsoleShell>
  );
}
