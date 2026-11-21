"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import en from "../../messages/en.json";
import id from "../../messages/id.json";

/**
 * PRD go-live 2 §9.1 — the console's language layer.
 *
 * Deliberately dependency-free rather than next-intl: the console is a set of
 * client components behind a localStorage session (no server-side locale
 * routing, no `[locale]` segment to add), so what it needs is a dictionary, a
 * `t()` with `{placeholders}` and an English plural, and a per-user choice.
 * All text lives in `messages/id.json` (the default — the file City Storage
 * reviews) and `messages/en.json`, nested by page; `pnpm --filter
 * @rentos/console test` fails when a page carries text that is not in them, or
 * when the two files drift apart.
 *
 * The choice: `User.locale` (saved through PATCH /auth/staff/me, returned at
 * login), mirrored in localStorage so the sign-in page of the next visit is
 * already in that language. Before anyone has signed in it is Indonesian.
 */

export type Locale = "id" | "en";
export const LOCALES: readonly Locale[] = ["id", "en"];
export const DEFAULT_LOCALE: Locale = "id";
const STORAGE_KEY = "rentos_console_locale";

type Dict = { [key: string]: string | Dict };
const DICTS: Record<Locale, Dict> = { id: id as Dict, en: en as Dict };

export type Vars = Record<string, string | number | null | undefined>;

function lookup(dict: Dict, key: string): string | undefined {
  let node: string | Dict | undefined = dict;
  for (const part of key.split(".")) {
    if (!node || typeof node === "string") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (vars[name] === undefined || vars[name] === null ? m : String(vars[name])));
}

/**
 * `key` in `locale`, falling back to Indonesian, then to the key itself (so a
 * missing entry is visible, never blank). With `vars.count`, `key_one` is used
 * for exactly one when it exists — English needs it, Indonesian does not.
 */
export function translate(locale: Locale, key: string, vars?: Vars): string {
  const count = vars?.count;
  const candidates = typeof count === "number" && count === 1 ? [`${key}_one`, key] : [key];
  for (const dict of [DICTS[locale], DICTS[DEFAULT_LOCALE]]) {
    for (const k of candidates) {
      const hit = lookup(dict, k);
      if (hit !== undefined) return interpolate(hit, vars);
    }
  }
  return key;
}

export function hasMessage(key: string): boolean {
  return lookup(DICTS[DEFAULT_LOCALE], key) !== undefined;
}

export function normalizeLocale(value: unknown): Locale {
  return value === "en" ? "en" : "id";
}

export function storedLocale(): Locale | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v ? normalizeLocale(v) : null;
  } catch {
    return null;
  }
}

function storeLocale(locale: Locale) {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* not remembered; the account's saved choice still applies at next login */
  }
}

/** The locale outside React (toasts built in plain functions); kept in step by the provider. */
let currentLocale: Locale = DEFAULT_LOCALE;
export function getLocale(): Locale {
  return currentLocale;
}
/** `t()` for code outside a component. */
export function tr(key: string, vars?: Vars): string {
  return translate(currentLocale, key, vars);
}

/**
 * A status / role / enum value as words: `status.<VALUE>` in the dictionary,
 * else the value made readable (PENDING_APPROVAL -> "Pending approval") so a
 * value the console has not met yet still shows sensibly.
 */
export function statusLabel(locale: Locale, value: string | null | undefined): string {
  if (!value) return "—";
  const key = `status.${value}`;
  const hit = lookup(DICTS[locale], key) ?? lookup(DICTS[DEFAULT_LOCALE], key);
  if (hit !== undefined) return hit;
  const words = value.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, vars?: Vars) => string;
  /** An enum value (booking/invoice/deposit/KYC/... status, role) in the reader's language. */
  s: (value: string | null | undefined) => string;
  /** The locale tag for Intl formatting ("id-ID" / "en-GB"). */
  intl: string;
}

const I18nContext = createContext<I18nValue | null>(null);

/** Listeners outside the provider (e.g. the session code) can ask for a switch. */
const LOCALE_EVENT = "rentos:locale";
export function announceLocale(locale: Locale) {
  storeLocale(locale);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(LOCALE_EVENT, { detail: locale }));
}

export function I18nProvider({ children }: { children: ReactNode }) {
  // The server render (and the first client render) is Indonesian; the saved
  // choice is applied after mount, so hydration matches.
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    const saved = storedLocale();
    if (saved) setLocaleState(saved);
    const onAnnounce = (e: Event) => setLocaleState(normalizeLocale((e as CustomEvent).detail));
    window.addEventListener(LOCALE_EVENT, onAnnounce);
    return () => window.removeEventListener(LOCALE_EVENT, onAnnounce);
  }, []);

  useEffect(() => {
    currentLocale = locale;
    if (typeof document !== "undefined") document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    storeLocale(next);
    setLocaleState(next);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      t: (key, vars) => translate(locale, key, vars),
      s: (v) => statusLabel(locale, v),
      intl: locale === "en" ? "en-GB" : "id-ID",
    }),
    [locale, setLocale],
  );
  currentLocale = locale;
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** `const { t, s, locale } = useT();` */
export function useT(): I18nValue {
  const ctx = useContext(I18nContext);
  if (ctx) return ctx;
  // Outside the provider (a unit-rendered component): Indonesian, read-only.
  return {
    locale: DEFAULT_LOCALE,
    setLocale: () => undefined,
    t: (key, vars) => translate(DEFAULT_LOCALE, key, vars),
    s: (v) => statusLabel(DEFAULT_LOCALE, v),
    intl: "id-ID",
  };
}
