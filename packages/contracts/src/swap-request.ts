import { z } from "zod";

export const SwapRequestStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED"]);

/** Self-service portal — request upgrade/downsize (PRD §7.1.4). Customer picks a target AssetType; staff picks the actual replacement unit on approval. */
export const CreateSwapRequestSchema = z.object({
  bookingId: z.string().uuid(),
  requestedAssetTypeId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});
export type CreateSwapRequest = z.infer<typeof CreateSwapRequestSchema>;

export const ApproveSwapRequestSchema = z.object({
  newAssetId: z.string().uuid(),
});
export type ApproveSwapRequest = z.infer<typeof ApproveSwapRequestSchema>;

export const RejectSwapRequestSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type RejectSwapRequest = z.infer<typeof RejectSwapRequestSchema>;

export const SwapRequestDtoSchema = z.object({
  id: z.string().uuid(),
  bookingId: z.string().uuid(),
  requestedAssetTypeId: z.string().uuid(),
  reason: z.string().nullable(),
  status: SwapRequestStatusSchema,
  newAssetId: z.string().uuid().nullable(),
  reviewedByUserId: z.string().uuid().nullable(),
  reviewedAt: z.string().datetime().nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type SwapRequestDto = z.infer<typeof SwapRequestDtoSchema>;
