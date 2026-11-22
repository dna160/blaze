"use client";

import { checkPasswordPolicy, PASSWORD_MIN_LENGTH, type PasswordIdentity } from "@rentos/contracts";

import { tr, useT } from "@/lib/i18n";

/**
 * PRD go-live 2 §6.1 — the password policy as a live checklist, from the same
 * `checkPasswordPolicy` the API enforces. Used by Change password and by the
 * set-password link page, so both say the same thing before the request goes.
 */
export function passwordFormProblem(password: string, confirm: string, identity: PasswordIdentity = {}): string | null {
  if (checkPasswordPolicy(password, identity).length > 0) return tr("password.problemPolicy");
  if (password !== confirm) return tr("password.problemMismatch");
  return null;
}

export function PasswordRules({ password, confirm, identity = {} }: { password: string; confirm: string; identity?: PasswordIdentity }) {
  const { t } = useT();
  const problems = checkPasswordPolicy(password, identity);
  const typed = password.length > 0;
  const rules: Array<{ ok: boolean; label: string }> = [
    { ok: typed && !problems.includes("TOO_SHORT") && !problems.includes("TOO_LONG"), label: t("password.rules.minLength", { min: PASSWORD_MIN_LENGTH }) },
    { ok: typed && !problems.includes("SAME_AS_IDENTITY"), label: t("password.rules.notIdentity") },
    { ok: typed && !problems.includes("TOO_COMMON"), label: t("password.rules.notCommon") },
    { ok: typed && password === confirm, label: t("password.rules.typedTwice") },
  ];
  return (
    <ul className="space-y-1 text-xs" aria-label={t("password.rules.listLabel")}>
      {rules.map((r) => (
        <li key={r.label} className={r.ok ? "text-green-700" : "text-brand-700/60"}>
          <span aria-hidden className="mr-1.5 inline-block w-3 text-center">
            {r.ok ? "✓" : "•"}
          </span>
          {r.label}
          <span className="sr-only">{r.ok ? t("password.rules.met") : t("password.rules.notMet")}</span>
        </li>
      ))}
    </ul>
  );
}
