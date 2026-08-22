import { Decimal, money, roundMoney } from "../money.js";

/**
 * AR aging with a forward horizon (PRD v2 §5.2): as of a chosen date,
 * what's already overdue (bucketed by days past due, the classic report)
 * AND what's coming due inside the next 30/60/90 days (bucketed by days
 * until due). The forward half is what a fixed-term payment schedule
 * makes possible — every future cycle exists as a SCHEDULED invoice.
 *
 * Pure: takes the unpaid invoices and returns Decimal strings, so the
 * reporting endpoint is a thin query + this function.
 */

export interface ReceivableLike {
  totalAmount: Decimal | string | number;
  dueDate: Date;
  /** ISSUED | OVERDUE | SCHEDULED — anything else should be filtered out by the caller. */
  status: string;
}

export interface ArAgingBuckets {
  asOf: string;
  horizonDays: number;
  overdue: { current: string; d1_30: string; d31_60: string; d60_plus: string; total: string };
  /** Due strictly after asOf, within the horizon. Buckets are days-until-due; beyond-horizon is reported but not bucketed. */
  comingDue: { d0_30: string; d31_60: string; d61_90: string; total: string; beyondHorizon: string };
  totalOutstanding: string;
  invoiceCount: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / MS_PER_DAY);
}

export function bucketReceivables(invoices: readonly ReceivableLike[], asOf: Date, horizonDays: number): ArAgingBuckets {
  const overdue = { current: money(0), d1_30: money(0), d31_60: money(0), d60_plus: money(0) };
  const coming = { d0_30: money(0), d31_60: money(0), d61_90: money(0), beyond: money(0) };
  let count = 0;

  for (const inv of invoices) {
    const amount = money(inv.totalAmount instanceof Decimal ? inv.totalAmount : inv.totalAmount.toString());
    const daysPastDue = daysBetween(asOf, inv.dueDate);
    count += 1;
    if (daysPastDue >= 0) {
      // Due today or earlier — the classic aging buckets. "current" = due today (0 days past).
      if (daysPastDue === 0) overdue.current = overdue.current.plus(amount);
      else if (daysPastDue <= 30) overdue.d1_30 = overdue.d1_30.plus(amount);
      else if (daysPastDue <= 60) overdue.d31_60 = overdue.d31_60.plus(amount);
      else overdue.d60_plus = overdue.d60_plus.plus(amount);
      continue;
    }
    const daysUntilDue = -daysPastDue;
    if (daysUntilDue > horizonDays) coming.beyond = coming.beyond.plus(amount);
    else if (daysUntilDue <= 30) coming.d0_30 = coming.d0_30.plus(amount);
    else if (daysUntilDue <= 60) coming.d31_60 = coming.d31_60.plus(amount);
    else coming.d61_90 = coming.d61_90.plus(amount);
  }

  const overdueTotal = overdue.current.plus(overdue.d1_30).plus(overdue.d31_60).plus(overdue.d60_plus);
  const comingTotal = coming.d0_30.plus(coming.d31_60).plus(coming.d61_90);
  const s = (d: Decimal) => roundMoney(d).toString();
  return {
    asOf: asOf.toISOString(),
    horizonDays,
    overdue: { current: s(overdue.current), d1_30: s(overdue.d1_30), d31_60: s(overdue.d31_60), d60_plus: s(overdue.d60_plus), total: s(overdueTotal) },
    comingDue: { d0_30: s(coming.d0_30), d31_60: s(coming.d31_60), d61_90: s(coming.d61_90), total: s(comingTotal), beyondHorizon: s(coming.beyond) },
    totalOutstanding: s(overdueTotal.plus(comingTotal).plus(coming.beyond)),
    invoiceCount: count,
  };
}
