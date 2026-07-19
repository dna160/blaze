"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { PlatformInvoiceDto, PlatformTenantSummaryDto, RunBillingResponse } from "@rentos/contracts";

import { ApiError } from "@/lib/api";
import { platformApiFetch, platformAuthClient } from "@/lib/platform-api";

/**
 * Platform-admin dashboard (Session 26) — tenant list + billing/metering
 * overview + a self-serve signup wizard link. Gated to the ONE demo
 * PLATFORM_ADMIN account (platform-admin@rentos.test); the backend is the
 * real gate (every mutating call here 403s without the PLATFORM_ADMIN
 * role), matching the api-access/ota-sync pages' established pattern of
 * "the page always renders, the API is what actually enforces access."
 */
export default function PlatformDashboardPage() {
  const router = useRouter();
  const [tenants, setTenants] = useState<PlatformTenantSummaryDto[] | null>(null);
  const [invoices, setInvoices] = useState<PlatformInvoiceDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<RunBillingResponse | null>(null);

  const user = platformAuthClient.getUser();

  async function load() {
    const token = platformAuthClient.getToken();
    if (!token) {
      router.push("/platform/login");
      return;
    }
    try {
      const [tenantList, invoiceList] = await Promise.all([
        platformApiFetch<PlatformTenantSummaryDto[]>("/platform/tenants", { token }),
        platformApiFetch<PlatformInvoiceDto[]>("/platform/billing/invoices", { token }),
      ]);
      setTenants(tenantList);
      setInvoices(invoiceList);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        platformAuthClient.clear();
        router.push("/platform/login");
        return;
      }
      setError(err instanceof ApiError ? err.message : "Failed to load.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runBilling() {
    const token = platformAuthClient.getToken();
    setBusy(true);
    setError(null);
    try {
      const result = await platformApiFetch<RunBillingResponse>("/platform/billing/run", { method: "POST", token });
      setLastRun(result);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Billing run failed.");
    } finally {
      setBusy(false);
    }
  }

  async function markPaid(invoice: PlatformInvoiceDto) {
    const token = platformAuthClient.getToken();
    setBusy(true);
    setError(null);
    try {
      await platformApiFetch(`/platform/billing/invoices/${invoice.id}/mark-paid`, {
        method: "POST",
        token,
        body: { tenantId: invoice.tenantId },
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to mark paid.");
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    platformAuthClient.clear();
    router.push("/platform/login");
  }

  if (!tenants) {
    return <div className="p-6">{error ? <p className="text-red-600">{error}</p> : "Loading..."}</div>;
  }

  return (
    <div className="min-h-screen bg-brand-50">
      <header className="flex items-center justify-between border-b border-brand-600/10 bg-white px-6 py-3">
        <div>
          <span className="text-lg font-semibold">RentOS Platform Admin</span>
          <span className="ml-3 text-sm text-brand-700/60">{user?.displayName ?? user?.email}</span>
        </div>
        <button onClick={logout} className="text-sm text-brand-700/70 hover:text-accent-500">
          Log out
        </button>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 p-6">
        {error && <p className="rounded bg-red-50 p-3 text-sm text-red-600">{error}</p>}

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Tenants</h2>
            <Link href="/platform/tenants/new" className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white">
              + New tenant (self-serve signup)
            </Link>
          </div>
          <table className="w-full border-collapse overflow-hidden rounded-lg border border-brand-600/10 bg-white text-sm">
            <thead className="bg-brand-600/5 text-left">
              <tr>
                <th className="p-3">Slug</th>
                <th className="p-3">Name</th>
                <th className="p-3">Plan</th>
                <th className="p-3">Assets</th>
                <th className="p-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} className="border-t border-brand-600/10">
                  <td className="p-3 font-mono">{t.slug}</td>
                  <td className="p-3">{t.name}</td>
                  <td className="p-3">{t.billingPlan}</td>
                  <td className="p-3">
                    {t.activeAssetCount} / {t.includedAssets} included
                    {t.activeAssetCount > t.includedAssets && (
                      <span className="ml-1 text-accent-500">(+{t.activeAssetCount - t.includedAssets} overage)</span>
                    )}
                  </td>
                  <td className="p-3">{new Date(t.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Billing</h2>
            <button
              onClick={runBilling}
              disabled={busy}
              className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? "Running..." : "Generate this month's invoices"}
            </button>
          </div>
          {lastRun && (
            <p className="mb-3 text-sm text-brand-700/70">
              Last run: {lastRun.results.filter((r) => r.created).length} created,{" "}
              {lastRun.results.filter((r) => !r.created).length} already existed for this period.
            </p>
          )}
          <table className="w-full border-collapse overflow-hidden rounded-lg border border-brand-600/10 bg-white text-sm">
            <thead className="bg-brand-600/5 text-left">
              <tr>
                <th className="p-3">Tenant</th>
                <th className="p-3">Period</th>
                <th className="p-3">Plan</th>
                <th className="p-3">Usage</th>
                <th className="p-3">Total</th>
                <th className="p-3">Status</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {invoices?.map((inv) => (
                <tr key={inv.id} className="border-t border-brand-600/10">
                  <td className="p-3 font-mono">{inv.tenantSlug}</td>
                  <td className="p-3">
                    {inv.periodYear}-{String(inv.periodMonth).padStart(2, "0")}
                  </td>
                  <td className="p-3">{inv.billingPlan}</td>
                  <td className="p-3">
                    {inv.actualAssetCount} / {inv.includedAssets}
                  </td>
                  <td className="p-3">
                    Rp {inv.totalAmount}
                    {inv.overageAmount !== "0.00" && inv.overageAmount !== "0" && (
                      <span className="ml-1 text-xs text-brand-700/60">(+Rp {inv.overageAmount} overage)</span>
                    )}
                  </td>
                  <td className="p-3">{inv.status}</td>
                  <td className="p-3">
                    {inv.status === "ISSUED" && (
                      <button onClick={() => markPaid(inv)} disabled={busy} className="text-accent-500 hover:underline">
                        Mark paid
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {invoices?.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-3 text-center text-brand-700/60">
                    No platform invoices yet — click "Generate this month's invoices" above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}
