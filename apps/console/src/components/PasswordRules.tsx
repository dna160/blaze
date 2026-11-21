"use client";

import { checkPasswordPolicy, PASSWORD_MIN_LENGTH, type PasswordIdentity } from "@rentos/contracts";

/**
 * PRD go-live 2 §6.1 — the password policy as a live checklist, from the same
 * `checkPasswordPolicy` the API enforces. Used by Change password and by the
 * set-password link page, so both say the same thing before the request goes.
 */
export function passwordFormProblem(password: string, confirm: string, identity: PasswordIdentity = {}): string | null {
  if (checkPasswordPolicy(password, identity).length > 0) return "Kata sandi baru belum memenuhi syarat di bawah.";
  if (password !== confirm) return "Kedua kata sandi tidak sama.";
  return null;
}

export function PasswordRules({ password, confirm, identity = {} }: { password: string; confirm: string; identity?: PasswordIdentity }) {
  const problems = checkPasswordPolicy(password, identity);
  const typed = password.length > 0;
  const rules: Array<{ ok: boolean; label: string }> = [
    { ok: typed && !problems.includes("TOO_SHORT") && !problems.includes("TOO_LONG"), label: `Minimal ${PASSWORD_MIN_LENGTH} karakter` },
    { ok: typed && !problems.includes("SAME_AS_IDENTITY"), label: "Bukan email atau nama Anda" },
    { ok: typed && !problems.includes("TOO_COMMON"), label: "Bukan kata sandi yang umum dan mudah ditebak" },
    { ok: typed && password === confirm, label: "Diketik dua kali dengan sama" },
  ];
  return (
    <ul className="space-y-1 text-xs" aria-label="Syarat kata sandi">
      {rules.map((r) => (
        <li key={r.label} className={r.ok ? "text-green-700" : "text-brand-700/60"}>
          <span aria-hidden className="mr-1.5 inline-block w-3 text-center">
            {r.ok ? "✓" : "•"}
          </span>
          {r.label}
          <span className="sr-only">{r.ok ? " — terpenuhi" : " — belum terpenuhi"}</span>
        </li>
      ))}
    </ul>
  );
}
