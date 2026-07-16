import { Decimal, roundMoney } from "../money.js";

export type ProrationRule = "ANCHOR_DATE" | "FULL_FIRST_PERIOD";

export interface ProrationResult {
  amount: Decimal;
  daysCharged: number;
  daysInMonth: number;
  /** The billing anchor day going forward — day-of-month invoices recur on. */
  anchorDay: number;
}

/**
 * "Prorated first month (tenant-configurable: anchor-date proration vs
 * full first month)" — PRD §7.1.2.
 *
 * ANCHOR_DATE: charge only the remaining days of the calendar month the
 * lease starts in, at a daily rate of basePrice / daysInThatMonth. The
 * anchor day for all future cycles is the day-of-month the lease started
 * on (clamped by nextAnchorDate() for short months).
 *
 * FULL_FIRST_PERIOD: charge the full monthly base price regardless of
 * start day; the anchor day becomes the 1st, so cycles align to calendar
 * months rather than the move-in date.
 */
export function prorateFirstPeriod(
  basePrice: Decimal,
  startDate: Date,
  rule: ProrationRule,
): ProrationResult {
  const daysInMonth = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0).getDate();

  if (rule === "FULL_FIRST_PERIOD") {
    return { amount: roundMoney(basePrice), daysCharged: daysInMonth, daysInMonth, anchorDay: 1 };
  }

  const startDay = startDate.getDate();
  const daysCharged = daysInMonth - startDay + 1;
  const amount = roundMoney(basePrice.mul(daysCharged).div(daysInMonth));
  return { amount, daysCharged, daysInMonth, anchorDay: startDay };
}

/**
 * Next billing anchor date on/after `from`, for the given day-of-month
 * anchor. Clamps to the last day of a short month (e.g. anchorDay=31 in
 * February resolves to Feb 28/29) rather than overflowing into March —
 * that overflow is the classic date-math bug this function exists to rule
 * out.
 */
export function nextAnchorDate(anchorDay: number, from: Date): Date {
  const year = from.getMonth() === 11 ? from.getFullYear() + 1 : from.getFullYear();
  const month = (from.getMonth() + 1) % 12;
  const daysInTargetMonth = new Date(year, month + 1, 0).getDate();
  const clampedDay = Math.min(anchorDay, daysInTargetMonth);
  return new Date(year, month, clampedDay);
}

/** Exclusive end of the billing period that starts at `periodStart` for the given anchor. */
export function periodEndFor(periodStart: Date, anchorDay: number): Date {
  const end = nextAnchorDate(anchorDay, periodStart);
  end.setDate(end.getDate() - 1);
  return end;
}
