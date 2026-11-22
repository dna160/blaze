/**
 * PRD go-live 2 §10.3 (part 1 §14) — the money rules from City Storage's T&C,
 * each behind its own per-branch switch, all OFF unless the branch turns them
 * on (`Tenant.featureFlags.moneyRules`). Amounts and limits are config, not
 * code; the defaults are the T&C's own numbers:
 *
 *  - late fee (V.3): 1% of the bill per day late, at most 14 days;
 *  - overstay (VI.4): 1% of the monthly rent per day after the lease ends
 *    until the unit is vacated, at most 30 days;
 *  - overtime access (II.8): Rp 50.000 per hour outside opening hours;
 *  - deposit refund (IV.3): returned within 30 days after the lease ends —
 *    a task is raised when that date passes and the deposit is still held;
 *  - no access while in arrears (V.5, VI.7): the front desk sees "Akses
 *    ditolak — tunggakan" once an invoice is overdue beyond a threshold.
 *
 * Pure: no database, no clock unless given.
 */
import { Decimal, money, roundMoney } from "../money.js";

export interface MoneyRulesConfig {
  lateFee: { enabled: boolean; ratePerDay: number; maxDays: number };
  overstay: { enabled: boolean; ratePerDay: number; maxDays: number };
  overtime: { enabled: boolean; hourlyRate: number };
  depositRefundTask: { enabled: boolean; days: number };
  arrearsBadge: { enabled: boolean; thresholdDays: number };
}

export const DEFAULT_MONEY_RULES: MoneyRulesConfig = {
  lateFee: { enabled: false, ratePerDay: 0.01, maxDays: 14 },
  overstay: { enabled: false, ratePerDay: 0.01, maxDays: 30 },
  overtime: { enabled: false, hourlyRate: 50_000 },
  depositRefundTask: { enabled: false, days: 30 },
  arrearsBadge: { enabled: false, thresholdDays: 1 },
};

/** Invoice line types the rules add (InvoiceLine.lineType is free text). */
export const LATE_FEE_LINE = "LATE_FEE";
export const OVERSTAY_FEE_LINE = "OVERSTAY_FEE";
export const OVERTIME_LINE = "OVERTIME";
export const FEE_LINE_TYPES: readonly string[] = [LATE_FEE_LINE, OVERSTAY_FEE_LINE, OVERTIME_LINE];

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The branch's rules from `featureFlags.moneyRules`; anything missing or out of range falls back to the default (and OFF). */
export function resolveMoneyRules(featureFlags: unknown): MoneyRulesConfig {
  const m = obj(obj(featureFlags).moneyRules);
  const d = DEFAULT_MONEY_RULES;
  const late = obj(m.lateFee);
  const over = obj(m.overstay);
  const ot = obj(m.overtime);
  const dep = obj(m.depositRefundTask);
  const arr = obj(m.arrearsBadge);
  return {
    lateFee: { enabled: late.enabled === true, ratePerDay: num(late.ratePerDay, d.lateFee.ratePerDay, 0, 0.1), maxDays: num(late.maxDays, d.lateFee.maxDays, 1, 90) },
    overstay: { enabled: over.enabled === true, ratePerDay: num(over.ratePerDay, d.overstay.ratePerDay, 0, 0.1), maxDays: num(over.maxDays, d.overstay.maxDays, 1, 180) },
    overtime: { enabled: ot.enabled === true, hourlyRate: num(ot.hourlyRate, d.overtime.hourlyRate, 0, 10_000_000) },
    depositRefundTask: { enabled: dep.enabled === true, days: num(dep.days, d.depositRefundTask.days, 0, 365) },
    arrearsBadge: { enabled: arr.enabled === true, thresholdDays: num(arr.thresholdDays, d.arrearsBadge.thresholdDays, 0, 365) },
  };
}

/** Whole calendar days from `from` to `to` (dates compared as YYYY-MM-DD strings, e.g. in WIB). */
export function calendarDaysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/**
 * Daily penalty lines that SHOULD exist after `daysLate` days, given that
 * `alreadyCharged` exist: the day numbers still to charge (1-based), each
 * at `base × rate` rounded to whole rupiah. Catches up missed days, never
 * passes `maxDays`, never charges twice.
 */
export function penaltyDaysToCharge(daysLate: number, alreadyCharged: number, maxDays: number): number[] {
  const upTo = Math.min(Math.max(0, Math.floor(daysLate)), maxDays);
  const out: number[] = [];
  for (let day = alreadyCharged + 1; day <= upTo; day++) out.push(day);
  return out;
}

/** One day's penalty: `base × ratePerDay`, whole rupiah (half up). */
export function dailyPenalty(base: Decimal.Value, ratePerDay: number): Decimal {
  return roundMoney(money(base).times(ratePerDay)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

/**
 * The "bill" a late fee is a percentage of: the invoice's lines without
 * deposits, tax and earlier penalty/charge lines (so the fee never compounds).
 */
export function penaltyBase(lines: ReadonlyArray<{ lineType: string; amount: Decimal.Value }>): Decimal {
  return lines
    .filter((l) => l.lineType !== "DEPOSIT" && l.lineType !== "TAX" && !FEE_LINE_TYPES.includes(l.lineType))
    .reduce((sum, l) => sum.plus(money(l.amount)), money(0));
}

/** Overtime charge: hours × hourly rate (hours may be fractional, e.g. 1.5), whole rupiah. */
export function overtimeCharge(hours: number, hourlyRate: number): Decimal {
  if (!(hours > 0) || hours > 24 * 31) throw new RangeError("Hours must be more than 0 and at most a month.");
  return money(hourlyRate).times(hours).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

/**
 * "Akses ditolak — tunggakan": arrears when any unpaid invoice is overdue by
 * more than `thresholdDays` days as of `today` (YYYY-MM-DD, branch timezone).
 */
export function arrearsStatus(
  unpaidDueDates: readonly string[],
  today: string,
  thresholdDays: number,
): { denied: boolean; oldestDueDate: string | null; daysOverdue: number; overdueCount: number } {
  const overdue = unpaidDueDates.filter((d) => calendarDaysBetween(d, today) > 0).sort();
  const oldest = overdue[0] ?? null;
  const days = oldest ? calendarDaysBetween(oldest, today) : 0;
  return { denied: oldest !== null && days > thresholdDays, oldestDueDate: oldest, daysOverdue: days, overdueCount: overdue.length };
}
