export type CsvRow = Record<string, string | number | null>;

/** Minimal CSV writer — quotes any field containing a comma, quote, or newline (RFC 4180). */
export function toCsv(rows: CsvRow[], columns: readonly string[]): string {
  const escape = (value: string | number | null | undefined): string => {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((row) => columns.map((c) => escape(row[c])).join(","));
  return [columns.join(","), ...lines].join("\n");
}
