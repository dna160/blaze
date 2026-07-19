import { Decimal, money, roundMoney } from "../money.js";

/**
 * PRD Phase 4 "tenant billing" (Session 26). What RentOS itself charges a
 * tenant for using the platform — deliberately not stored as DB rows the
 * way `AssetType.pricing` is, since a plan catalog is a short, fixed list
 * that changes by a code deploy (a pricing-page edit), not a per-tenant
 * config choice the way a rental rate is. Mirrors the ledger's own
 * `LedgerAccount`-as-enum-not-table reasoning: a small closed set is
 * simpler as a lookup than a table nobody but this code ever queries.
 */
export type BillingPlanKey = "TRIAL" | "STARTER" | "GROWTH" | "SCALE";

export interface BillingPlanDefinition {
  label: string;
  /** Flat monthly charge in IDR, before any overage. */
  monthlyPriceIdr: Decimal.Value;
  /** Active (non-RETIRED) assets included in the flat price before overage kicks in. */
  includedAssets: number;
}

export const BILLING_PLANS: Record<BillingPlanKey, BillingPlanDefinition> = {
  TRIAL: { label: "Trial", monthlyPriceIdr: 0, includedAssets: 10 },
  STARTER: { label: "Starter", monthlyPriceIdr: 500_000, includedAssets: 25 },
  GROWTH: { label: "Growth", monthlyPriceIdr: 1_500_000, includedAssets: 100 },
  SCALE: { label: "Scale", monthlyPriceIdr: 4_000_000, includedAssets: 500 },
};

/** Per-asset charge for every active asset over a plan's `includedAssets`. */
export const OVERAGE_PRICE_PER_ASSET_IDR = 15_000;

export interface MonthlyChargeResult {
  planAmount: Decimal;
  overageAssets: number;
  overageAmount: Decimal;
  totalAmount: Decimal;
}

/**
 * Usage-based metering, deliberately kept to one dimension (active asset
 * count) rather than a multi-metric bill (bookings processed, API calls,
 * storage used, ...) a real SaaS billing system might track — the
 * simplest metric that's still genuinely usage-based (a tenant with more
 * inventory is doing more business on the platform), not a placeholder
 * flat fee. `activeAssetCount` is whatever the caller already counted
 * (packages/database/src/platform-billing.ts counts non-RETIRED Assets
 * per tenant) — this function does no DB access, so it's directly
 * unit-testable.
 */
export function computeMonthlyCharge(plan: BillingPlanKey, activeAssetCount: number): MonthlyChargeResult {
  const definition = BILLING_PLANS[plan];
  const planAmount = roundMoney(money(definition.monthlyPriceIdr));
  const overageAssets = Math.max(0, activeAssetCount - definition.includedAssets);
  const overageAmount = roundMoney(money(overageAssets).mul(OVERAGE_PRICE_PER_ASSET_IDR));
  const totalAmount = roundMoney(planAmount.plus(overageAmount));

  return { planAmount, overageAssets, overageAmount, totalAmount };
}
