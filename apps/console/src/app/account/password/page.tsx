"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ConsoleShell } from "@/components/ConsoleShell";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient, type StaffSessionUser } from "@/lib/auth-client";
import { useT } from "@/lib/i18n";

/**
 * PRD go-live 2 §6.1 — Change my password.
 *
 * Two ways in:
 *  - from the user menu, any time (inside the console shell);
 *  - FORCED: the account must change its password before anything else — it
 *    was created with a password someone else typed, or an operator reset it.
 *    Then this page stands alone (no navigation: the API refuses every other
 *    call for this session anyway) and success continues into the console.
 *
 * The API wants the current password, applies the policy, and answers with a
 * fresh token; every other session of the account is signed out.
 */

export default function ChangePasswordPage() {
  const { t } = useT();
  const router = useRouter();
  // The session lives in localStorage, which the server render cannot see.
  const [user, setUser] = useState<StaffSessionUser | null>(null);

  useEffect(() => {
    const token = authClient.getToken();
    const stored = authClient.getUser();
    if (!token || !stored) {
      router.replace("/login");
      return;
    }
    setUser(stored);
    // The stored copy can be stale (the flag is set server-side, e.g. by a
    // release or an operator); ask the API how the account stands now.
    apiFetch<{ user: StaffSessionUser }>("/auth/staff/me", { token })
      .then((me) => {
        const fresh = { ...stored, ...me.user };
        authClient.setSession(token, fresh);
        setUser(fresh);
      })
      .catch(() => {
        /* a dead session is sent to /login by apiFetch; anything else: keep the stored copy */
      });
  }, [router]);

  if (!user) return null;

  if (user.mustChangePassword) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-brand-50 p-6">
        <div className="w-full max-w-md rounded-xl border border-brand-600/10 bg-white p-8">
          <h1 className="text-xl font-semibold">{t("password.forcedTitle")}</h1>
          <p className="mb-5 mt-2 text-sm text-brand-700/70">{t("password.forcedBody", { email: user.email })}</p>
          <ChangePasswordForm user={user} forced onChanged={() => router.replace("/bookings")} />
          <button
            type="button"
            onClick={() => {
              authClient.clear();
              router.replace("/login");
            }}
            className="mt-4 w-full text-center text-sm text-brand-700/60 hover:text-accent-500"
          >
            {t("nav.menu.logout")}
          </button>
        </div>
      </main>
    );
  }

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">{t("password.pageTitle")}</h1>
      <p className="mt-1 text-sm text-brand-700/60">{t("password.pageIntro", { email: user.email })}</p>
      <div className="mt-6 max-w-md rounded-lg border border-brand-600/10 bg-white p-6">
        <ChangePasswordForm user={user} forced={false} onChanged={() => setUser(authClient.getUser())} />
      </div>
    </ConsoleShell>
  );
}
