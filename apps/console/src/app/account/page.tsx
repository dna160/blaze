"use client";

import { staffRoleLabel } from "@rentos/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { ConsoleShell } from "@/components/ConsoleShell";
import { SESSION_CHANGED_EVENT } from "@/components/UserMenu";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient, type StaffSessionUser } from "@/lib/auth-client";
import { LOCALES, useT } from "@/lib/i18n";
import { initials } from "@/lib/initials";
import { chooseLocale } from "@/lib/locale-preference";

/**
 * User settings — the person's own account: the name staff see (and the
 * initials in the badge), the console language, and the password. Every
 * signed-in staff member reaches it from the badge in the top bar.
 */
export default function UserSettingsPage() {
  const { t, locale } = useT();
  const router = useRouter();
  // The session lives in localStorage, which the server render cannot see.
  const [user, setUser] = useState<StaffSessionUser | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = authClient.getToken();
    const stored = authClient.getUser();
    if (!token || !stored) {
      router.replace("/login");
      return;
    }
    setUser(stored);
    setName(stored.displayName ?? "");
    apiFetch<{ user: StaffSessionUser }>("/auth/staff/me", { token })
      .then((me) => {
        const fresh = { ...stored, ...me.user };
        authClient.setSession(token, fresh);
        setUser(fresh);
        setName(fresh.displayName ?? "");
      })
      .catch(() => {
        /* keep the stored copy */
      });
  }, [router]);

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    const token = authClient.getToken();
    if (!user || !token) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const me = await apiFetch<{ user: StaffSessionUser }>("/auth/staff/me", { token, method: "PATCH", body: { displayName: name.trim() } });
      const fresh = { ...user, ...me.user };
      authClient.setSession(token, fresh);
      setUser(fresh);
      setSaved(true);
      window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("account.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (!user) return null;
  const roles = [...new Set((user.roleAssignments ?? []).map((r) => staffRoleLabel(r.role, r.scope)))];
  const nameOk = name.trim().length >= 2 && name.trim() !== (user.displayName ?? "");

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">{t("account.title")}</h1>
      <p className="mt-1 text-sm text-brand-700/60">{t("account.intro")}</p>

      <div className="mt-6 grid max-w-3xl gap-6">
        <section className="rounded-lg border border-brand-600/10 bg-white p-6">
          <h2 className="text-lg font-semibold">{t("account.profile")}</h2>
          <div className="mt-4 flex items-center gap-4">
            <span aria-hidden className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-700 text-lg font-semibold text-white">
              {initials(name || user.displayName, user.email)}
            </span>
            <div className="text-sm">
              <p className="text-brand-700/60">{t("account.email")}</p>
              <p className="font-medium">{user.email}</p>
              {roles.length > 0 && (
                <>
                  <p className="mt-2 text-brand-700/60">{t("account.role")}</p>
                  <p className="font-medium">{roles.join(", ")}</p>
                </>
              )}
            </div>
          </div>
          <form onSubmit={saveName} className="mt-5 flex flex-wrap items-end gap-3">
            <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm">
              <span className="text-brand-700/70">{t("account.displayName")}</span>
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setSaved(false);
                }}
                maxLength={80}
                className="rounded border border-brand-600/20 px-3 py-2"
              />
            </label>
            <button type="submit" disabled={!nameOk || saving} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
              {saving ? t("account.saving") : t("account.saveName")}
            </button>
          </form>
          <p className="mt-2 text-xs text-brand-700/60">{t("account.nameHint")}</p>
          {saved && <p className="mt-2 text-sm text-green-700">{t("account.saved")}</p>}
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </section>

        <section className="rounded-lg border border-brand-600/10 bg-white p-6">
          <h2 className="text-lg font-semibold">{t("nav.menu.language")}</h2>
          <p className="mt-1 text-sm text-brand-700/60">{t("account.languageHint")}</p>
          <div className="mt-3 flex gap-2" role="group" aria-label={t("nav.menu.language")}>
            {LOCALES.map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={locale === l}
                data-testid={`locale-${l}`}
                onClick={() => void chooseLocale(l)}
                className={`rounded px-3 py-1.5 text-sm ${locale === l ? "bg-brand-700 text-white" : "border border-brand-600/15 hover:bg-brand-700/5"}`}
              >
                {l === "id" ? t("common.languageId") : t("common.languageEn")}
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-brand-600/10 bg-white p-6">
          <h2 className="text-lg font-semibold">{t("nav.menu.changePassword")}</h2>
          <p className="mb-4 mt-1 text-sm text-brand-700/60">{t("account.passwordHint")}</p>
          <div className="max-w-md">
            <ChangePasswordForm user={user} forced={false} onChanged={() => setUser(authClient.getUser())} />
          </div>
        </section>
      </div>
    </ConsoleShell>
  );
}
