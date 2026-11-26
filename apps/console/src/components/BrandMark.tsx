"use client";

import { useConsoleBranding } from "@/lib/branding";

/**
 * PRD go-live 2 §9.2 — the organization's brand (sidebar, sign-in, set-password).
 * The logo already carries the name, so when there is a logo it stands alone
 * (the name stays as its alt text); the name is written out only when the
 * organization has no logo.
 */
export function BrandMark({ size = "md" }: { size?: "md" | "lg" }) {
  const b = useConsoleBranding();
  return (
    <div className="flex items-center" data-testid="brand-mark">
      {b.logoDataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a data: URL from the branch profile
        <img src={b.logoDataUrl} alt={b.consoleName} className={size === "lg" ? "h-14 w-auto" : "h-9 w-auto"} />
      ) : (
        <span className={size === "lg" ? "text-xl font-semibold" : "text-lg font-semibold"}>{b.consoleName}</span>
      )}
    </div>
  );
}
