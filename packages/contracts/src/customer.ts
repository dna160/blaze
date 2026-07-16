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

/**
 * v1 KYC upload is two steps: the client uploads the file directly to
 * object storage via a presigned URL (not modeled here — infra concern),
 * then calls this endpoint with the resulting storage key so the API
 * never proxies the raw KTP/selfie bytes (PRD §10 Security: "encrypted PII
 * at rest").
 */
export const SubmitKycDocumentRequestSchema = z.object({
  documentType: z.enum(["KTP", "SELFIE"]),
  storageKey: z.string().min(1),
});
export type SubmitKycDocumentRequest = z.infer<typeof SubmitKycDocumentRequestSchema>;

export const ReviewKycDocumentRequestSchema = z.object({
  status: z.enum(["VERIFIED", "REJECTED"]),
  reason: z.string().optional(),
});
export type ReviewKycDocumentRequest = z.infer<typeof ReviewKycDocumentRequestSchema>;
