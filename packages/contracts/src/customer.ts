import { z } from "zod";

export const KycStatusSchema = z.enum(["NOT_SUBMITTED", "PENDING_REVIEW", "VERIFIED", "REJECTED"]);

export const CustomerChannelSchema = z.enum(["WHATSAPP", "EMAIL"]);
export type CustomerChannelValue = z.infer<typeof CustomerChannelSchema>;

export const CustomerDtoSchema = z.object({
  id: z.string().uuid(),
  /** Nullable since PRD v2 D3 (Google-signed-in customers are keyed by email). */
  phone: z.string().nullable(),
  email: z.string().email().nullable(),
  fullName: z.string().nullable(),
  kycStatus: KycStatusSchema,
  preferredChannel: CustomerChannelSchema,
  isBlocklisted: z.boolean(),
});
export type CustomerDto = z.infer<typeof CustomerDtoSchema>;

/**
 * Client list (PRD v2 §5.2): "healthy means paid ahead, risky means 7 days
 * before payment is due, overdue means payment is already due, inactive
 * means they are no longer with us."
 */
export const CustomerHealthSchema = z.enum(["HEALTHY", "RISKY", "OVERDUE", "INACTIVE"]);
export type CustomerHealthValue = z.infer<typeof CustomerHealthSchema>;

export const ClientListQuerySchema = z.object({
  /** Matches name, phone, email, or unit code (case-insensitive). */
  search: z.string().max(200).optional(),
  status: CustomerHealthSchema.optional(),
  locationId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ClientListQuery = z.infer<typeof ClientListQuerySchema>;

export const ClientListItemSchema = z.object({
  id: z.string().uuid(),
  fullName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  preferredChannel: CustomerChannelSchema,
  kycStatus: KycStatusSchema,
  health: CustomerHealthSchema,
  /** Units currently held (active / approved / pending), e.g. [{ code: "B-14", location: "Kelapa Gading" }]. */
  units: z.array(z.object({ bookingId: z.string().uuid(), code: z.string().nullable(), assetTypeName: z.string(), locationName: z.string().nullable(), status: z.string() })),
  /** Earliest start date among live bookings. */
  moveInDate: z.string().datetime().nullable(),
  nextDueDate: z.string().datetime().nullable(),
  nextDueAmount: z.string().nullable(),
  outstandingAmount: z.string(),
  overdueCount: z.number().int(),
  createdAt: z.string().datetime(),
});
export type ClientListItem = z.infer<typeof ClientListItemSchema>;

export const ClientListResponseSchema = z.object({
  items: z.array(ClientListItemSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  counts: z.object({ HEALTHY: z.number().int(), RISKY: z.number().int(), OVERDUE: z.number().int(), INACTIVE: z.number().int() }),
});
export type ClientListResponse = z.infer<typeof ClientListResponseSchema>;

export const KycDocumentTypeSchema = z.enum(["KTP", "SELFIE"]);

/**
 * v1 upload is a single proxied multipart POST (not a presigned-URL
 * direct-to-storage flow) — the API receives the file via multer, then
 * calls StorageProvider.save() server-side. Simpler to get right at this
 * scale than a presigned-URL/token dance, and the raw bytes only ever
 * transit our own API over TLS, never a second hop the client controls.
 * See apps/api/src/kyc/kyc.controller.ts.
 */
export const KycVerificationSourceSchema = z.enum(["MANUAL", "AUTO"]);

export const KycDocumentDtoSchema = z.object({
  id: z.string().uuid(),
  documentType: KycDocumentTypeSchema,
  status: KycStatusSchema,
  createdAt: z.string().datetime(),
  reviewedAt: z.string().datetime().nullable(),
  /** AUTO means KycVerificationProvider decided this without a human in the loop (Session 21) — see apps/api/src/kyc/kyc-verification-provider.interface.ts. */
  verificationSource: KycVerificationSourceSchema,
  providerRef: z.string().nullable(),
  /** Provider's stated reason — populated for AUTO-REJECTED docs and for an inconclusive auto-check that fell back to the manual queue. */
  providerReason: z.string().nullable(),
});
export type KycDocumentDto = z.infer<typeof KycDocumentDtoSchema>;

export const ReviewKycDocumentRequestSchema = z.object({
  status: z.enum(["VERIFIED", "REJECTED"]),
  reason: z.string().optional(),
});
export type ReviewKycDocumentRequest = z.infer<typeof ReviewKycDocumentRequestSchema>;
