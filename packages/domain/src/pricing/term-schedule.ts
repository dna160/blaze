/**
 * Fixed-term monthly payment schedule (PRD v2 D1 / §8).
 *
 * A term of N months starting on `startDate` is N consecutive periods, each
 * exactly one calendar month long counted from the start day-of-month —
 * never a calendar month, never prorated. Period k runs
 * [start + k months, start + (k+1) months). Each period has one invoice:
 * index 0 is the proforma (issued at contract time, due before move-in);
 * 1..N-1 are created SCHEDULED and issued `leadDays` before their due date
 * (= the period start).
 *
 * Day-of-month is clamped for short months (a lease starting Jan 31 has
 * its February period start on Feb 28/29), matching `nextAnchorDate`'s
 * existing convention for the legacy indefinite lease.
 */

export const TERM_OPTIONS_MONTHS = [1, 3, 6, 12] as const;
export type TermMonths = (typeof TERM_OPTIONS_MONTHS)[number];

export function isValidTermMonths(value: unknown): value is TermMonths {
  return typeof value === "number" && (TERM_OPTIONS_MONTHS as readonly number[]).includes(value);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `from` + `months`, clamped to the last day of the target month (Jan 31 + 1 month = Feb 28). Time-of-day is preserved. */
export function addMonthsClamped(from: Date, months: number): Date {
  const year = from.getFullYear();
  const month = from.getMonth() + months;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const daysInTarget = new Date(targetYear, targetMonth + 1, 0).getDate();
  const day = Math.min(from.getDate(), daysInTarget);
  return new Date(targetYear, targetMonth, day, from.getHours(), from.getMinutes(), from.getSeconds(), from.getMilliseconds());
}

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * MS_PER_DAY);
}

/** Exclusive end of a term: start + N months. */
export function termEndDate(startDate: Date, termMonths: number): Date {
  return addMonthsClamped(startDate, termMonths);
}

export interface SchedulePeriod {
  /** 0 = proforma (first month), 1..N-1 = monthly cycles. */
  index: number;
  /** Inclusive. */
  periodStart: Date;
  /** Inclusive — the day before the next period starts (matches `periodEndFor`'s convention). */
  periodEnd: Date;
  /** Exclusive start of the next period; what `termEndDate` returns for the last one. */
  nextPeriodStart: Date;
  /** When the invoice becomes payable — the period start for cycles; for index 0 see `proformaDueDate`. */
  dueDate: Date;
  /** When the invoice should be issued (moves SCHEDULED -> ISSUED): dueDate - leadDays, never before `issuedOn`. */
  issueDate: Date;
}

export interface TermScheduleOptions {
  /** Days before each cycle's due date that its invoice is issued. PRD §8.2 default 7. */
  leadDays?: number;
  /** The day the schedule is generated (contract time) — the proforma's issue date. Defaults to now. */
  issuedOn?: Date;
  /** Days the customer gets to pay the proforma when move-in is further out than that. Default 7. */
  proformaPaymentDays?: number;
}

/** Proforma is due before move-in: the earlier of (issue + N days) and the move-in day, but never before the issue day itself. */
export function proformaDueDate(issuedOn: Date, startDate: Date, proformaPaymentDays = 7): Date {
  const plusDays = addDays(issuedOn, proformaPaymentDays);
  const earlier = startDate.getTime() < plusDays.getTime() ? startDate : plusDays;
  return earlier.getTime() < issuedOn.getTime() ? issuedOn : earlier;
}

export function computeTermSchedule(startDate: Date, termMonths: number, options: TermScheduleOptions = {}): SchedulePeriod[] {
  if (!Number.isInteger(termMonths) || termMonths < 1) {
    throw new Error(`termMonths must be a positive integer, got ${termMonths}.`);
  }
  const leadDays = options.leadDays ?? 7;
  const issuedOn = options.issuedOn ?? new Date();
  const periods: SchedulePeriod[] = [];
  for (let k = 0; k < termMonths; k++) {
    const periodStart = addMonthsClamped(startDate, k);
    const nextPeriodStart = addMonthsClamped(startDate, k + 1);
    const periodEnd = addDays(nextPeriodStart, -1);
    const dueDate = k === 0 ? proformaDueDate(issuedOn, startDate, options.proformaPaymentDays) : periodStart;
    const lead = addDays(dueDate, -leadDays);
    const issueDate = k === 0 ? issuedOn : lead.getTime() < issuedOn.getTime() ? issuedOn : lead;
    periods.push({ index: k, periodStart, periodEnd, nextPeriodStart, dueDate, issueDate });
  }
  return periods;
}
