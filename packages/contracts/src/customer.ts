import { z } from "zod";

export const KycStatusSchema = z.enum(["NOT_SUBMITTED", "PENDING_REVIEW", "VERIFIED", "REJECTED"]);

export const CustomerDtoSchema = z.object({
  id: z.string().uuid(),
  phone: z.string(),
  email: z.string().email().nullable(),
  fullName: z.string().nullable(),
  kycStatus: KycStatusSchema,
  isBlocklisted: z.boolean(),
});
export type CustomerDto = z.infer<typeof CustomerDtoSchema>;

export const KycDocumentTypeSchema = z.enum(["KTP", "SELFIE"]);

/**
 * v1 upload is a single proxied multipart POST (not a presigned-URL
 * direct-to-storage flow) — the API receives the file via multer, then
 * calls StorageProvider.save() server-side. Simpler to get right at this
 * scale than a presigned-URL/token dance, and the raw bytes only ever
 * transit our own API over TLS, never a second hop the client controls.
 * See apps/api/src/kyc/kyc.controller.ts.
 */
export const KycDocumentDtoSchema = z.object({
  id: z.string().uuid(),
  documentType: KycDocumentTypeSchema,
  status: KycStatusSchema,
  createdAt: z.string().datetime(),
  reviewedAt: z.string().datetime().nullable(),
});
export type KycDocumentDto = z.infer<typeof KycDocumentDtoSchema>;

export const ReviewKycDocumentRequestSchema = z.object({
  status: z.enum(["VERIFIED", "REJECTED"]),
  reason: z.string().optional(),
});
export type ReviewKycDocumentRequest = z.infer<typeof ReviewKycDocumentRequestSchema>;
