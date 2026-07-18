import { describe, expect, it } from "vitest";

import { money } from "../src/money.js";
import { nightlyStrategy } from "../src/booking-model/nightly.strategy.js";

import type { PricingConfig } from "../src/booking-model/types.js";

const pkpPricing: PricingConfig = {
  basePrice: money(500_000),
  currency: "IDR",
  adminFee: money(25_000),
  depositRule: { type: "FIXED", amount: 500_000 },
  taxInclusive: false,
};

describe("nightlyStrategy.computeInitialInvoice", () => {
  it("charges nights x nightly rate + admin fee + deposit + tax for a PKP tenant", () => {
    const draft = nightlyStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 6, 16), endDate: new Date(2026, 6, 19) }, // 3 nights
      pkpPricing,
      { isTenantPkp: true },
    );

    const lineTypes = draft.lines.map((l) => l.lineType).sort();
    expect(lineTypes).toEqual(["ADMIN_FEE", "DEPOSIT", "RENT", "TAX"]);

    const rent = draft.lines.find((l) => l.lineType === "RENT")!;
    expect(rent.amount.toString()).toBe("1500000");
    expect(rent.quantity.toString()).toBe("3");

    const deposit = draft.lines.find((l) => l.lineType === "DEPOSIT")!;
    expect(deposit.amount.toString()).toBe("500000");

    const tax = draft.lines.find((l) => l.lineType === "TAX")!;
    const taxableBase = rent.amount.plus(25_000);
    expect(tax.amount.toString()).toBe(taxableBase.mul("0.11").toDecimalPlaces(2).toString());

    expect(draft.totalAmount.toString()).toBe(
      rent.amount.plus(25_000).plus(tax.amount).plus(deposit.amount).toString(),
    );
  });

  it("omits the tax line entirely for a non-PKP tenant", () => {
    const draft = nightlyStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 6, 16), endDate: new Date(2026, 6, 19) },
      pkpPricing,
      { isTenantPkp: false },
    );
    expect(draft.lines.some((l) => l.lineType === "TAX")).toBe(false);
  });

  it("sets the period to the stay's check-in/check-out dates", () => {
    const draft = nightlyStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 6, 16), endDate: new Date(2026, 6, 19) },
      pkpPricing,
      { isTenantPkp: true },
    );
    expect(draft.periodStart).toEqual(new Date(2026, 6, 16));
    expect(draft.periodEnd).toEqual(new Date(2026, 6, 19));
  });

  it("charges exactly one night when checkout is the day after check-in", () => {
    const draft = nightlyStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 6, 16), endDate: new Date(2026, 6, 17) },
      pkpPricing,
      { isTenantPkp: true },
    );
    const rent = draft.lines.find((l) => l.lineType === "RENT")!;
    expect(rent.quantity.toString()).toBe("1");
    expect(rent.amount.toString()).toBe("500000");
  });

  it("throws when endDate is missing", () => {
    expect(() =>
      nightlyStrategy.computeInitialInvoice({ startDate: new Date(2026, 6, 16) }, pkpPricing, { isTenantPkp: true }),
    ).toThrow(/endDate/);
  });

  it("throws when endDate is not after startDate", () => {
    expect(() =>
      nightlyStrategy.computeInitialInvoice(
        { startDate: new Date(2026, 6, 16), endDate: new Date(2026, 6, 16) },
        pkpPricing,
        { isTenantPkp: true },
      ),
    ).toThrow(/at least one night/);
  });

  it("emits one RENT line per seasonal rate group when the stay crosses a peak-season boundary", () => {
    const seasonalPricing: PricingConfig = {
      ...pkpPricing,
      basePrice: money(350_000),
      seasonalRates: [{ startDate: "2026-12-24", endDate: "2026-12-31", basePrice: 550_000, label: "Christmas & New Year" }],
    };
    // Dec 23 -> Dec 26 checkout: 1 night at base rate, 2 nights at the seasonal rate
    const draft = nightlyStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 11, 23), endDate: new Date(2026, 11, 26) },
      seasonalPricing,
      { isTenantPkp: false },
    );

    const rentLines = draft.lines.filter((l) => l.lineType === "RENT");
    expect(rentLines).toHaveLength(2);
    const [baseNight, seasonalNights] = rentLines;
    expect(baseNight!.amount.toString()).toBe("350000");
    expect(baseNight!.quantity.toString()).toBe("1");
    expect(seasonalNights!.amount.toString()).toBe("1100000");
    expect(seasonalNights!.quantity.toString()).toBe("2");
    expect(seasonalNights!.description).toContain("Christmas & New Year");

    const totalRent = rentLines.reduce((sum, l) => sum.plus(l.amount), money(0));
    expect(totalRent.toString()).toBe("1450000");
  });
});

describe("nightlyStrategy.computeFinalSettlement", () => {
  it("is not implemented — no early-checkout path exists on the NIGHTLY FSM yet", () => {
    expect(() =>
      nightlyStrategy.computeFinalSettlement(
        { startDate: new Date(2026, 6, 16), endDate: new Date(2026, 6, 19) },
        pkpPricing,
        { isTenantPkp: true },
        new Date(2026, 6, 18),
      ),
    ).toThrow(/not implemented/);
  });
});
