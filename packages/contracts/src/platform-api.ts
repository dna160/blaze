import { z } from "zod";

import { BookingDtoSchema } from "./booking.js";
import { InvoiceDtoSchema } from "./finance.js";

/**
 * Phase 4 — tenant-facing external API + outbound webhooks (PRD §13).
 * Gated per tenant by `Tenant.featureFlags.api_access_enabled`; see
 * docs/HANDOFF.md Session 20 for the RLS/auth design rationale.
 */

// ---------------------------------------------------------------------------
// API keys (console-facing CRUD)
// ---------------------------------------------------------------------------

export const CreateApiKeyRequestSchema = z.object({
  label: z.string().min(1).max(100),
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequestSchema>;

export const ApiKeyDtoSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  keyPrefix: z.string(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ApiKeyDto = z.infer<typeof ApiKeyDtoSchema>;

/** Returned exactly once, at creation — the plaintext key is never retrievable again. */
export const CreatedApiKeyResponseSchema = ApiKeyDtoSchema.extend({
  key: z.string(),
});
export type CreatedApiKeyResponse = z.infer<typeof CreatedApiKeyResponseSchema>;

// ---------------------------------------------------------------------------
// Outbound webhook subscriptions (console-facing CRUD)
// ---------------------------------------------------------------------------

/** Single source of truth for valid webhook event types — enforced by the request schema below. */
export const WEBHOOK_EVENT_TYPES = ["booking.approved", "invoice.paid", "payment.received"] as const;
export const WebhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);
export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;

export const CreateWebhookSubscriptionRequestSchema = z.object({
  url: z.string().url(),
  eventTypes: z.array(WebhookEventTypeSchema).min(1),
});
export type CreateWebhookSubscriptionRequest = z.infer<typeof CreateWebhookSubscriptionRequestSchema>;

export const UpdateWebhookSubscriptionRequestSchema = z.object({
  url: z.string().url().optional(),
  eventTypes: z.array(WebhookEventTypeSchema).min(1).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateWebhookSubscriptionRequest = z.infer<typeof UpdateWebhookSubscriptionRequestSchema>;

export const WebhookSubscriptionDtoSchema = z.object({
  id: z.string().uuid(),
  url: z.string(),
  eventTypes: z.array(z.string()),
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
});
export type WebhookSubscriptionDto = z.infer<typeof WebhookSubscriptionDtoSchema>;

/** Returned exactly once, at creation — the signing secret is never retrievable again. */
export const CreatedWebhookSubscriptionResponseSchema = WebhookSubscriptionDtoSchema.extend({
  secret: z.string(),
});
export type CreatedWebhookSubscriptionResponse = z.infer<typeof CreatedWebhookSubscriptionResponseSchema>;

export const WebhookDeliveryStatusSchema = z.enum(["PENDING", "SUCCEEDED", "FAILED"]);

export const WebhookDeliveryDtoSchema = z.object({
  id: z.string().uuid(),
  subscriptionId: z.string().uuid(),
  eventType: z.string(),
  status: WebhookDeliveryStatusSchema,
  httpStatus: z.number().int().nullable(),
  attempt: z.number().int(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  deliveredAt: z.string().datetime().nullable(),
});
export type WebhookDeliveryDto = z.infer<typeof WebhookDeliveryDtoSchema>;

// ---------------------------------------------------------------------------
// Outbound webhook payload envelope (worker -> tenant's URL)
// ---------------------------------------------------------------------------

export const WebhookPayloadEnvelopeSchema = z.object({
  eventType: WebhookEventTypeSchema,
  deliveryId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  data: z.record(z.unknown()),
});
export type WebhookPayloadEnvelope = z.infer<typeof WebhookPayloadEnvelopeSchema>;

// ---------------------------------------------------------------------------
// External read-only API (ApiKeyGuard-protected — GET /external/*)
// ---------------------------------------------------------------------------

export const ExternalListQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ExternalListQuery = z.infer<typeof ExternalListQuerySchema>;

export function cursorPaginatedResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    nextCursor: z.string().uuid().nullable(),
  });
}

export const ExternalBookingListResponseSchema = cursorPaginatedResponseSchema(BookingDtoSchema);
export type ExternalBookingListResponse = z.infer<typeof ExternalBookingListResponseSchema>;

export const ExternalInvoiceListResponseSchema = cursorPaginatedResponseSchema(InvoiceDtoSchema);
export type ExternalInvoiceListResponse = z.infer<typeof ExternalInvoiceListResponseSchema>;
