/**
 * PRD go-live 2 §5.3 — the two ways a rental agreement is signed, as rules.
 *
 * ONLINE   the customer signs on the portal: through the e-sign provider
 *          (Privy) once one is configured, on the signature pad until then.
 * OFFLINE  on paper (materai) at the office; staff scan and upload it, before
 *          a deadline after which the booking lapses.
 *
 * Pure, so the one rule that must never break is unit-tested rather than
 * implied by a call graph: UPLOADING A SIGNED SCAN NEVER SENDS ANYTHING TO AN
 * E-SIGN PROVIDER. (Before this, every upload went through
 * `esign.sendForSignature`, which under the mock provider "signed" instantly —
 * and under a real one would have mailed a wet-signed scan out for e-signature.)
 */

export type SignMethod = "ONLINE" | "OFFLINE";

/** What someone is trying to do to an unsigned contract. */
export type SigningAction = "SIGNATURE_PAD" | "ESIGN" | "UPLOAD_SCAN";

export interface SigningContext {
  signMethod: SignMethod;
  actor: "CUSTOMER" | "STAFF";
  /** A real e-sign provider is configured for this deployment (not the mock). */
  esignConfigured: boolean;
  alreadySigned: boolean;
  /** Sent to the e-sign provider and not finished yet. */
  esignPending: boolean;
}

export interface SigningDecision {
  allowed: boolean;
  /** Bilingual, shown to whoever tried. Present when not allowed. */
  reason?: string;
  /** True only for the one action that hands the document to the e-sign provider. */
  sendsToEsignProvider: boolean;
}

const no = (reason: string): SigningDecision => ({ allowed: false, reason, sendsToEsignProvider: false });

export function decideSigning(action: SigningAction, ctx: SigningContext): SigningDecision {
  if (ctx.alreadySigned) return no("Kontrak ini sudah ditandatangani. / This contract is already signed.");
  if (ctx.esignPending) {
    return no("Kontrak ini sedang menunggu tanda tangan elektronik. / This contract is waiting for its e-signature to complete.");
  }

  switch (action) {
    case "UPLOAD_SCAN":
      // A scan of a paper contract is recorded by staff, as it is — never forwarded anywhere.
      if (ctx.actor !== "STAFF") {
        return no("Kontrak ditandatangani di halaman kontrak atau di kantor kami — unggah dokumen dilakukan oleh staf. / Sign on the contract page or at our office; staff upload paper contracts.");
      }
      return { allowed: true, sendsToEsignProvider: false };

    case "SIGNATURE_PAD":
      // Staff may always use the pad with the customer in front of them.
      if (ctx.actor === "STAFF") return { allowed: true, sendsToEsignProvider: false };
      if (ctx.signMethod === "OFFLINE") {
        return no("Kontrak ini ditandatangani di kantor kami. / This contract is signed on paper at our office.");
      }
      if (ctx.esignConfigured) {
        return no("Kontrak ini ditandatangani lewat layanan tanda tangan elektronik. / This contract is signed through the e-signature service.");
      }
      return { allowed: true, sendsToEsignProvider: false };

    case "ESIGN":
      if (ctx.signMethod === "OFFLINE") {
        return no("Kontrak ini ditandatangani di kantor kami. / This contract is signed on paper at our office.");
      }
      if (!ctx.esignConfigured) {
        return no("Layanan tanda tangan elektronik belum aktif — gunakan kotak tanda tangan. / The e-signature service is not set up — use the signature pad.");
      }
      return { allowed: true, sendsToEsignProvider: true };
  }
}

/** What the customer portal offers for this contract — exactly one thing. */
export function customerSigningOption(ctx: Pick<SigningContext, "signMethod" | "esignConfigured">): "ESIGN" | "SIGNATURE_PAD" | "AT_OFFICE" {
  if (ctx.signMethod === "OFFLINE") return "AT_OFFICE";
  return ctx.esignConfigured ? "ESIGN" : "SIGNATURE_PAD";
}

/** Days a customer has to come in and sign on paper, unless the branch sets `featureFlags.offlineSignDays`. */
export const DEFAULT_OFFLINE_SIGN_DAYS = 7;
/** Days before the deadline at which the customer is reminded. */
export const OFFLINE_SIGN_REMINDER_DAYS: readonly number[] = [3, 1];

export function resolveOfflineSignDays(featureFlags: unknown): number {
  const v = (featureFlags as Record<string, unknown> | null)?.["offlineSignDays"];
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 90 ? v : DEFAULT_OFFLINE_SIGN_DAYS;
}

/** The branch's default method (`featureFlags.defaultSignMethod`), ONLINE unless it says OFFLINE. */
export function resolveDefaultSignMethod(featureFlags: unknown): SignMethod {
  return (featureFlags as Record<string, unknown> | null)?.["defaultSignMethod"] === "OFFLINE" ? "OFFLINE" : "ONLINE";
}

const DAY_MS = 86_400_000;

export function offlineSignDeadline(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/** Whole days left until the deadline, rounded up; 0 or less once it has passed. */
export function daysUntilSignDeadline(deadline: Date, now: Date): number {
  return Math.ceil((deadline.getTime() - now.getTime()) / DAY_MS);
}

/** What the daily job does with an unsigned OFFLINE contract today. */
export function offlineSignStep(deadline: Date, now: Date, reminderDays: readonly number[] = OFFLINE_SIGN_REMINDER_DAYS): { kind: "lapse" } | { kind: "remind"; daysLeft: number } | { kind: "wait" } {
  if (deadline.getTime() <= now.getTime()) return { kind: "lapse" };
  const daysLeft = daysUntilSignDeadline(deadline, now);
  return reminderDays.includes(daysLeft) ? { kind: "remind", daysLeft } : { kind: "wait" };
}
