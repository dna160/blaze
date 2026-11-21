/**
 * PRD go-live 2 §2.1 — the ONE date-range convention every report and export
 * uses.
 *
 * `from` and `to` are INCLUSIVE calendar dates in the branch's timezone
 * (`Tenant.timezone`, Asia/Jakarta for City Storage). They become the
 * half-open instant window [from 00:00 local, to+1 00:00 local), which is what
 * a query filters on. A payment at 2026-11-01 06:30 WIB (2026-10-31 23:30 UTC)
 * therefore falls in November — the bug this replaces computed month
 * boundaries with Date.UTC.
 *
 * Lives in @rentos/contracts (not packages/domain, where the PRD pencilled it)
 * because the console's range control needs the very same presets and
 * conversion as the API: one implementation, shared by both.
 *
 * Pure: no framework, no Date.now() unless `now` is omitted from a preset.
 */

export type ReportRangePreset =
  | "today"
  | "yesterday"
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "custom";

export const REPORT_RANGE_PRESETS: readonly ReportRangePreset[] = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "this_quarter",
  "custom",
];

/** Indonesian first (PRD §2.1), English second. */
export const REPORT_RANGE_PRESET_LABELS: Readonly<Record<ReportRangePreset, { id: string; en: string }>> = {
  today: { id: "Hari ini", en: "Today" },
  yesterday: { id: "Kemarin", en: "Yesterday" },
  this_week: { id: "Minggu ini", en: "This week" },
  last_week: { id: "Minggu lalu", en: "Last week" },
  this_month: { id: "Bulan ini", en: "This month" },
  last_month: { id: "Bulan lalu", en: "Last month" },
  this_quarter: { id: "Kuartal ini", en: "This quarter" },
  custom: { id: "Rentang khusus", en: "Custom" },
};

export interface ReportRange {
  /** Inclusive first day, YYYY-MM-DD in the branch timezone. */
  from: string;
  /** Inclusive last day, YYYY-MM-DD in the branch timezone. */
  to: string;
  /** `from` 00:00 in the branch timezone, as an instant. */
  start: Date;
  /** The day after `to`, 00:00 in the branch timezone — exclusive. */
  endExclusive: Date;
  timeZone: string;
}

export class ReportRangeError extends Error {}

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Ymd {
  year: number;
  month: number;
  day: number;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function ymdString(d: Ymd): string {
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
}

function parseYmd(value: string, label: string): Ymd {
  const m = ISO_DATE.exec(value);
  if (!m) throw new ReportRangeError(`${label} must be a date as YYYY-MM-DD.`);
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const check = new Date(Date.UTC(d.year, d.month - 1, d.day));
  if (check.getUTCFullYear() !== d.year || check.getUTCMonth() !== d.month - 1 || check.getUTCDate() !== d.day) {
    throw new ReportRangeError(`${label} is not a real calendar date.`);
  }
  return d;
}

/** Calendar arithmetic on a plain date (no timezone involved). */
function addDays(d: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day) + days * DAY_MS);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

function zonedParts(at: Date, timeZone: string): Ymd & { hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: n("year"), month: n("month"), day: n("day"), hour: n("hour"), minute: n("minute"), second: n("second") };
}

