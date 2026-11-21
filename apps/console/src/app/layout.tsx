import type { Metadata } from "next";
import type { ReactNode } from "react";

import { I18nProvider } from "@/lib/i18n";

import "./globals.css";

// PRD go-live 2 §9.2 — the visible name comes from the organization
// (BrandMark / useConsoleBranding sets the tab title once it is known).
export const metadata: Metadata = {
  title: "City Storage",
  description: "Console",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
