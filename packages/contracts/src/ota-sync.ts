import { z } from "zod";

/**
 * Phase 4 — OTA channel calendar sync via iCal (PRD §13, Session 22).
 * Gated per tenant by `Tenant.featureFlags.ota_sync_enabled`.
 */

export const CreateOtaSubscriptionRequestSchema = z.object({
  assetId: z.string().uuid(),
  label: z.string().min(1).max(100),
  sourceUrl: z.string().url(),
});
export type CreateOtaSubscriptionRequest = z.infer<typeof CreateOtaSubscriptionRequestSchema>;

export const OtaSyncStatusSchema = z.enum(["PENDING", "SUCCEEDED", "FAILED"]);

export const OtaSubscriptionDtoSchema = z.object({
  id: z.string().uuid(),
  assetId: z.string().uuid(),
  label: z.string(),
  sourceUrl: z.string(),
  isActive: z.boolean(),
  lastSyncedAt: z.string().datetime().nullable(),
  lastSyncStatus: OtaSyncStatusSchema,
  lastSyncError: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type OtaSubscriptionDto = z.infer<typeof OtaSubscriptionDtoSchema>;
