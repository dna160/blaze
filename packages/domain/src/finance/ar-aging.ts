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

/** Where one unpaid invoice sits in the aging report (PRD go-live 2 §2.5 — the drill-down and `ar-aging.csv`). */
export type ArAgingBucket =
  | "overdue_current"
  | "overdue_1_30"
  | "overdue_31_60"
  | "overdue_60_plus"
  | "coming_0_30"
  | "coming_31_60"
  | "coming_61_90"
  | "beyond_horizon";

export const AR_AGING_BUCKETS: readonly ArAgingBucket[] = [
  "overdue_current",
  "overdue_1_30",
  "overdue_31_60",
  "overdue_60_plus",
  "coming_0_30",
  "coming_31_60",
  "coming_61_90",
  "beyond_horizon",
];

/**
 * The bucket for an invoice that is `daysPastDue` days past its due date as of
 * the report date (0 = due that day, negative = not yet due). The ONE rule both
 * the bucket totals and the invoice rows use, so a bucket always equals the
 * sum of the rows under it.
 */
export function classifyReceivable(daysPastDue: number, horizonDays: number): ArAgingBucket {
  if (daysPastDue >= 0) {
    if (daysPastDue === 0) return "overdue_current";
    if (daysPastDue <= 30) return "overdue_1_30";
    if (daysPastDue <= 60) return "overdue_31_60";
    return "overdue_60_plus";
  }
  const daysUntilDue = -daysPastDue;
  if (daysUntilDue > horizonDays) return "beyond_horizon";
  if (daysUntilDue <= 30) return "coming_0_30";
  if (daysUntilDue <= 60) return "coming_31_60";
  return "coming_61_90";
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
    count += 1;
    // Due today or earlier — the classic aging buckets ("current" = due today, 0 days past);
    // otherwise days until due, against the horizon.
    switch (classifyReceivable(daysBetween(asOf, inv.dueDate), horizonDays)) {
      case "overdue_current":
        overdue.current = overdue.current.plus(amount);
        break;
      case "overdue_1_30":
        overdue.d1_30 = overdue.d1_30.plus(amount);
        break;
      case "overdue_31_60":
        overdue.d31_60 = overdue.d31_60.plus(amount);
        break;
      case "overdue_60_plus":
        overdue.d60_plus = overdue.d60_plus.plus(amount);
        break;
      case "coming_0_30":
        coming.d0_30 = coming.d0_30.plus(amount);
        break;
      case "coming_31_60":
        coming.d31_60 = coming.d31_60.plus(amount);
        break;
      case "coming_61_90":
        coming.d61_90 = coming.d61_90.plus(amount);
        break;
      case "beyond_horizon":
        coming.beyond = coming.beyond.plus(amount);
        break;
    }
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
