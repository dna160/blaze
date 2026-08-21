"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

interface LoginResponse {
  accessToken: string;
  user: {
    id: string;
    email: string;
    displayName: string | null;
    organizationId?: string | null;
    roles: string[];
    roleAssignments?: { role: "ADMIN" | "FINANCE" | "SUPERVISOR" | "STAFF"; scope: "ORGANIZATION" | "TENANT"; tenantIds: string[] }[];
  };
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<LoginResponse>("/auth/console/login", { method: "POST", body: { email, password } });
      authClient.setSession(result.accessToken, result.user);
      router.push("/bookings");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-50">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-xl border border-brand-600/10 bg-white p-8">
        <h1 className="text-xl font-semibold">RentOS Console</h1>
        <div>
          <label className="block text-sm text-brand-700/70">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
          />
        </div>
        <div>
          <label className="block text-sm text-brand-700/70">Password</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button disabled={busy} className="w-full rounded bg-brand-700 py-2 font-medium text-white disabled:opacity-50">
          {busy ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
