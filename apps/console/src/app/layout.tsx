import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";

import { I18nProvider } from "@/lib/i18n";

import "./globals.css";

// PRD go-live 2 §9.2 — the visible name (and so the tab title) comes from the
// organization via the public GET /branch/branding; "City Storage" when the API
// cannot be reached from the server.
const DEFAULT_TITLE = "City Storage";

export async function generateMetadata(): Promise<Metadata> {
  const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";
  const slug = process.env.NEXT_PUBLIC_TENANT_SLUG ?? "";
  let title = DEFAULT_TITLE;
  try {
    const res = await fetch(`${api}/branch/branding`, {
      headers: { "X-Tenant-Slug": slug },
      // Not cached: Next re-applies this title after the client sets one, so a
      // stale copy would undo a rename. One small public read per page load.
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const body = (await res.json()) as { consoleName?: unknown };
      if (typeof body.consoleName === "string" && body.consoleName.trim()) title = body.consoleName.trim();
    }
  } catch {
    /* keep the default */
  }
  return { title, description: "Console" };
}

// Written by lib/i18n.tsx next to localStorage; read here so the server render
// is already in the reader's language (PRD go-live 2 §9.1, Indonesian default).
const LOCALE_COOKIE = "rentos_console_locale";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = (await cookies()).get(LOCALE_COOKIE)?.value === "en" ? "en" : "id";
  return (
    <html lang={locale}>
      <body>
        <I18nProvider initialLocale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
