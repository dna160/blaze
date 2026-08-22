import type { Decimal } from "../money.js";
import type { DepositRule } from "../pricing/deposit.js";
import type { ProrationRule } from "../pricing/proration.js";
import type { SeasonalRate } from "../pricing/seasonal.js";

export type BookingModelKind = "RECURRING_LEASE" | "NIGHTLY" | "DURATION_ORDER" | "HOURLY_SLOT";

/**
 * RECURRING_LEASE only — selects which of PricingConfig's three rates a
 * booking is priced against. MONTHLY (default) is the original indefinite
 * lease, unchanged. DAILY/WEEKLY are fixed-term bookings (real endDate,
 * one upfront invoice, no recurring cadence) — see
 * RecurringLeaseStrategy.computeInitialInvoice.
 */
export type RateTier = "DAILY" | "WEEKLY" | "MONTHLY";

export interface PricingConfig {
  /** The monthly rate for RECURRING_LEASE (rateTier MONTHLY), or the per-unit rate for other booking models. */
  basePrice: Decimal;
  currency: string;
  adminFee?: Decimal;
  depositRule?: DepositRule;
  prorationRule?: ProrationRule;
  taxInclusive: boolean;
  /** NIGHTLY only (PRD §7.2.3 P2) — date-range rate overrides, e.g. peak season. See pricing/seasonal.ts. */
  seasonalRates?: SeasonalRate[];
  /** RECURRING_LEASE only — per-day rate, used when the booking's rateTier is DAILY. */
  dailyRate?: Decimal;
  /** RECURRING_LEASE only — per-week rate, used when the booking's rateTier is WEEKLY. */
  weeklyRate?: Decimal;
}

export interface BookingWindow {
  startDate: Date;
  endDate?: Date;
  /** RECURRING_LEASE only — day-of-month billing anchor. Required once a lease is ACTIVE (MONTHLY tier only). */
  anchorDay?: number;
  /** RECURRING_LEASE only — defaults to MONTHLY (the original indefinite lease) when unset. */
  rateTier?: RateTier;
}

export type InvoiceLineType = "RENT" | "DEPOSIT" | "ADMIN_FEE" | "TAX" | "DISCOUNT" | "DAMAGE";

export interface InvoiceLineDraft {
  description: string;
  quantity: Decimal;
  unitPrice: Decimal;
  amount: Decimal;
  lineType: InvoiceLineType;
}

export interface InvoiceDraft {
  lines: InvoiceLineDraft[];
  subtotal: Decimal;
  taxAmount: Decimal;
  totalAmount: Decimal;
  periodStart: Date;
  periodEnd: Date;
}

export interface TenantTaxContext {
  isTenantPkp: boolean;
}

/**
 * The pluggable core of RentOS (PRD §5.2). Every AssetType declares exactly
 * one BookingModel, and this interface is the ONLY place calendar math,
 * billing cadence, and lifecycle verbs are allowed to differ between
 * verticals. The rule this interface exists to enforce: "No feature may
 * branch on 'is this storage?' — only on booking model and tenant config."
 * A caller that finds itself writing `if (tenant.slug === 'storage')`
 * anywhere outside this package has broken the abstraction.
 *
 * v1 ships RecurringLeaseStrategy fully implemented (storage, the launch
 * vertical). Nightly/DurationOrder/HourlySlot are typed stubs — the seam
 * is proven, the math is Phase 3 (PRD §13).
 */
export interface BookingModelStrategy {
  readonly kind: BookingModelKind;
  /** Customer/ops-facing verbs for this vertical's lifecycle, e.g. ["move_in","renew","terminate"]. */
  readonly lifecycleVerbs: readonly string[];

  /** The invoice generated at booking approval / first activation. */
  computeInitialInvoice(window: BookingWindow, pricing: PricingConfig, tax: TenantTaxContext): InvoiceDraft;

  /** RECURRING_LEASE only: the invoice for the next billing cycle. Undefined for one-shot models. */
  computeNextCycleInvoice?(
    cycleStart: Date,
    pricing: PricingConfig,
    tax: TenantTaxContext,
  ): InvoiceDraft;

  /** RECURRING_LEASE only: next anchor date on/after `from`. */
  nextCycleDate?(anchorDay: number, from: Date): Date;

  /** Final invoice at termination/return — prorated exit for leases, damage/deposit reconciliation for orders. */
  computeFinalSettlement(
    window: BookingWindow,
    pricing: PricingConfig,
    tax: TenantTaxContext,
    effectiveEndDate: Date,
  ): InvoiceDraft;
}
