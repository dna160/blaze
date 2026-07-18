"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AssetDto, OtaSubscriptionDto } from "@rentos/contracts";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";
const TENANT_SLUG = process.env.NEXT_PUBLIC_TENANT_SLUG ?? "";

/**
 * PRD §13 Phase 4 "OTA channel sync" (Session 22). Outbound: a per-Asset
 * .ics feed URL to paste into Airbnb/Booking.com's "import calendar"
 * field. Inbound: register that OTA's own export URL here so
 * apps/worker's hourly sync blocks those nights in RentOS too.
 */
export default function OtaSyncPage() {
  const router = useRouter();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [assets, setAssets] = useState<AssetDto[] | null>(null);
  const [subscriptions, setSubscriptions] = useState<OtaSubscriptionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [label, setLabel] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const [assetList, subs] = await Promise.all([
        apiFetch<AssetDto[]>("/catalog/assets", { token }),
        apiFetch<OtaSubscriptionDto[]>("/ota/subscriptions", { token }),
      ]);
      setAssets(assetList);
      setSubscriptions(subs);
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

  async function createSubscription() {
    if (!selectedAssetId || !label.trim() || !sourceUrl.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/ota/subscriptions", {
        token: authClient.getToken(),
        method: "POST",
        body: { assetId: selectedAssetId, label: label.trim(), sourceUrl: sourceUrl.trim() },
      });
      setLabel("");
      setSourceUrl("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add subscription.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/ota/subscriptions/${id}`, { token: authClient.getToken(), method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to remove subscription.");
    } finally {
      setBusy(false);
    }
  }

  function feedUrl(assetId: string): string {
    return `${API_BASE}/ota/assets/${assetId}/calendar.ics?tenant=${TENANT_SLUG}`;
  }

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">OTA Calendar Sync</h1>
      <p className="mt-1 text-sm text-brand-700/60">
        Export each unit's booked nights as an .ics feed for Airbnb/Booking.com, and import their calendars back so
        RentOS never double-books a unit already reserved on another channel.
      </p>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {enabled === null && <p className="mt-6">Loading...</p>}

      {enabled === false && (
        <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm text-amber-800">
          OTA calendar sync is not enabled for this tenant.
        </div>
      )}

      {enabled && (
        <div className="mt-6 space-y-8">
          <section>
            <h2 className="text-lg font-medium">Outbound feeds</h2>
            <p className="mt-1 text-sm text-brand-700/60">
              Paste a unit's URL into the OTA's "import calendar" / "sync calendar" field.
            </p>
            <div className="mt-3 overflow-hidden rounded-lg border border-brand-600/10">
              <table className="w-full text-sm">
                <thead className="bg-brand-700/5 text-left text-xs uppercase text-brand-700/60">
                  <tr>
                    <th className="px-4 py-2">Unit</th>
                    <th className="px-4 py-2">Feed URL</th>
                  </tr>
                </thead>
                <tbody>
                  {(assets ?? []).map((a) => (
                    <tr key={a.id} className="border-t border-brand-600/10">
                      <td className="px-4 py-2">{a.code}</td>
                      <td className="px-4 py-2 font-mono text-xs break-all">{feedUrl(a.id)}</td>
                    </tr>
                  ))}
                  {assets?.length === 0 && (
                    <tr>
                      <td colSpan={2} className="px-4 py-6 text-center text-brand-700/50">
                        No units yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-medium">Inbound subscriptions</h2>
            <p className="mt-1 text-sm text-brand-700/60">
              Register the OTA's own .ics export URL for a unit — synced hourly.
            </p>

            <div className="mt-3 space-y-2 rounded-lg border border-brand-600/10 bg-white p-4">
              <select
                value={selectedAssetId}
                onChange={(e) => setSelectedAssetId(e.target.value)}
                className="w-full rounded border border-brand-600/20 px-3 py-1.5 text-sm"
              >
                <option value="">Choose a unit...</option>
                {(assets ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code}
                  </option>
                ))}
              </select>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Label (e.g. Airbnb)"
                className="w-full rounded border border-brand-600/20 px-3 py-1.5 text-sm"
              />
              <input
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://www.airbnb.com/calendar/ical/....ics"
                className="w-full rounded border border-brand-600/20 px-3 py-1.5 text-sm"
              />
              <button
                onClick={createSubscription}
                disabled={busy || !selectedAssetId || !label.trim() || !sourceUrl.trim()}
                className="rounded bg-brand-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Add subscription
              </button>
            </div>

            <div className="mt-4 overflow-hidden rounded-lg border border-brand-600/10">
              <table className="w-full text-sm">
                <thead className="bg-brand-700/5 text-left text-xs uppercase text-brand-700/60">
                  <tr>
                    <th className="px-4 py-2">Label</th>
                    <th className="px-4 py-2">Source</th>
                    <th className="px-4 py-2">Last sync</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {(subscriptions ?? []).map((s) => (
                    <tr key={s.id} className="border-t border-brand-600/10">
                      <td className="px-4 py-2">{s.label}</td>
                      <td className="max-w-xs truncate px-4 py-2 font-mono text-xs">{s.sourceUrl}</td>
                      <td className="px-4 py-2">
                        {s.lastSyncedAt ? (
                          <>
                            {s.lastSyncStatus} · {new Date(s.lastSyncedAt).toLocaleString("id-ID")}
                            {s.lastSyncError && <p className="text-xs text-red-600">{s.lastSyncError}</p>}
                          </>
                        ) : (
                          "Never synced"
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <button onClick={() => remove(s.id)} className="text-xs font-medium text-red-600 hover:underline">
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                  {subscriptions?.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-brand-700/50">
                        No inbound subscriptions yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </ConsoleShell>
  );
}
