import { z } from "zod";

import { MoneyStringSchema } from "./common.js";

export const BookingModelSchema = z.enum(["RECURRING_LEASE", "NIGHTLY", "DURATION_ORDER", "HOURLY_SLOT"]);
export type BookingModelValue = z.infer<typeof BookingModelSchema>;

export const AssetStatusSchema = z.enum(["AVAILABLE", "RESERVED", "OCCUPIED", "MAINTENANCE", "RETIRED"]);

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