/** Minutes the zone is ahead of UTC at instant `at` (+420 for Asia/Jakarta). */
function offsetMinutes(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The instant at which the calendar day `d` begins in `timeZone`. */
export function zonedStartOfDay(d: Ymd | string, timeZone: string): Date {
  const ymd = typeof d === "string" ? parseYmd(d, "date") : d;
  const guess = Date.UTC(ymd.year, ymd.month - 1, ymd.day);
  // Two passes, so a day that starts just after a DST change is still right.
  let at = guess - offsetMinutes(new Date(guess), timeZone) * 60_000;
  at = guess - offsetMinutes(new Date(at), timeZone) * 60_000;
  return new Date(at);
}

/** The calendar date of an instant in `timeZone`, as YYYY-MM-DD. */
export function zonedDateString(at: Date, timeZone: string): string {
  return ymdString(zonedParts(at, timeZone));
}

/** `YYYY-MM-DD HH:mm` in `timeZone` — the timestamp format of every CSV (§2.4). */
export function zonedDateTimeString(at: Date, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${ymdString(p)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * Inclusive `from`/`to` calendar dates -> the half-open instant window.
 * Throws ReportRangeError on a malformed date, `to` before `from`, or a range
 * longer than `maxDays` (default five years — a guard, not a product limit).
 */
export function resolveReportRange(input: { from: string; to: string }, timeZone: string, maxDays = 1830): ReportRange {
  const from = parseYmd(input.from, "from");
  const to = parseYmd(input.to, "to");
  const days = (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) / DAY_MS + 1;
  if (days < 1) throw new ReportRangeError("to must not be before from.");
  if (days > maxDays) throw new ReportRangeError(`The range is too long (${days} days; at most ${maxDays}).`);
  return {
    from: ymdString(from),
    to: ymdString(to),
    start: zonedStartOfDay(from, timeZone),
    endExclusive: zonedStartOfDay(addDays(to, 1), timeZone),
    timeZone,
  };
}

/** The calendar dates a preset means on the day `now` falls on in `timeZone`. Weeks run Monday–Sunday. */
export function presetDates(preset: Exclude<ReportRangePreset, "custom">, timeZone: string, now: Date = new Date()): { from: string; to: string } {
  const today = zonedParts(now, timeZone);
  const t: Ymd = { year: today.year, month: today.month, day: today.day };
  // 0 = Monday … 6 = Sunday
  const weekday = (new Date(Date.UTC(t.year, t.month - 1, t.day)).getUTCDay() + 6) % 7;
  const monthEnd = (y: number, m: number): Ymd => ({ year: y, month: m, day: new Date(Date.UTC(y, m, 0)).getUTCDate() });
  const out = (a: Ymd, b: Ymd) => ({ from: ymdString(a), to: ymdString(b) });
  switch (preset) {
    case "today":
      return out(t, t);
    case "yesterday": {
      const y = addDays(t, -1);
      return out(y, y);
    }
    case "this_week":
      return out(addDays(t, -weekday), addDays(t, 6 - weekday));
    case "last_week":
      return out(addDays(t, -weekday - 7), addDays(t, -weekday - 1));
    case "this_month":
      return out({ ...t, day: 1 }, monthEnd(t.year, t.month));
    case "last_month": {
      const y = t.month === 1 ? t.year - 1 : t.year;
      const m = t.month === 1 ? 12 : t.month - 1;
      return out({ year: y, month: m, day: 1 }, monthEnd(y, m));
    }
    case "this_quarter": {
      const first = Math.floor((t.month - 1) / 3) * 3 + 1;
      return out({ year: t.year, month: first, day: 1 }, monthEnd(t.year, first + 2));
    }
  }
}

/** Which preset (if any) a pair of dates is, as of `now` — so the control can highlight it. */
export function matchPreset(dates: { from: string; to: string }, timeZone: string, now: Date = new Date()): ReportRangePreset {
  for (const p of REPORT_RANGE_PRESETS) {
    if (p === "custom") continue;
    const d = presetDates(p, timeZone, now);
    if (d.from === dates.from && d.to === dates.to) return p;
  }
  return "custom";
}

/** Every calendar day of the range, in order, as YYYY-MM-DD. */
export function daysInRange(range: Pick<ReportRange, "from" | "to">): string[] {
  const out: string[] = [];
  let d = parseYmd(range.from, "from");
  const end = range.to;
  for (;;) {
    const s = ymdString(d);
    out.push(s);
    if (s >= end) break;
    d = addDays(d, 1);
  }
  return out;
}

/**
 * The grouping key of an instant for `groupBy` in `timeZone`:
 * day -> YYYY-MM-DD, week -> the Monday's YYYY-MM-DD, month -> YYYY-MM.
 */
export function rangeBucket(at: Date, groupBy: "day" | "week" | "month", timeZone: string): string {
  const p = zonedParts(at, timeZone);
  const d: Ymd = { year: p.year, month: p.month, day: p.day };
  if (groupBy === "day") return ymdString(d);
  if (groupBy === "month") return `${pad(d.year, 4)}-${pad(d.month)}`;
  const weekday = (new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7;
  return ymdString(addDays(d, -weekday));
}
