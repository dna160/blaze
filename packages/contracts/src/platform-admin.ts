import { z } from "zod";

import { MoneyStringSchema } from "./common.js";

/**
 * PRD Phase 4 self-serve tenant signup + tenant billing/metering (Session
 * 26) — the platform-admin surface, distinct from `platform-api.ts`
 * (Session 20's tenant-facing external API/webhooks, a completely
 * different audience: a tenant's own integrations, not RentOS staff).
 */

// -- Self-serve signup -------------------------------------------------

export const PlatformSignupRequestSchema = z.object({
  companyName: z.string().min(2).max(120),
  /** Becomes Tenant.slug — resolved via X-Tenant-Slug/?tenant= exactly like the three seeded tenants. */
  slug: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase letters, numbers, and hyphens only"),
  isPkp: z.boolean().default(false),
  adminEmail: z.string().email(),
  adminName: z.string().min(1).max(120),
  password: z.string().min(8).max(200),
});
export type PlatformSignupRequest = z.infer<typeof PlatformSignupRequestSchema>;

export const PlatformSignupResponseSchema = z.object({
  tenantId: z.string().uuid(),
  tenantSlug: z.string(),
  message: z.string(),
});
export type PlatformSignupResponse = z.infer<typeof PlatformSignupResponseSchema>;

// -- Platform-admin auth -------------------------------------------------

export const PlatformLoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type PlatformLoginRequest = z.infer<typeof PlatformLoginRequestSchema>;

// -- Tenant + billing overview -------------------------------------------------

export const BillingPlanSchema = z.enum(["TRIAL", "STARTER", "GROWTH", "SCALE"]);
export type BillingPlanValue = z.infer<typeof BillingPlanSchema>;

export const PlatformTenantSummaryDtoSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  billingPlan: BillingPlanSchema,
  includedAssets: z.number().int(),
  activeAssetCount: z.number().int(),
  createdAt: z.string(),
});
export type PlatformTenantSummaryDto = z.infer<typeof PlatformTenantSummaryDtoSchema>;

export const PlatformInvoiceStatusSchema = z.enum(["ISSUED", "PAID"]);

export const PlatformInvoiceDtoSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  tenantSlug: z.string(),
  billingPlan: BillingPlanSchema,
  periodYear: z.number().int(),
  periodMonth: z.number().int(),
  includedAssets: z.number().int(),
  actualAssetCount: z.number().int(),
  planAmount: MoneyStringSchema,
  overageAmount: MoneyStringSchema,
  totalAmount: MoneyStringSchema,
  status: PlatformInvoiceStatusSchema,
  issuedAt: z.string(),
  paidAt: z.string().nullable(),
});
export type PlatformInvoiceDto = z.infer<typeof PlatformInvoiceDtoSchema>;

export const RunBillingResponseSchema = z.object({
  results: z.array(z.object({ tenantSlug: z.string(), created: z.boolean() })),
});
export type RunBillingResponse = z.infer<typeof RunBillingResponseSchema>;
