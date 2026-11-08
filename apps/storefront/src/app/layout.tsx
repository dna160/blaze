import type { Metadata } from "next";
import type { ReactNode } from "react";
import type { BranchPublicProfile } from "@rentos/contracts";

import { Providers } from "@/components/Providers";
import { apiFetch } from "@/lib/api";
import { resolveTenantSlug } from "@/lib/tenant";

import "./globals.css";

/**
 * The storefront's name comes from the tenant it is serving (PRD go-live G1:
 * production showed a hardcoded demo brand). Falls back to a neutral name when
 * the tenant or the API cannot be resolved, rather than failing the page.
 */
async function brand(): Promise<{ name: string; logo: string | null }> {
  try {
    const tenantSlug = await resolveTenantSlug();
    const profile = await apiFetch<BranchPublicProfile>("/branch/profile", { tenantSlug });
    return { name: profile.name, logo: profile.logoDataUrl ?? null };
  } catch {
    return { name: "Self Storage", logo: null };
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const { name } = await brand();
  return {
    title: name,
    description: "Book self-storage units online — choose your branch, pick a size, confirmation on WhatsApp.",
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { name, logo } = await brand();
  return (
    <html lang="id">
      <body>
        <Providers>
          <header className="border-b border-brand-600/10 bg-white">
            <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
              <a href="/" className="flex items-center gap-3 text-lg font-semibold text-brand-700">
                {logo ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a small inline data: URL, nothing to optimize
                  <img src={logo} alt={name} className="h-9 w-auto" />
                ) : null}
                <span className={logo ? "sr-only sm:not-sr-only sm:text-base" : undefined}>{name}</span>
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
