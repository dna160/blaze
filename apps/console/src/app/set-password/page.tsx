"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { apiFetch, ApiError } from "@/lib/api";

/**
 * PRD go-live §4.4 — a new staff member's single-use "set your password" link
 * (from the user CSV import). Public by design: there is no session yet. The
 * token in the URL is the only credential; the API stores only its hash and
 * refuses it once used or after 72 hours.
 */
function SetPasswordForm() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ email: string } | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 10) return setError("Use at least 10 characters.");
    if (password !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    try {
      const result = await apiFetch<{ email: string; branchSlug: string | null }>("/auth/staff/set-password", {
        method: "POST",
        body: { token, password },
      });
      setDone({ email: result.email });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not set the password.");
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return <p className="text-sm text-red-600">This link is incomplete. Open the full link from your invitation, or ask your administrator for a new one.</p>;
  }

  if (done) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-green-700">
          Password set for <b>{done.email}</b>. You can now sign in.
        </p>
        <Link href="/login" className="inline-block rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white">
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block text-sm">
        <span className="text-brand-700/80">New password</span>
        <input
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
        />
      </label>
      <label className="block text-sm">
        <span className="text-brand-700/80">Repeat it</span>
        <input
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
        />
      </label>
      <p className="text-xs text-brand-700/60">At least 10 characters. This link works once.</p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button disabled={busy} className="w-full rounded bg-brand-700 px-4 py-2 font-medium text-white disabled:opacity-50">
        {busy ? "Saving…" : "Set password"}
      </button>
    </form>
  );
}

export default function SetPasswordPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-brand-600/10 bg-white p-6">
        <h1 className="mb-1 text-xl font-semibold">Set your password</h1>
        <p className="mb-5 text-sm text-brand-700/60">RentOS Console</p>
        <Suspense fallback={<p className="text-sm">Loading…</p>}>
          <SetPasswordForm />
        </Suspense>
      </div>
    </main>
  );
}
