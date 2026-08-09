// BUILD-SPEC #30/#31/#32 — bundle discount, duration-tier discount, and manual
// per-booking price override. Pure math over decimal.js.
//
// The client's real rates are 4.5% / 5% / 6% then HAND-ROUNDED — rules alone
// will not reproduce their quotes, so a manual override (audit-logged in the
// service) is a first-class input, not an escape hatch. Composition order,
// which the R2 gate checks explicitly:  base → bundle → duration → override.
// The override, when present, REPLACES the computed figure (it is the
// hand-rounded number the client actually quotes).

import { Decimal, money, roundMoney } from "../money.js";

/** #30 — discount by number of units rented together. Highest matching tier wins. */
export interface BundleTier {
  minUnits: number;
  discountPct: number; // e.g. 5 for 5%
}

/** #31 — discount by committed duration in whole months (6/12/24). Highest wins. */
export interface DurationTier {
  minMonths: number;
  discountPct: number;
}

export interface PriceComposition {
  base: Decimal;
  bundlePct: number;
  durationPct: number;
  /** base after bundle + duration discounts, rounded. */
  computed: Decimal;
  /** the manual override, if supplied (#32). */
  override: Decimal | null;
  /** what actually gets billed: override ?? computed. */
  final: Decimal;
}

function highestTierPct<T extends { discountPct: number }>(
  tiers: readonly T[],
  matches: (t: T) => boolean,
): number {
  return tiers.filter(matches).reduce((best, t) => Math.max(best, t.discountPct), 0);
}

/** The bundle discount percentage that applies for `unitCount` units. */
export function bundleDiscount(unitCount: number, tiers: readonly BundleTier[]): number {
  return highestTierPct(tiers, (t) => unitCount >= t.minUnits);
}

/** The duration discount percentage that applies for `months` months. */
export function durationDiscount(months: number, tiers: readonly DurationTier[]): number {
  return highestTierPct(tiers, (t) => months >= t.minMonths);
}

/** #32 — apply a manual override, returning it as money. Null passes through. */
export function applyPriceOverride(override: Decimal.Value | null | undefined): Decimal | null {
  if (override === null || override === undefined) return null;
  return roundMoney(money(override));
}

export interface ComposeMonthlyRateParams {
  /** Base monthly rate for one unit, before any discount. */
  baseRate: Decimal.Value;
  unitCount: number;
  months: number;
  bundleTiers?: readonly BundleTier[];
  durationTiers?: readonly DurationTier[];
  /** #32 — hand-rounded figure the client quotes; wins over the computed rate. */
  override?: Decimal.Value | null;
}

/**
 * Compose the effective monthly rate: base × unitCount, less the best bundle
 * discount, less the best duration discount, rounded — then the manual override
 * replaces it if given. Order is fixed (bundle → duration → override) so the
 * result is deterministic and matches the R2 gate's worked example.
 */
export function composeMonthlyRate(params: ComposeMonthlyRateParams): PriceComposition {
  const { baseRate, unitCount, months, bundleTiers = [], durationTiers = [], override } = params;
  const base = money(baseRate).times(unitCount);
  const bundlePct = bundleDiscount(unitCount, bundleTiers);
  const durationPct = durationDiscount(months, durationTiers);

  const afterBundle = base.times(money(100).minus(bundlePct)).dividedBy(100);
  const afterDuration = afterBundle.times(money(100).minus(durationPct)).dividedBy(100);
  const computed = roundMoney(afterDuration);

  const overrideMoney = applyPriceOverride(override);
  return {
    base: roundMoney(base),
    bundlePct,
    durationPct,
    computed,
    override: overrideMoney,
    final: overrideMoney ?? computed,
  };
}
