import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";

import { I18nProvider } from "@/lib/i18n";

import "./globals.css";

// PRD go-live 2 §9.2 — the visible name comes from the organization
// (BrandMark / useConsoleBranding sets the tab title once it is known).
export const metadata: Metadata = {
  title: "City Storage",
  description: "Console",
};

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
