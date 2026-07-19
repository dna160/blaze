"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PlatformSignupResponse } from "@rentos/contracts";

import { ApiError } from "@/lib/api";
import { platformApiFetch } from "@/lib/platform-api";

/**
 * The actual self-serve tenant signup entry point (PRD Phase 4) —
 * `POST /platform/signup` is a genuinely public, unauthenticated
 * endpoint (see apps/api/src/platform/platform.controller.ts). This
 * page is reached from the platform-admin dashboard for demo
 * convenience, but nothing about the form or the request it makes
 * requires being logged in as a platform admin — a real deployment
 * could expose this same form/endpoint on a public marketing site.
 */
export default function NewTenantSignupPage() {
  const router = useRouter();
  const [companyName, setCompanyName] = useState("");
  const [slug, setSlug] = useState("");
  const [isPkp, setIsPkp] = useState(false);
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PlatformSignupResponse | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await platformApiFetch<PlatformSignupResponse>("/platform/signup", {
        method: "POST",
        body: { companyName, slug, isPkp, adminName, adminEmail, password },
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Signup failed.");
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="mx-auto max-w-lg space-y-4 p-8">
        <h1 className="text-xl font-semibold">Tenant created</h1>
        <p className="rounded bg-green-50 p-4 text-sm text-green-800">{result.message}</p>
        <button onClick={() => router.push("/platform")} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white">
          Back to dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 p-8">
      <h1 className="text-xl font-semibold">New tenant — self-serve signup</h1>
      <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-brand-600/10 bg-white p-6">
        <div>
          <label className="block text-sm text-brand-700/70">Company name</label>
          <input
            required
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
          />
        </div>
        <div>
          <label className="block text-sm text-brand-700/70">Slug (lowercase, hyphens)</label>
          <input
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2 font-mono"
          />
        </div>
        <p className="text-xs text-brand-700/50">
          After signing in as this tenant's admin, use Catalog Setup to create AssetTypes for whichever vertical this
          business is (self-storage, homestay, equipment rental, ...) — signup itself doesn't need to know that yet.
        </p>
        <label className="flex items-center gap-2 text-sm text-brand-700/70">
          <input type="checkbox" checked={isPkp} onChange={(e) => setIsPkp(e.target.checked)} />
          PKP-registered (charges PPN)
        </label>
        <div>
          <label className="block text-sm text-brand-700/70">Admin name</label>
          <input
            required
            value={adminName}
            onChange={(e) => setAdminName(e.target.value)}
            className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
          />
        </div>
        <div>
          <label className="block text-sm text-brand-700/70">Admin email</label>
          <input
            type="email"
            required
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
            className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
          />
        </div>
        <div>
          <label className="block text-sm text-brand-700/70">Password</label>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button disabled={busy} className="w-full rounded bg-brand-700 py-2 font-medium text-white disabled:opacity-50">
          {busy ? "Creating..." : "Create tenant"}
        </button>
      </form>
    </div>
  );
}
