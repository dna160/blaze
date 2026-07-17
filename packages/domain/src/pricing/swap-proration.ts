import { Decimal, money, roundMoney } from "../money.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface SwapProrationParams {
  /** The rate the customer was paying before the swap (the current period's booked rate). */
  oldMonthlyRate: Decimal.Value;
  /** The rate on the unit type they're switching to. */
  newMonthlyRate: Decimal.Value;
  /** Bounds of the billing period the switch happens inside (from the booking's most recently PAID invoice). Both inclusive, matching `periodEndFor`'s convention (periodEnd is the last day of the period, not an exclusive boundary). */
  periodStart: Date;
  periodEnd: Date;
  /** When the swap was approved / the unit actually changed hands — counted as the first day on the new rate. */
  switchDate: Date;
}

export interface SwapProrationResult {
  daysInPeriod: number;
  /** Days left in the period from switchDate through periodEnd, inclusive of the switch day, clamped to [0, daysInPeriod]. */
  daysRemaining: number;
  /** Value of the remaining days at the old rate — what the customer already paid for but won't use on the old unit. */
  oldRateUnusedCredit: Decimal;
  /** Value of the remaining days at the new rate — what they actually owe for the rest of the period on the new unit. */
  newRateCharge: Decimal;
  /** newRateCharge - oldRateUnusedCredit. Positive: customer owes more (upgrade). Negative: customer is owed a credit (downsize). */
  netAdjustment: Decimal;
}

/**
 * PRD §7.1.4 persona table: "Grow/Shrink: swap request in portal →
 * prorated switch." A unit swap reassigns the asset immediately
 * (SwapRequestsService.approve), but the period already billed at the
 * old rate needs reconciling against the new one for whatever days
 * remain. This function only computes that reconciliation — it
 * deliberately does not generate an invoice or credit note itself. The
 * invoice model has no negative-amount convention (a downsize produces
 * a negative `netAdjustment`, which nothing downstream — payments,
 * dunning, the storefront UI — is built to represent as a real
 * Invoice), so automatically inventing one under this scope would be
 * building on an unproven assumption. Staff act on the computed number
 * with the tools that already exist: a manual credit note for a
 * downsize, a manual charge for an upgrade.
 */
export function computeSwapProration(params: SwapProrationParams): SwapProrationResult {
  // Both bounds are inclusive day-of, so a same-day period needs +1 to count as 1 day, not 0.
  const daysInPeriod = Math.round((params.periodEnd.getTime() - params.periodStart.getTime()) / MS_PER_DAY) + 1;
  const rawRemaining = Math.round((params.periodEnd.getTime() - params.switchDate.getTime()) / MS_PER_DAY) + 1;
  const daysRemaining = Math.max(0, Math.min(daysInPeriod, rawRemaining));

  const oldDailyRate = money(params.oldMonthlyRate).div(daysInPeriod);
  const newDailyRate = money(params.newMonthlyRate).div(daysInPeriod);

  const oldRateUnusedCredit = roundMoney(oldDailyRate.mul(daysRemaining));
  const newRateCharge = roundMoney(newDailyRate.mul(daysRemaining));
  const netAdjustment = newRateCharge.minus(oldRateUnusedCredit);

  return { daysInPeriod, daysRemaining, oldRateUnusedCredit, newRateCharge, netAdjustment };
}
