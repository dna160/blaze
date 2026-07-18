import { describe, expect, it } from "vitest";

import { money } from "../src/money.js";
import { durationOrderStrategy } from "../src/booking-model/duration-order.strategy.js";

import type { PricingConfig } from "../src/booking-model/types.js";

const pkpPricing: PricingConfig = {
  basePrice: money(150_000),
  currency: "IDR",
  adminFee: money(20_000),
  depositRule: { type: "FIXED", amount: 1_000_000 },
  taxInclusive: false,
};

describe("durationOrderStrategy.computeInitialInvoice", () => {
  it("charges days x daily rate + admin fee + deposit + tax for a PKP tenant", () => {
    const draft = durationOrderStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 6, 10), endDate: new Date(2026, 6, 15) }, // 5 days
      pkpPricing,
      { isTenantPkp: true },
    );

    const lineTypes = draft.lines.map((l) => l.lineType).sort();
    expect(lineTypes).toEqual(["ADMIN_FEE", "DEPOSIT", "RENT", "TAX"]);

    const rent = draft.lines.find((l) => l.lineType === "RENT")!;
    expect(rent.amount.toString()).toBe("750000");
    expect(rent.quantity.toString()).toBe("5");

    const deposit = draft.lines.find((l) => l.lineType === "DEPOSIT")!;
    expect(deposit.amount.toString()).toBe("1000000");

    const tax = draft.lines.find((l) => l.lineType === "TAX")!;
    const taxableBase = rent.amount.plus(20_000);
    expect(tax.amount.toString()).toBe(taxableBase.mul("0.11").toDecimalPlaces(2).toString());

    expect(draft.totalAmount.toString()).toBe(
      rent.amount.plus(20_000).plus(tax.amount).plus(deposit.amount).toString(),
    );
  });

  it("omits the tax line entirely for a non-PKP tenant", () => {
    const draft = durationOrderStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 6, 10), endDate: new Date(2026, 6, 15) },
      pkpPricing,
      { isTenantPkp: false },
    );
    expect(draft.lines.some((l) => l.lineType === "TAX")).toBe(false);
  });

  it("sets the period to the order's pickup/return dates", () => {
    const draft = durationOrderStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 6, 10), endDate: new Date(2026, 6, 15) },
      pkpPricing,
      { isTenantPkp: true },
    );
    expect(draft.periodStart).toEqual(new Date(2026, 6, 10));
    expect(draft.periodEnd).toEqual(new Date(2026, 6, 15));
  });

  it("charges exactly one day when the return date is the day after pickup", () => {
    const draft = durationOrderStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 6, 10), endDate: new Date(2026, 6, 11) },
      pkpPricing,
      { isTenantPkp: true },
    );
    const rent = draft.lines.find((l) => l.lineType === "RENT")!;
    expect(rent.quantity.toString()).toBe("1");
    expect(rent.amount.toString()).toBe("150000");
  });

  it("throws when endDate is missing", () => {
    expect(() =>
      durationOrderStrategy.computeInitialInvoice({ startDate: new Date(2026, 6, 10) }, pkpPricing, {
        isTenantPkp: true,
      }),
    ).toThrow(/endDate/);
  });

  it("throws when endDate is not after startDate", () => {
    expect(() =>
      durationOrderStrategy.computeInitialInvoice(
        { startDate: new Date(2026, 6, 10), endDate: new Date(2026, 6, 10) },
        pkpPricing,
        { isTenantPkp: true },
      ),
    ).toThrow(/at least one day/);
  });
});

describe("durationOrderStrategy.computeFinalSettlement", () => {
  it("is not implemented — no early-return path exists on the DURATION_ORDER FSM yet", () => {
    expect(() =>
      durationOrderStrategy.computeFinalSettlement(
        { startDate: new Date(2026, 6, 10), endDate: new Date(2026, 6, 15) },
        pkpPricing,
        { isTenantPkp: true },
        new Date(2026, 6, 12),
      ),
    ).toThrow(/not implemented/);
  });
});
