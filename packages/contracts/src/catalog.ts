import { z } from "zod";

import { MoneyStringSchema } from "./common.js";

export const BookingModelSchema = z.enum(["RECURRING_LEASE", "NIGHTLY", "DURATION_ORDER", "HOURLY_SLOT"]);
export type BookingModelValue = z.infer<typeof BookingModelSchema>;

export const AssetStatusSchema = z.enum(["AVAILABLE", "RESERVED", "OCCUPIED", "MAINTENANCE", "RETIRED"]);

/**
 * RECURRING_LEASE only — which of the AssetType's three configured rates a
 * booking is priced against. MONTHLY (default) is the original indefinite
 * lease. DAILY/WEEKLY are fixed-term bookings (real endDate, one upfront
 * invoice) — Travelio-style short stays on the same unit. Ignored for
 * other booking models.
 */
export const RateTierSchema = z.enum(["DAILY", "WEEKLY", "MONTHLY"]);
export type RateTierValue = z.infer<typeof RateTierSchema>;

/** PRD v2 D1 — the only terms a storage tenant sells. Daily/weekly tiers are no longer offered on the storefront. */
export const TERM_OPTIONS_MONTHS = [1, 3, 6, 12] as const;
export const TermMonthsSchema = z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]);
export type TermMonthsValue = z.infer<typeof TermMonthsSchema>;

/** Storefront size grouping (PRD v2 §4.1) — stored in AssetType.attributesSchema.sizeClass. */
export const SizeClassSchema = z.enum(["SMALL", "MEDIUM", "LARGE"]);
export type SizeClassValue = z.infer<typeof SizeClassSchema>;

export const PricingConfigSchema = z.object({
  basePrice: MoneyStringSchema,
  currency: z.string().length(3),
  billingPeriod: z.enum(["MONTHLY", "NIGHTLY", "ORDER", "HOURLY"]),
  depositRule: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("FIXED"), amount: z.number() }),
      z.object({ type: z.literal("MULTIPLE_OF_RENT"), multiple: z.number() }),
    ])
    .optional(),
  adminFee: z.number().optional(),
  prorationRule: z.enum(["ANCHOR_DATE", "FULL_FIRST_PERIOD"]).optional(),
  taxInclusive: z.boolean().default(false),
  /** NIGHTLY only (PRD §7.2.3 P2) — date-range rate overrides, e.g. peak season. `startDate`/`endDate` are inclusive YYYY-MM-DD calendar dates. */
  seasonalRates: z
    .array(z.object({ startDate: z.string(), endDate: z.string(), basePrice: z.number(), label: z.string().optional() }))
    .optional(),
  /** RECURRING_LEASE only — per-day rate, used when a booking's rateTier is DAILY. */
  dailyRate: MoneyStringSchema.optional(),
  /** RECURRING_LEASE only — per-week rate, used when a booking's rateTier is WEEKLY. */
  weeklyRate: MoneyStringSchema.optional(),
});
export type PricingConfig = z.infer<typeof PricingConfigSchema>;

export const AssetTypeDtoSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  bookingModel: BookingModelSchema,
  attributesSchema: z.record(z.unknown()),
  pricing: PricingConfigSchema,
  photos: z.array(z.string()),
  /** Interchangeable inventory (e.g. shared dorm beds) — availability is a capacity count over a date range rather than one specific Asset held per booking. See docs/HANDOFF.md Session 17. */
  isPooled: z.boolean(),
  isPublished: z.boolean(),
});
export type AssetTypeDto = z.infer<typeof AssetTypeDtoSchema>;

export const AssetDtoSchema = z.object({
  id: z.string().uuid(),
  locationId: z.string().uuid(),
  assetTypeId: z.string().uuid(),
  code: z.string(),
  status: AssetStatusSchema,
  attributes: z.record(z.unknown()),
});
export type AssetDto = z.infer<typeof AssetDtoSchema>;

/**
 * Catalog setup (console-facing, staff-only) — every AssetType/Asset in
 * this codebase was seed-data-only through Session 21; these are the
 * first write endpoints for a tenant's own catalog. `bookingModel` and
 * `slug` are set once at creation and never editable afterward: the FSM
 * a booking on this AssetType runs through, and every downstream
 * booking's `priceSnapshot`/lifecycle assumptions, are keyed off
 * `bookingModel` — changing it after real bookings exist would silently
 * corrupt them.
 */
export const CreateAssetTypeRequestSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, and hyphens only."),
  bookingModel: BookingModelSchema,
  attributesSchema: z.record(z.unknown()).default({}),
  pricing: PricingConfigSchema,
  photos: z.array(z.string()).default([]),
  isPooled: z.boolean().default(false),
  isPublished: z.boolean().default(true),
});
export type CreateAssetTypeRequest = z.infer<typeof CreateAssetTypeRequestSchema>;

export const UpdateAssetTypeRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  attributesSchema: z.record(z.unknown()).optional(),
  pricing: PricingConfigSchema.optional(),
  photos: z.array(z.string()).optional(),
  isPooled: z.boolean().optional(),
  isPublished: z.boolean().optional(),
});
export type UpdateAssetTypeRequest = z.infer<typeof UpdateAssetTypeRequestSchema>;

