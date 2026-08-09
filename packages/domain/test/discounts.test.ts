import { describe, expect, it } from "vitest";

import {
  bundleDiscount,
  durationDiscount,
  composeMonthlyRate,
  applyPriceOverride,
  type BundleTier,
  type DurationTier,
} from "../src/pricing/discounts.js";

const bundleTiers: BundleTier[] = [
  { minUnits: 2, discountPct: 4.5 },
  { minUnits: 3, discountPct: 5 },
  { minUnits: 5, discountPct: 6 },
];
const durationTiers: DurationTier[] = [
  { minMonths: 6, discountPct: 5 },
  { minMonths: 12, discountPct: 10 },
  { minMonths: 24, discountPct: 15 },
];

describe("Pricing discounts (#30/#31/#32)", () => {
  it("bundle discount picks the highest matching tier", () => {
    expect(bundleDiscount(1, bundleTiers)).toBe(0);
    expect(bundleDiscount(2, bundleTiers)).toBe(4.5);
    expect(bundleDiscount(4, bundleTiers)).toBe(5);
    expect(bundleDiscount(6, bundleTiers)).toBe(6);
  });

  it("duration discount picks the highest matching tier (6/12/24)", () => {
    expect(durationDiscount(3, durationTiers)).toBe(0);
    expect(durationDiscount(6, durationTiers)).toBe(5);
    expect(durationDiscount(12, durationTiers)).toBe(10);
    expect(durationDiscount(36, durationTiers)).toBe(15);
  });

  it("composes base → bundle → duration in the correct order", () => {
    // 1,000,000 base × 2 units = 2,000,000; -4.5% bundle = 1,910,000; -10% (12mo) = 1,719,000
    const c = composeMonthlyRate({ baseRate: 1_000_000, unitCount: 2, months: 12, bundleTiers, durationTiers });
    expect(c.base.toString()).toBe("2000000");
    expect(c.bundlePct).toBe(4.5);
    expect(c.durationPct).toBe(10);
    expect(c.computed.toString()).toBe("1719000");
    expect(c.final.toString()).toBe("1719000");
  });

  it("manual override replaces the computed figure (the hand-rounded quote, #32)", () => {
    const c = composeMonthlyRate({
      baseRate: 1_000_000,
      unitCount: 2,
      months: 12,
      bundleTiers,
      durationTiers,
      override: 1_700_000, // client's hand-rounded number
    });
    expect(c.computed.toString()).toBe("1719000");
    expect(c.override?.toString()).toBe("1700000");
    expect(c.final.toString()).toBe("1700000");
  });

  it("applyPriceOverride passes null through and rounds a value", () => {
    expect(applyPriceOverride(null)).toBeNull();
    expect(applyPriceOverride(undefined)).toBeNull();
    expect(applyPriceOverride("1234.005")?.toString()).toBe("1234.01");
  });
});
