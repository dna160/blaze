import type { BranchPublicProfile } from "@rentos/contracts";

/**
 * PRD go-live §5.1 — the branch profile (contacts, address, hours,
 * facilities, bank accounts) from GET /branch/profile. Public, so both server
 * and client components fetch it with the tenant slug alone.
 */

/** wa.me link for an E.164 number ("+628111877838"), optionally with a prefilled message. */
export function waLink(whatsapp: string | null | undefined, text?: string): string | null {
  const digits = (whatsapp ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

export function hoursLine(hours: BranchPublicProfile["operatingHours"]): string | null {
  if (!hours.open || !hours.close) return hours.days ?? null;
  return `${hours.days ? `${hours.days}, ` : ""}${hours.open}–${hours.close}${hours.tz ? ` ${hours.tz}` : ""}`;
}
