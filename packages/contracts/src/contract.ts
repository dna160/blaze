import { z } from "zod";

/**
 * PRD §5.3 / §11: wet-sign PDF upload is v1-acceptable; every upload
 * routes through an ESignProvider (apps/api/src/agreements) that defaults
 * to a synchronous mock — real providers (Privy/e-Meterai) are a Phase 2
 * config change. `esignStatus` distinguishes "signed" from "sent to a
 * real provider, awaiting completion" — signing is always a file upload,
 * not a JSON request, see apps/api/src/agreements/agreements.controller.ts.
 */
export const ContractDtoSchema = z.object({
  id: z.string().uuid(),
  bookingId: z.string().uuid(),
  templateVersion: z.string(),
  signedAt: z.string().datetime().nullable(),
  signedByName: z.string().nullable(),
  esignProvider: z.string().nullable(),
  esignStatus: z.enum(["PENDING", "SIGNED", "DECLINED", "EXPIRED"]).nullable(),
  /** PRD v2 P9 — set once the rental agreement PDF has been generated (GET /contracts/:id/document). */
  unsignedDocumentUrl: z.string().nullable().optional(),
  /** PRD go-live §6.2 — printed as "Contract #". */
  contractNumber: z.string().nullable().optional(),
  /** PRD go-live §7.2 — staff confirmed the signed contract (CONFIRMED stamp). */
  confirmedAt: z.string().datetime().nullable().optional(),
  /**
   * PRD go-live 2 §5.3 — how this contract is signed. ONLINE: the customer
   * signs on the portal (the e-sign provider when one is configured, the
   * signature pad otherwise). OFFLINE: on paper at the office; staff upload
   * the scan before `signDeadlineAt`.
   */
  signMethod: z.enum(["ONLINE", "OFFLINE"]).optional(),
  signDeadlineAt: z.string().datetime().nullable().optional(),
  companyStampPresent: z.boolean().nullable().optional(),
  /** True when a real e-sign provider is configured for this deployment (not the mock). */
  esignAvailable: z.boolean().optional(),
  createdAt: z.string().datetime(),
});
export type ContractDto = z.infer<typeof ContractDtoSchema>;

export const SignMethodSchema = z.enum(["ONLINE", "OFFLINE"]);
export type SignMethodValue = z.infer<typeof SignMethodSchema>;

/** Body of POST /bookings/:id/generate-contract and POST /contracts/:id/sign-method. */
export const SignMethodRequestSchema = z.object({ signMethod: SignMethodSchema.optional() });

/** PRD go-live 2 §5.3 — default days a customer has to sign on paper at the office (`featureFlags.offlineSignDays`). */
export const DEFAULT_OFFLINE_SIGN_DAYS = 7;
/** Days before the deadline at which the customer is reminded. */
export const OFFLINE_SIGN_REMINDER_DAYS: readonly number[] = [3, 1];

export function resolveOfflineSignDays(featureFlags: unknown): number {
  const v = (featureFlags as Record<string, unknown> | null)?.["offlineSignDays"];
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 90 ? v : DEFAULT_OFFLINE_SIGN_DAYS;
}

export function resolveDefaultSignMethod(featureFlags: unknown): SignMethodValue {
  return (featureFlags as Record<string, unknown> | null)?.["defaultSignMethod"] === "OFFLINE" ? "OFFLINE" : "ONLINE";
}
