import { describe, expect, it } from "vitest";

import { money } from "../src/money.js";
import { computeNightlyRateBreakdown, sumNightlyRateBreakdown } from "../src/pricing/seasonal.js";

import type { SeasonalRate } from "../src/pricing/seasonal.js";

describe("computeNightlyRateBreakdown", () => {
  it("collapses to a single group at the base rate when there are no seasonal rates", () => {
    const groups = computeNightlyRateBreakdown(new Date(2026, 6, 16), new Date(2026, 6, 19), money(500_000));
    expect(groups).toEqual([{ rate: money(500_000), nights: 3, label: undefined }]);
  });

  it("splits a stay that crosses into a seasonal window into two groups", () => {
    const seasonalRates: SeasonalRate[] = [
      { startDate: "2026-12-24", endDate: "2026-12-31", basePrice: 550_000, label: "Christmas & New Year" },
    ];
    // Dec 23 -> Dec 26 checkout: nights are Dec 23, 24, 25 (2 in-season, 1 not)
    const groups = computeNightlyRateBreakdown(new Date(2026, 11, 23), new Date(2026, 11, 26), money(350_000), seasonalRates);
    expect(groups).toEqual([
      { rate: money(350_000), nights: 1, label: undefined },
      { rate: money(550_000), nights: 2, label: "Christmas & New Year" },
    ]);
  });

  it("produces a single seasonal group when the whole stay is in-season", () => {
    const seasonalRates: SeasonalRate[] = [{ startDate: "2026-12-24", endDate: "2026-12-31", basePrice: 550_000, label: "Peak" }];
    const groups = computeNightlyRateBreakdown(new Date(2026, 11, 25), new Date(2026, 11, 28), money(350_000), seasonalRates);
    expect(groups).toEqual([{ rate: money(550_000), nights: 3, label: "Peak" }]);
  });

  it("re-splits when a stay crosses back out of season and into a second season", () => {
    const seasonalRates: SeasonalRate[] = [
      { startDate: "2026-12-24", endDate: "2026-12-26", basePrice: 550_000, label: "Christmas" },
      { startDate: "2026-12-31", endDate: "2027-01-01", basePrice: 600_000, label: "New Year" },
    ];
    // Dec 24 -> Jan 2 checkout: nights Dec24,25,26 (Christmas), 27-30 (base), 31,Jan1 (New Year)
    const groups = computeNightlyRateBreakdown(new Date(2026, 11, 24), new Date(2027, 0, 2), money(350_000), seasonalRates);
    expect(groups).toEqual([
      { rate: money(550_000), nights: 3, label: "Christmas" },
      { rate: money(350_000), nights: 4, label: undefined },
      { rate: money(600_000), nights: 2, label: "New Year" },
    ]);
  });

  it("charges nothing extra for a one-night stay fully inside a season", () => {
    const seasonalRates: SeasonalRate[] = [{ startDate: "2026-12-24", endDate: "2026-12-31", basePrice: 550_000 }];
    const groups = computeNightlyRateBreakdown(new Date(2026, 11, 25), new Date(2026, 11, 26), money(350_000), seasonalRates);
    expect(groups).toEqual([{ rate: money(550_000), nights: 1, label: undefined }]);
  });
});

describe("sumNightlyRateBreakdown", () => {
  it("sums every group's rate x nights", () => {
    const groups = [
      { rate: money(350_000), nights: 1 },
      { rate: money(550_000), nights: 2 },
    ];
    expect(sumNightlyRateBreakdown(groups).toString()).toBe("1450000");
  });

  it("returns zero for an empty breakdown", () => {
    expect(sumNightlyRateBreakdown([]).toString()).toBe("0");
  });
});
