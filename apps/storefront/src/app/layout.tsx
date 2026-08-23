import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Providers } from "@/components/Providers";

import "./globals.css";

export const metadata: Metadata = {
  title: "Gudang Aman Storage — RentOS",
  description: "Book self-storage units online — choose your branch, pick a size, confirmation on WhatsApp.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>
        <Providers>
          <header className="border-b border-brand-600/10 bg-white">
            <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
              <a href="/" className="text-lg font-semibold text-brand-700">
                Gudang Aman Storage
              </a>
              <nav className="flex gap-4 text-sm">
                <a href="/portal" className="hover:text-accent-500">
                  My Account
                </a>
                <a href="/login" className="hover:text-accent-500">
                  Login
                </a>
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
          <footer className="mt-16 border-t border-brand-600/10 py-8 text-center text-xs text-brand-700/60">
            Powered by RentOS
          </footer>
        </Providers>
      </body>
    </html>
  );
}
