// BUILD-SPEC C3 — monthly-only billing guard (City Storage).
//
// The client's minimum AND maximum billing unit is one month. No daily rental,
// no partial-month proration for rental orders. Odd durations round to whole
// months at the INPUT layer (the UI only lets a customer pick whole months);
// the DOMAIN is strict: any code path that could produce a non-integer month
// count throws rather than round silently. DAILY/WEEKLY are not deleted (a
// future hotel/venue tenant needs them) — they are gated behind a per-tenant
// feature flag defaulted OFF.

export type BillingUnit = "MONTH" | "WEEK" | "DAY";

export class NonIntegerMonthError extends Error {
  constructor(start: Date, end: Date) {
    super(
      `Rental period ${start.toISOString()} → ${end.toISOString()} is not a whole number of months. ` +
        `City Storage bills whole months only (BUILD-SPEC C3); the caller must round the period to a month boundary before pricing.`,
    );
    this.name = "NonIntegerMonthError";
  }
}

export class SubMonthlyDisabledError extends Error {
  constructor(unit: BillingUnit) {
    super(
      `Billing unit "${unit}" is disabled for this tenant. Enable featureFlags.allowSubMonthly to use DAILY/WEEKLY (BUILD-SPEC C3, default off).`,
    );
    this.name = "SubMonthlyDisabledError";
  }
}

/** Add `months` calendar months to `d`, clamping the day (Jan 31 +1 → Feb 28/29). */
function addMonths(d: Date, months: number): Date {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(year, month, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

const MAX_MONTHS = 240; // 20 years — a sane upper bound for the search loop.

/**
 * The whole number of months between two dates, or throw. `end` must be exactly
 * `start` advanced by an integer number of months (day-of-month preserved, with
 * end-of-month clamping). Anything else is a non-integer month count and throws.
 */
export function wholeMonthsBetween(start: Date, end: Date): number {
  if (end.getTime() <= start.getTime()) {
    throw new NonIntegerMonthError(start, end);
  }
  for (let n = 1; n <= MAX_MONTHS; n++) {
    const candidate = addMonths(start, n);
    if (candidate.getTime() === end.getTime()) return n;
    if (candidate.getTime() > end.getTime()) break; // overshot — not a whole month
  }
  throw new NonIntegerMonthError(start, end);
}

/** Same as wholeMonthsBetween but named for use as an assertion at pricing time. */
export function assertWholeMonths(start: Date, end: Date): number {
  return wholeMonthsBetween(start, end);
}

/** The period end for a whole-month rental starting at `start` for `months` months. */
export function monthlyPeriodEnd(start: Date, months: number): Date {
  if (!Number.isInteger(months) || months < 1) {
    throw new NonIntegerMonthError(start, start);
  }
  return addMonths(start, months);
}

/**
 * Throws unless the requested billing unit is allowed for this tenant. MONTH is
 * always allowed; WEEK/DAY require featureFlags.allowSubMonthly === true.
 */
export function assertBillingUnitAllowed(unit: BillingUnit, allowSubMonthly: boolean | undefined): void {
  if (unit === "MONTH") return;
  if (!allowSubMonthly) throw new SubMonthlyDisabledError(unit);
}
