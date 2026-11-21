import { zonedDateString, zonedDateTimeString } from "@rentos/contracts";

export type CsvRow = Record<string, string | number | null | undefined>;

/** Minimal CSV writer — quotes any field containing a comma, quote, or newline (RFC 4180). */
export function toCsv(rows: CsvRow[], columns: readonly string[]): string {
  const escape = (value: string | number | null | undefined): string => {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((row) => columns.map((c) => escape(row[c])).join(","));
  return [columns.join(","), ...lines].join("\n");
}

/**
 * PRD go-live 2 §2.4 — the conventions every export follows, so a sheet built
 * on one CSV works on the next:
 *  - amounts are plain integers in rupiah, no thousands separator (they sum in
 *    Sheets and Excel);
 *  - dates are YYYY-MM-DD and timestamps YYYY-MM-DD HH:mm, in the BRANCH's
 *    timezone (WIB for City Storage), never UTC;
 *  - the file is `{branchCode}_{report}_{from}_{to}.csv`.
 */

/** A money value as whole rupiah. Accepts Prisma Decimals, strings and numbers. */
export function csvAmount(value: { toString(): string } | string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value.toString());
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** The calendar date of an instant in the branch timezone. */
export function csvDate(at: Date | string | null | undefined, timeZone: string): string | null {
  if (!at) return null;
  const d = typeof at === "string" ? new Date(at) : at;
  return Number.isNaN(d.getTime()) ? null : zonedDateString(d, timeZone);
}

/**
 * A stored calendar date (kept at 00:00 UTC, e.g. dueDate, periodStart) —
 * printed as that date, without shifting it across a timezone.
 */
export function csvCalendarDate(at: Date | string | null | undefined): string | null {
  if (!at) return null;
  const d = typeof at === "string" ? new Date(at) : at;
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD HH:mm` in the branch timezone. */
export function csvDateTime(at: Date | string | null | undefined, timeZone: string): string | null {
  if (!at) return null;
  const d = typeof at === "string" ? new Date(at) : at;
  return Number.isNaN(d.getTime()) ? null : zonedDateTimeString(d, timeZone);
}

/** `{branchCode}_{report}_{from}_{to}.csv` — the branch code falls back to the slug. */
export function csvFilename(branch: { branchCode: string | null; slug: string }, report: string, range?: { from: string; to: string } | null): string {
  const code = (branch.branchCode || branch.slug).replace(/[^A-Za-z0-9-]/g, "");
  return range ? `${code}_${report}_${range.from}_${range.to}.csv` : `${code}_${report}.csv`;
}

/** The UTF-8 byte-order mark Excel needs to read a CSV as UTF-8. */
export const CSV_BOM = "\uFEFF";