export const CreateAssetRequestSchema = z.object({
  assetTypeId: z.string().uuid(),
  locationId: z.string().uuid(),
  code: z.string().min(1).max(50),
  attributes: z.record(z.unknown()).default({}),
});
export type CreateAssetRequest = z.infer<typeof CreateAssetRequestSchema>;

export const UpdateAssetStatusRequestSchema = z.object({
  status: AssetStatusSchema,
  statusReason: z.string().max(500).optional(),
});
export type UpdateAssetStatusRequest = z.infer<typeof UpdateAssetStatusRequestSchema>;

export const LocationDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  address: z.string().nullable(),
  timezone: z.string(),
  /** WGS84, null when the branch hasn't been placed on the map yet (PRD v2 D4). */
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
});
export type LocationDto = z.infer<typeof LocationDtoSchema>;

/** Console catalog setup — first write path for Location rows (gap flagged since Session 1, needed for the map). */
export const UpsertLocationRequestSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().max(500).optional().nullable(),
  timezone: z.string().min(1).max(64).optional(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
});
export type UpsertLocationRequest = z.infer<typeof UpsertLocationRequestSchema>;

/**
 * Storefront step 2 (PRD v2 §4.1): the sizes sold at a branch, with how many
 * units are free RIGHT NOW for a 1-month window — a display estimate; the
 * number that gates a booking is recomputed for the customer's real
 * check-in date + term at submission (same caveat as pooled availability).
 */
export const LocationAssetTypeSummarySchema = z.object({
  assetType: AssetTypeDtoSchema,
  sizeClass: SizeClassSchema.nullable(),
  unitCount: z.number().int(),
  availableNow: z.number().int(),
});
export type LocationAssetTypeSummary = z.infer<typeof LocationAssetTypeSummarySchema>;

/** Storefront step 3 live check (PRD v2 §4.3). */
export const StorageAvailabilityQuerySchema = z.object({
  locationId: z.string().uuid(),
  assetTypeId: z.string().uuid(),
  startDate: z.string().datetime(),
  /** Arrives as a query-string value, hence the coercion before the literal check. */
  termMonths: z.coerce.number().pipe(TermMonthsSchema),
});
export type StorageAvailabilityQuery = z.infer<typeof StorageAvailabilityQuerySchema>;

export const StorageAvailabilityResponseSchema = z.object({
  available: z.boolean(),
  availableCount: z.number().int(),
  /** How many WAITLISTED requests for this branch + size are ahead of a new one. */
  waitlistAhead: z.number().int(),
  blackoutMonths: z.number().int(),
  /** Exclusive end of the requested term. */
  endDate: z.string().datetime(),
});
export type StorageAvailabilityResponse = z.infer<typeof StorageAvailabilityResponseSchema>;

export const AvailabilityQuerySchema = z.object({
  assetTypeId: z.string().uuid(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime().optional(),
});
export type AvailabilityQuery = z.infer<typeof AvailabilityQuerySchema>;

export const AvailabilityResponseSchema = z.object({
  assetTypeId: z.string().uuid(),
  availableCount: z.number().int().min(0),
});
export type AvailabilityResponse = z.infer<typeof AvailabilityResponseSchema>;

/**
 * Live price preview (public, unauthenticated — same trust level as the
 * catalog listing itself, PRD §7.1.1) for the storefront's Daily/Weekly/
 * Monthly tier picker. Reuses the exact BookingModelStrategy math a real
 * booking will be charged, via a read-only call — no persistence, no
 * customer/tenant write — so the preview can never drift from the real
 * charge the way a hand-duplicated client-side calculation could.
 */
export const QuoteRequestSchema = z.object({
  startDate: z.string().datetime(),
  endDate: z.string().datetime().optional(),
  rateTier: RateTierSchema.optional(),
  /** PRD v2 D1 — quote the proforma of a fixed term and preview the full monthly schedule. */
  termMonths: TermMonthsSchema.optional(),
});
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

export const QuoteResponseSchema = z.object({
  currency: z.string().length(3),
  lines: z.array(
    z.object({
      description: z.string(),
      amount: MoneyStringSchema,
      lineType: z.enum(["RENT", "DEPOSIT", "ADMIN_FEE", "TAX", "DISCOUNT", "DAMAGE"]),
    }),
  ),
  subtotal: MoneyStringSchema,
  taxAmount: MoneyStringSchema,
  totalAmount: MoneyStringSchema,
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  /** Present for term quotes: every payment in the schedule, index 0 = this proforma. */
  schedule: z
    .array(
      z.object({
        index: z.number().int(),
        periodStart: z.string().datetime(),
        periodEnd: z.string().datetime(),
        dueDate: z.string().datetime(),
        totalAmount: MoneyStringSchema,
      }),
    )
    .optional(),
  termMonths: TermMonthsSchema.optional(),
});
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;
