import { describe, expect, it } from "vitest";

import {
  CITY_STORAGE_NUMBERING,
  LEGACY_NUMBERING,
  counterScope,
  formatDocumentNumber,
  resolveNumbering,
  zonedDate,
  zonedYearMonth,
} from "../src/document-number.js";

const base = { branchCode: "KBJ", slug: "city-storage-kebon-jeruk", year: 2026, month: 11, customerNumber: 36, seq: 40 };

describe("formatDocumentNumber", () => {
  it("renders the PRD's original example format", () => {
    expect(formatDocumentNumber("{BRANCH}-{M}-{YYYY}-{CUST}-{SEQ}", base)).toBe("KBJ-11-2026-36-40");
  });

  it("keeps the legacy Booqable shape when {BRANCH}- is dropped", () => {
    expect(formatDocumentNumber("{M}-{YYYY}-{CUST}-{SEQ}", { ...base, month: 5, seq: 39 })).toBe("5-2026-36-39");
  });

  it("reproduces the pre-go-live invoice format byte for byte", () => {
    expect(formatDocumentNumber(LEGACY_NUMBERING.invoice, { ...base, seq: 1 })).toBe("CITY-STORAGE-KEBON-JERUK/2026/11/000001");
  });

  it("pads {MM} and {SEQ:n}", () => {
    expect(formatDocumentNumber("{MM}/{SEQ:4}", { ...base, month: 3, seq: 7 })).toBe("03/0007");
  });

  it("falls back to the slug when the tenant has no branch code, and 0 for an unknown customer", () => {
    expect(formatDocumentNumber("{BRANCH}-{CUST}", { ...base, branchCode: null, customerNumber: null })).toBe("CITY-STORAGE-KEBON-JERUK-0");
  });

  it("leaves unknown tokens alone rather than silently dropping them", () => {
    expect(formatDocumentNumber("{FOO}-{SEQ}", base)).toBe("{FOO}-40");
  });
});

describe("City Storage format (owner, 2026-11-10)", () => {
  const ctx = { ...base, day: 10, month: 11, year: 2026, seq: 40, contractSeq: 40 };
  it("contract: customer - DDMMYYYY - contract no - branch", () => {
    expect(formatDocumentNumber(CITY_STORAGE_NUMBERING.contract, ctx)).toBe("36-10112026-40-KBJ");
  });
  it("invoice: customer - DDMMYYYY - contract no - invoice no", () => {
    expect(formatDocumentNumber(CITY_STORAGE_NUMBERING.invoice, { ...ctx, seq: 123 })).toBe("36-10112026-40-123");
  });
  it("pads the day and month, and prints 0 for an invoice without a contract", () => {
    expect(formatDocumentNumber(CITY_STORAGE_NUMBERING.invoice, { ...ctx, day: 1, month: 3, contractSeq: null, seq: 5 })).toBe("36-01032026-0-5");
  });
});

describe("zonedDate", () => {
  it("reads the day in the tenant's timezone", () => {
    expect(zonedDate(new Date("2026-10-31T23:00:00Z"), "Asia/Jakarta")).toEqual({ year: 2026, month: 11, day: 1 });
  });
});

describe("zonedYearMonth", () => {
  it("uses the tenant's month: 06:00 WIB on the 1st is still the previous day in UTC", () => {
    const at = new Date("2026-10-31T23:00:00Z"); // 2026-11-01 06:00 WIB
    expect(zonedYearMonth(at, "Asia/Jakarta")).toEqual({ year: 2026, month: 11 });
    expect(zonedYearMonth(at, "UTC")).toEqual({ year: 2026, month: 10 });
  });

  it("rolls the year in the tenant's timezone", () => {
    expect(zonedYearMonth(new Date("2026-12-31T18:30:00Z"), "Asia/Jakarta")).toEqual({ year: 2027, month: 1 });
  });
});

describe("resolveNumbering / counterScope", () => {
  it("defaults an unconfigured tenant to the legacy monthly sequence", () => {
    expect(resolveNumbering({})).toEqual(LEGACY_NUMBERING);
    expect(resolveNumbering(null).seqReset).toBe("monthly");
  });

  it("defaults a configured tenant without a reset policy to a running counter", () => {
    expect(resolveNumbering({ invoice: "{BRANCH}-{SEQ}" }).seqReset).toBe("never");
  });

  it("maps reset policies to counter scopes", () => {
    const ym = { year: 2026, month: 3 };
    expect(counterScope("never", ym)).toBe("all");
    expect(counterScope("yearly", ym)).toBe("2026");
    expect(counterScope("monthly", ym)).toBe("2026-03");
  });
});
