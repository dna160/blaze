/**
 * PRD go-live 2 §6.1 — the ONE staff password policy, used by change-password,
 * the set-password link and admin reset (API), and by the console forms for
 * the same hints before the request is sent.
 *
 * Deliberately short: a minimum length, "not your own name or email", and a
 * small list of passwords everyone tries first. No composition rules (a long
 * passphrase is better than `P@ssw0rd1!`, which they push people towards).
 *
 * Pure: no I/O, no framework.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

export type PasswordPolicyCode = "TOO_SHORT" | "TOO_LONG" | "SAME_AS_IDENTITY" | "TOO_COMMON" | "SAME_AS_CURRENT";

/** Indonesian first (the console's default language), English second. */
export const PASSWORD_POLICY_MESSAGES: Readonly<Record<PasswordPolicyCode, { id: string; en: string }>> = {
  TOO_SHORT: { id: `Kata sandi minimal ${PASSWORD_MIN_LENGTH} karakter.`, en: `Use at least ${PASSWORD_MIN_LENGTH} characters.` },
  TOO_LONG: { id: `Kata sandi maksimal ${PASSWORD_MAX_LENGTH} karakter.`, en: `Use at most ${PASSWORD_MAX_LENGTH} characters.` },
  SAME_AS_IDENTITY: { id: "Kata sandi tidak boleh sama dengan email atau nama Anda.", en: "The password must not be your email or your name." },
  TOO_COMMON: { id: "Kata sandi ini terlalu umum dan mudah ditebak. Pilih yang lain.", en: "This password is too common and easy to guess. Choose another." },
  SAME_AS_CURRENT: { id: "Kata sandi baru harus berbeda dari kata sandi saat ini.", en: "The new password must differ from the current one." },
};

/**
 * Passwords people reach for first, plus the root of the demo seed's shared
 * password (it is written in this repository, so it must never be accepted for
 * a real account). Compared case-insensitively, and also with trailing digits
 * and punctuation stripped ("password2026!" -> "password"), which is why short
 * roots are worth listing even though the minimum length is 10.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "password",
  "passw0rd",
  "p@ssw0rd",
  "p@ssword",
  "katasandi",
  "sandi",
  "rahasia",
  "admin",
  "administrator",
  "superadmin",
  "welcome",
  "selamatdatang",
  "letmein",
  "changeme",
  "qwerty",
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
  "iloveyou",
  "indonesia",
  "jakarta",
  "bismillah",
  "sayang",
  "citystorage",
  "kebonjeruk",
  "gudangaman",
  "rentos",
  "storage",
  "rentos!demo",
  "abcdefghij",
  "abc",
  "1q2w3e4r5t",
  "1qaz2wsx3edc",
  "q1w2e3r4t5",
]);

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

/** "password2026!" -> "password": the root with trailing digits / punctuation removed. */
function root(value: string): string {
  return value.replace(/[\d\W_]+$/u, "");
}

export interface PasswordIdentity {
  email?: string | null;
  displayName?: string | null;
}

/**
 * Every rule the password breaks, in a stable order; an empty array means it
 * is acceptable. `SAME_AS_CURRENT` is never returned here — only the server can
 * compare against the stored hash.
 */
export function checkPasswordPolicy(password: string, identity: PasswordIdentity = {}): PasswordPolicyCode[] {
  const problems: PasswordPolicyCode[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push("TOO_SHORT");
  if (password.length > PASSWORD_MAX_LENGTH) problems.push("TOO_LONG");

  const p = normalise(password);
  const squeezed = p.replace(/\s+/g, "");
  const email = normalise(identity.email ?? "");
  const name = normalise(identity.displayName ?? "");
  const identities = [email, email.split("@")[0] ?? "", name, name.replace(/\s+/g, "")].filter((v) => v.length > 0);
  if (identities.some((v) => v === p || v === squeezed)) problems.push("SAME_AS_IDENTITY");

  // One character repeated, or nothing but digits in a straight run — however long.
  const trivial = /^(.)\1+$/u.test(squeezed) || (/^\d+$/.test(squeezed) && ("0123456789".repeat(3).includes(squeezed) || "9876543210".repeat(3).includes(squeezed)));
  const candidates = [p, squeezed, root(p), root(squeezed)];
  if (trivial || candidates.some((c) => c.length > 0 && COMMON_PASSWORDS.has(c))) problems.push("TOO_COMMON");
  return problems;
}

/** The first broken rule as one bilingual line, or null when the password passes. */
export function passwordPolicyError(password: string, identity: PasswordIdentity = {}): string | null {
  const [first] = checkPasswordPolicy(password, identity);
  if (!first) return null;
  const m = PASSWORD_POLICY_MESSAGES[first];
  return `${m.id} / ${m.en}`;
}
