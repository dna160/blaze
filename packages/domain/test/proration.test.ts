import { describe, expect, it } from "vitest";

import { money } from "../src/money.js";
import { nextAnchorDate, periodEndFor, prorateFirstPeriod } from "../src/pricing/proration.js";

describe("prorateFirstPeriod", () => {
  it("charges only remaining days under ANCHOR_DATE", () => {
    // July 2026 has 31 days; moving in on the 16th charges 16 remaining days (16..31 inclusive).
    const result = prorateFirstPeriod(money(1_200_000), new Date(2026, 6, 16), "ANCHOR_DATE");
    expect(result.daysInMonth).toBe(31);
    expect(result.daysCharged).toBe(16);
    expect(result.amount.toString()).toBe(
      money(1_200_000).mul(16).div(31).toDecimalPlaces(2).toString(),
    );
    expect(result.anchorDay).toBe(16);
  });

  it("charges the full period under FULL_FIRST_PERIOD regardless of start day", () => {
    const result = prorateFirstPeriod(money(1_200_000), new Date(2026, 6, 16), "FULL_FIRST_PERIOD");
    expect(result.amount.toString()).toBe("1200000");
    expect(result.anchorDay).toBe(1);
  });

  it("charges the full amount when moving in on the 1st under ANCHOR_DATE", () => {
    const result = prorateFirstPeriod(money(1_200_000), new Date(2026, 6, 1), "ANCHOR_DATE");
    expect(result.daysCharged).toBe(31);
    expect(result.amount.toString()).toBe("1200000");
  });
});

describe("nextAnchorDate", () => {
  it("rolls to next month same day", () => {
    const next = nextAnchorDate(16, new Date(2026, 6, 16));
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(7); // August
    expect(next.getDate()).toBe(16);
  });

  it("clamps anchor day 31 to Feb 28 in a non-leap year", () => {
    const next = nextAnchorDate(31, new Date(2027, 0, 31));
    expect(next.getMonth()).toBe(1); // February
    expect(next.getDate()).toBe(28);
  });

  it("clamps anchor day 31 to Feb 29 in a leap year", () => {
    const next = nextAnchorDate(31, new Date(2028, 0, 31));
    expect(next.getMonth()).toBe(1);
    expect(next.getDate()).toBe(29);
  });

  it("rolls December into January of the next year", () => {
    const next = nextAnchorDate(15, new Date(2026, 11, 15));
    expect(next.getFullYear()).toBe(2027);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(15);
  });
});

describe("periodEndFor", () => {
  it("returns the day before the next anchor date", () => {
    const end = periodEndFor(new Date(2026, 6, 16), 16);
    expect(end.getFullYear()).toBe(2026);
    expect(end.getMonth()).toBe(7);
    expect(end.getDate()).toBe(15);
  });
});
