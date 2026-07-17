import { describe, expect, it } from "vitest";

import { money } from "../src/money.js";
import { computeSwapProration } from "../src/pricing/swap-proration.js";

// A 31-day period, July 17 - August 16 inclusive, matching periodEndFor's convention.
const periodStart = new Date(2026, 6, 17);
const periodEnd = new Date(2026, 7, 16);

describe("computeSwapProration", () => {
  it("counts a full 31-day period inclusively", () => {
    const result = computeSwapProration({
      oldMonthlyRate: money(450_000),
      newMonthlyRate: money(1_200_000),
      periodStart,
      periodEnd,
      switchDate: periodStart,
    });
    expect(result.daysInPeriod).toBe(31);
    expect(result.daysRemaining).toBe(31);
  });

  it("produces a positive netAdjustment (customer owes more) for an upgrade", () => {
    // Switch happens with 16 days left (Aug 1 through Aug 16 inclusive).
    const result = computeSwapProration({
      oldMonthlyRate: money(450_000),
      newMonthlyRate: money(1_200_000),
      periodStart,
      periodEnd,
      switchDate: new Date(2026, 7, 1),
    });
    expect(result.daysRemaining).toBe(16);
    const oldDaily = money(450_000).div(31);
    const newDaily = money(1_200_000).div(31);
    expect(result.oldRateUnusedCredit.toString()).toBe(oldDaily.mul(16).toDecimalPlaces(2).toString());
    expect(result.newRateCharge.toString()).toBe(newDaily.mul(16).toDecimalPlaces(2).toString());
    expect(result.netAdjustment.greaterThan(0)).toBe(true);
  });

  it("produces a negative netAdjustment (customer is owed a credit) for a downsize", () => {
    const result = computeSwapProration({
      oldMonthlyRate: money(1_200_000),
      newMonthlyRate: money(450_000),
      periodStart,
      periodEnd,
      switchDate: new Date(2026, 7, 1),
    });
    expect(result.netAdjustment.lessThan(0)).toBe(true);
  });

  it("clamps daysRemaining to zero when the switch date is after the period ends", () => {
    const result = computeSwapProration({
      oldMonthlyRate: money(450_000),
      newMonthlyRate: money(1_200_000),
      periodStart,
      periodEnd,
      switchDate: new Date(2026, 8, 1),
    });
    expect(result.daysRemaining).toBe(0);
    expect(result.oldRateUnusedCredit.toString()).toBe("0");
    expect(result.newRateCharge.toString()).toBe("0");
    expect(result.netAdjustment.toString()).toBe("0");
  });

  it("nets to zero when old and new rates are identical", () => {
    const result = computeSwapProration({
      oldMonthlyRate: money(450_000),
      newMonthlyRate: money(450_000),
      periodStart,
      periodEnd,
      switchDate: new Date(2026, 7, 1),
    });
    expect(result.netAdjustment.toString()).toBe("0");
  });
});
