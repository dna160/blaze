"use client";

import { apiFetch } from "@/lib/api";
import { authClient, type StaffSessionUser } from "@/lib/auth-client";
import { announceLocale, normalizeLocale, type Locale } from "@/lib/i18n";

/**
 * PRD go-live 2 §9.1 — the language is the account's choice (`User.locale`):
 * switching saves it through PATCH /auth/staff/me, so the next sign-in, on any
 * browser, opens in the same language. Without a session (sign-in page) it is
 * only remembered in this browser.
 */
export async function chooseLocale(locale: Locale): Promise<void> {
  announceLocale(locale);
  const token = authClient.getToken();
  const user = authClient.getUser();
  if (user && token) authClient.setSession(token, { ...user, locale });
  if (!token) return;
  try {
    await apiFetch("/auth/staff/me", { token, method: "PATCH", body: { locale } });
  } catch {
    /* shown in this browser regardless; saved to the account next time */
  }
}

/** At sign-in: the account's saved language wins over this browser's. */
export function applySessionLocale(user: Pick<StaffSessionUser, "locale"> | null | undefined): void {
  if (user?.locale) announceLocale(normalizeLocale(user.locale));
}
