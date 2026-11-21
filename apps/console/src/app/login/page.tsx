"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { BrandMark } from "@/components/BrandMark";
import { apiFetch, ApiError, CHANGE_PASSWORD_PATH } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { LOCALES, useT } from "@/lib/i18n";
import { applySessionLocale, chooseLocale } from "@/lib/locale-preference";

interface LoginResponse {
  accessToken: string;
  user: {
    id: string;
    email: string;
    displayName: string | null;
    organizationId?: string | null;
    roles: string[];
    roleAssignments?: { role: "ADMIN" | "FINANCE" | "SUPERVISOR" | "STAFF"; scope: "ORGANIZATION" | "TENANT"; tenantIds: string[] }[];
    mustChangePassword?: boolean;
    locale?: "id" | "en";
  };
}

export default function LoginPage() {
  const { t, locale } = useT();
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
      applySessionLocale(result.user);
      // PRD go-live 2 §6.1 — an account that must change its password goes there before anything else.
      router.push(result.user.mustChangePassword ? CHANGE_PASSWORD_PATH : "/bookings");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth.loginFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-50">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-xl border border-brand-600/10 bg-white p-8">
        <div className="flex items-start justify-between gap-3">
          <BrandMark size="lg" />
          <div className="flex gap-1" role="group" aria-label={t("common.language")}>
            {LOCALES.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => void chooseLocale(l)}
                aria-pressed={locale === l}
                className={`rounded px-2 py-0.5 text-xs uppercase ${locale === l ? "bg-brand-700 text-white" : "border border-brand-600/15"}`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
        <p className="text-sm text-brand-700/70">{t("auth.loginTitle")}</p>
        <div>
          <label className="block text-sm text-brand-700/70">{t("auth.email")}</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
          />
        </div>
        <div>
          <label className="block text-sm text-brand-700/70">{t("auth.password")}</label>
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
          {busy ? t("auth.signingIn") : t("auth.signIn")}
        </button>
      </form>
    </div>
  );
}
