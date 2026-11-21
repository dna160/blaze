import { describe, expect, it } from "vitest";

import {
  daysInRange,
  matchPreset,
  presetDates,
  rangeBucket,
  ReportRangeError,
  resolveReportRange,
  zonedDateString,
  zonedDateTimeString,
} from "../src/report-range.js";

const WIB = "Asia/Jakarta";

describe("resolveReportRange", () => {
  it("turns inclusive WIB dates into a half-open instant window", () => {
    const r = resolveReportRange({ from: "2026-11-01", to: "2026-11-17" }, WIB);
    expect(r.start.toISOString()).toBe("2026-10-31T17:00:00.000Z");
    expect(r.endExclusive.toISOString()).toBe("2026-11-17T17:00:00.000Z");
  });

  it("puts a payment at 06:30 WIB on 1 Nov (23:30 UTC on 31 Oct) in November, not October", () => {
    const paidAt = new Date("2026-10-31T23:30:00.000Z");
    const nov = resolveReportRange({ from: "2026-11-01", to: "2026-11-30" }, WIB);
    const oct = resolveReportRange({ from: "2026-10-01", to: "2026-10-31" }, WIB);
    expect(paidAt >= nov.start && paidAt < nov.endExclusive).toBe(true);
    expect(paidAt >= oct.start && paidAt < oct.endExclusive).toBe(false);
    expect(zonedDateString(paidAt, WIB)).toBe("2026-11-01");
    expect(zonedDateTimeString(paidAt, WIB)).toBe("2026-11-01 06:30");
  });

  it("accepts a single day and rejects nonsense", () => {
    const r = resolveReportRange({ from: "2026-11-17", to: "2026-11-17" }, WIB);
    expect(r.endExclusive.getTime() - r.start.getTime()).toBe(86_400_000);
    expect(() => resolveReportRange({ from: "2026-11-18", to: "2026-11-17" }, WIB)).toThrow(ReportRangeError);
    expect(() => resolveReportRange({ from: "2026-02-30", to: "2026-03-01" }, WIB)).toThrow(ReportRangeError);
    expect(() => resolveReportRange({ from: "17/11/2026", to: "2026-11-17" }, WIB)).toThrow(ReportRangeError);
    expect(() => resolveReportRange({ from: "2010-01-01", to: "2026-11-17" }, WIB)).toThrow(ReportRangeError);
  });

  it("handles a zone with daylight saving", () => {
    // Europe/Amsterdam leaves DST on 2026-10-25: that local day is 25 hours long.
    const r = resolveReportRange({ from: "2026-10-25", to: "2026-10-25" }, "Europe/Amsterdam");
    expect(r.start.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(r.endExclusive.toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });
});

describe("presets", () => {
  // Tuesday 17 November 2026, 09:00 WIB.
  const now = new Date("2026-11-17T02:00:00.000Z");

  it("means the dates the labels say, Monday to Sunday", () => {
    expect(presetDates("today", WIB, now)).toEqual({ from: "2026-11-17", to: "2026-11-17" });
    expect(presetDates("yesterday", WIB, now)).toEqual({ from: "2026-11-16", to: "2026-11-16" });
    expect(presetDates("this_week", WIB, now)).toEqual({ from: "2026-11-16", to: "2026-11-22" });
    expect(presetDates("last_week", WIB, now)).toEqual({ from: "2026-11-09", to: "2026-11-15" });
    expect(presetDates("this_month", WIB, now)).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(presetDates("last_month", WIB, now)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(presetDates("this_quarter", WIB, now)).toEqual({ from: "2026-10-01", to: "2026-12-31" });
  });

  it("uses the branch's day, not the server's", () => {
    // 23:30 UTC on the 16th is already the 17th in Jakarta.
    expect(presetDates("today", WIB, new Date("2026-11-16T23:30:00.000Z")).from).toBe("2026-11-17");
    // January: last month is December of the year before.
    expect(presetDates("last_month", WIB, new Date("2027-01-05T05:00:00.000Z"))).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("recognises a preset from its dates", () => {
    expect(matchPreset({ from: "2026-11-01", to: "2026-11-30" }, WIB, now)).toBe("this_month");
    expect(matchPreset({ from: "2026-11-01", to: "2026-11-17" }, WIB, now)).toBe("custom");
  });
});

describe("daysInRange / rangeBucket", () => {
  it("lists every day once", () => {
    expect(daysInRange({ from: "2026-11-29", to: "2026-12-02" })).toEqual(["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"]);
    expect(daysInRange({ from: "2026-11-17", to: "2026-11-17" })).toEqual(["2026-11-17"]);
  });

  it("buckets an instant by the branch's calendar", () => {
    const at = new Date("2026-10-31T23:30:00.000Z"); // Sunday 1 Nov 06:30 WIB
    expect(rangeBucket(at, "day", WIB)).toBe("2026-11-01");
    expect(rangeBucket(at, "week", WIB)).toBe("2026-10-26");
    expect(rangeBucket(at, "month", WIB)).toBe("2026-11");
  });
});
