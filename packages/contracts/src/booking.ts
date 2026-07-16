import { z } from "zod";

import { BookingModelSchema } from "./catalog.js";
import { MoneyStringSchema } from "./common.js";

export const BookingStatusSchema = z.enum([
  "DRAFT",
  "PENDING_APPROVAL",
  "NEEDS_INFO",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "ACTIVE",
  "LAPSED",
  "RENEWING",
  "NOTICE_GIVEN",
  "SUSPENDED",
  "DEFAULT",
  "MOVED_OUT",
  "CLOSED",
  "PAID",
  "CHECKED_IN",
  "CHECKED_OUT",
  "NO_SHOW",
  "EXTENDED",
  "PICKED_UP",
  "RETURNED",
  "INSPECTION",
]);
export type BookingStatusValue = z.infer<typeof BookingStatusSchema>;

/**
 * Storefront booking submission (PRD §7.1.2). Customer identity is
 * phone-based; if no Customer row exists for (tenant, phone) yet, the API
 * creates one as part of this call rather than requiring a separate
 * signup step.
 */
export const CreateBookingRequestSchema = z.object({
  assetTypeId: z.string().uuid(),
  startDate: z.string().datetime(),
  customerPhone: z.string().min(8).max(20),
  customerFullName: z.string().min(1).max(200),
  promoCode: z.string().optional(),
});
export type CreateBookingRequest = z.infer<typeof CreateBookingRequestSchema>;

export const BookingDtoSchema = z.object({
  id: z.string().uuid(),
  status: BookingStatusSchema,
  bookingModel: BookingModelSchema,
  assetTypeId: z.string().uuid(),
  assetId: z.string().uuid().nullable(),
  customerId: z.string().uuid(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime().nullable(),
  anchorDay: z.number().int().nullable(),
  reservedUntil: z.string().datetime().nullable(),
  totalDue: MoneyStringSchema.optional(),
  createdAt: z.string().datetime(),
});
export type BookingDto = z.infer<typeof BookingDtoSchema>;

/** Approval workbench (PRD §7.2.1) — approve assigns a unit if not already auto-assigned. */
export const ApproveBookingRequestSchema = z.object({
  assetId: z.string().uuid().optional(),
});
export type ApproveBookingRequest = z.infer<typeof ApproveBookingRequestSchema>;

export const RejectBookingRequestSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type RejectBookingRequest = z.infer<typeof RejectBookingRequestSchema>;

export const RequestInfoRequestSchema = z.object({
  message: z.string().min(1).max(1000),
});
export type RequestInfoRequest = z.infer<typeof RequestInfoRequestSchema>;

/** Self-service portal — give notice (PRD §7.1.4). */
export const GiveNoticeRequestSchema = z.object({
  noticeEffectiveDate: z.string().datetime(),
});
export type GiveNoticeRequest = z.infer<typeof GiveNoticeRequestSchema>;
