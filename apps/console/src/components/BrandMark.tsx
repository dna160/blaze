"use client";

import { useConsoleBranding } from "@/lib/branding";

/** PRD go-live 2 §9.2 — the organization's logo and console name (sidebar, sign-in, set-password). */
export function BrandMark({ size = "md" }: { size?: "md" | "lg" }) {
  const b = useConsoleBranding();
  return (
    <div className="flex items-center gap-2" data-testid="brand-mark">
      {b.logoDataUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- a data: URL from the branch profile
        <img src={b.logoDataUrl} alt={b.consoleName} className={size === "lg" ? "h-10 w-auto" : "h-7 w-auto"} />
      )}
      <span className={size === "lg" ? "text-xl font-semibold" : "text-lg font-semibold"}>{b.consoleName}</span>
    </div>
  );
}
