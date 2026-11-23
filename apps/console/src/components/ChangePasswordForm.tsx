"use client";

import { useState } from "react";

import { PasswordRules, passwordFormProblem } from "@/components/PasswordRules";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient, type StaffSessionUser } from "@/lib/auth-client";
import { useT } from "@/lib/i18n";

/** PRD go-live 2 §6.1 — the change-my-password form, used by the forced-change page and by user settings. */
interface SessionResponse {
  accessToken: string;
  user: StaffSessionUser;
}

export function ChangePasswordForm({ user, forced, onChanged }: { user: StaffSessionUser; forced: boolean; onChanged: () => void }) {
  const { t } = useT();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const identity = { email: user.email, displayName: user.displayName };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    const problem = passwordFormProblem(password, confirm, identity);
    if (problem) return setError(problem);
    if (password === current) return setError(t("password.problemSameAsCurrent"));
    setBusy(true);
    try {
      const result = await apiFetch<SessionResponse>("/auth/staff/change-password", {
        method: "POST",
        token: authClient.getToken(),
        body: { currentPassword: current, newPassword: password },
      });
      authClient.setSession(result.accessToken, result.user);
      setCurrent("");
      setPassword("");
      setConfirm("");
      setDone(true);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("password.changeFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" data-testid="change-password-form">
      <label className="block text-sm">
        <span className="text-brand-700/80">{t("password.current")}</span>
        <input
          type="password"
          name="current-password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
        />
      </label>
      <label className="block text-sm">
        <span className="text-brand-700/80">{t("password.new")}</span>
        <input
          type="password"
          name="new-password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
        />
      </label>
      <label className="block text-sm">
        <span className="text-brand-700/80">{t("password.repeatNew")}</span>
        <input
          type="password"
          name="confirm-password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
        />
      </label>
      <PasswordRules password={password} confirm={confirm} identity={identity} />
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {done && !forced && (
        <p role="status" className="text-sm text-green-700">
          {t("password.changedOk")}
        </p>
      )}
      <button disabled={busy} className="w-full rounded bg-brand-700 px-4 py-2 font-medium text-white disabled:opacity-50">
        {busy ? t("common.saving") : t("password.changeButton")}
      </button>
    </form>
  );
}

