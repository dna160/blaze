import { z } from "zod";

import { BookingModelSchema, RateTierSchema, TermMonthsSchema } from "./catalog.js";
import { MoneyStringSchema } from "./common.js";

export const BookingStatusSchema = z.enum([
  "DRAFT",
  "WAITLISTED",
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
  /** Required for NIGHTLY/DURATION_ORDER (checkout/return date), and for RECURRING_LEASE when rateTier is DAILY/WEEKLY. Ignored otherwise. */
  endDate: z.string().datetime().optional(),
  /** RECURRING_LEASE only — defaults to MONTHLY (the original indefinite lease) when omitted. */
  rateTier: RateTierSchema.optional(),
  /** RECURRING_LEASE storage flow (PRD v2 §4): the branch the customer chose. Required when termMonths is set. */
  locationId: z.string().uuid().optional(),
  /** RECURRING_LEASE storage flow (PRD v2 D1): 1 / 3 / 6 / 12. Required for storage tenants since v2; omitting it is only valid for NIGHTLY/DURATION_ORDER. */
  termMonths: TermMonthsSchema.optional(),
  /** Extension of an existing term on the same unit (PRD v2 D2) — exempts the new booking from the parent's blackout month. Customer session required. */
  extendsBookingId: z.string().uuid().optional(),
  customerPhone: z.string().min(8).max(20),
  customerFullName: z.string().min(1).max(200),
  promoCode: z.string().optional(),
});
export type CreateBookingRequest = z.infer<typeof CreateBookingRequestSchema>;

/** What the storefront shows right after submission (PRD v2 §4.4). */
export const CreateBookingResponseSchema = z.object({
  id: z.string().uuid(),
  status: BookingStatusSchema,
  /** 1-based position among WAITLISTED bookings for the same branch + size, oldest first. Null unless WAITLISTED. */
  waitlistPosition: z.number().int().min(1).nullable(),
  assetCode: z.string().nullable(),
});
export type CreateBookingResponse = z.infer<typeof CreateBookingResponseSchema>;

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
  rateTier: RateTierSchema,
  reservedUntil: z.string().datetime().nullable(),
  totalDue: MoneyStringSchema.optional(),
  /** PRD v2 fields — null on pre-v2 / non-storage bookings. */
  locationId: z.string().uuid().nullable().optional(),
  termMonths: z.number().int().nullable().optional(),
  extendsBookingId: z.string().uuid().nullable().optional(),
  kycRequestedAt: z.string().datetime().nullable().optional(),
  contractGeneratedAt: z.string().datetime().nullable().optional(),
  waitlistedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
});
export type BookingDto = z.infer<typeof BookingDtoSchema>;

/**
 * Approval pipeline (PRD v2 §5.1): Approval -> Request KYC -> Generate
 * Contract + Proforma -> Finance. Derived server-side from the booking's
 * status + pipeline timestamps + the customer's KYC status + whether
 * invoice #0 exists — the FSM is deliberately NOT forked per stage (P2).
 */
export const PipelineStageSchema = z.enum(["WAITLIST", "APPROVAL", "KYC", "CONTRACT", "FINANCE", "ACTIVE", "CLOSED"]);
export type PipelineStageValue = z.infer<typeof PipelineStageSchema>;

export const PipelineBookingDtoSchema = BookingDtoSchema.extend({
  pipelineStage: PipelineStageSchema,
  /** Human hint for the card: what's blocking this stage ("KYC requested 2 days ago, no upload yet"). */
  stageDetail: z.string(),
  waitlistPosition: z.number().int().nullable(),
  customer: z.object({
    id: z.string().uuid(),
    fullName: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    kycStatus: z.string(),
    preferredChannel: z.enum(["WHATSAPP", "EMAIL"]),
  }),
  assetType: z.object({ id: z.string().uuid(), name: z.string() }),
  asset: z.object({ id: z.string().uuid(), code: z.string() }).nullable(),
  location: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
  firstInvoice: z
    .object({ id: z.string().uuid(), invoiceNumber: z.string(), status: z.string(), totalAmount: MoneyStringSchema, dueDate: z.string().datetime() })
    .nullable(),
  contract: z.object({ id: z.string().uuid(), signedAt: z.string().datetime().nullable(), hasDocument: z.boolean() }).nullable(),
});
export type PipelineBookingDto = z.infer<typeof PipelineBookingDtoSchema>;

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
