import { describe, expect, it } from "vitest";

import { money } from "../src/money.js";
import { recurringLeaseStrategy } from "../src/booking-model/recurring-lease.strategy.js";

import type { PricingConfig } from "../src/booking-model/types.js";

const pkpPricing: PricingConfig = {
  basePrice: money(1_200_000),
  currency: "IDR",
  adminFee: money(75_000),
  depositRule: { type: "MULTIPLE_OF_RENT", multiple: 1 },
  prorationRule: "ANCHOR_DATE",
  taxInclusive: false,
};

describe("recurringLeaseStrategy.computeInitialInvoice", () => {
  it("produces prorated rent + admin fee + deposit + tax lines for a PKP tenant", () => {
    const draft = recurringLeaseStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 6, 16) },
      pkpPricing,
      { isTenantPkp: true },
    );

    const lineTypes = draft.lines.map((l) => l.lineType).sort();
    expect(lineTypes).toEqual(["ADMIN_FEE", "DEPOSIT", "RENT", "TAX"]);

    const rent = draft.lines.find((l) => l.lineType === "RENT")!;
    expect(rent.amount.toString()).toBe(
      money(1_200_000).mul(16).div(31).toDecimalPlaces(2).toString(),
    );

    const deposit = draft.lines.find((l) => l.lineType === "DEPOSIT")!;
    expect(deposit.amount.toString()).toBe("1200000");

    // Tax must be computed on (rent + admin fee) only, never on the deposit liability.
    const tax = draft.lines.find((l) => l.lineType === "TAX")!;
    const taxableBase = rent.amount.plus(75_000);
    expect(tax.amount.toString()).toBe(taxableBase.mul("0.11").toDecimalPlaces(2).toString());

    // subtotal/total must include the deposit (it's due on the invoice) even though it's untaxed.
    expect(draft.totalAmount.toString()).toBe(
      rent.amount.plus(75_000).plus(tax.amount).plus(deposit.amount).toString(),
    );
  });

  it("omits the tax line entirely for a non-PKP tenant", () => {
    const draft = recurringLeaseStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 6, 16) },
      pkpPricing,
      { isTenantPkp: false },
    );
    expect(draft.lines.some((l) => l.lineType === "TAX")).toBe(false);
  });

  it("sets the period to run through the day before next month's anchor", () => {
    const draft = recurringLeaseStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 6, 16) },
      pkpPricing,
      { isTenantPkp: true },
    );
    expect(draft.periodStart).toEqual(new Date(2026, 6, 16));
    expect(draft.periodEnd).toEqual(new Date(2026, 7, 15));
  });
});

describe("recurringLeaseStrategy.computeNextCycleInvoice", () => {
  it("charges the full base price with no proration", () => {
    const draft = recurringLeaseStrategy.computeNextCycleInvoice!(new Date(2026, 7, 16), pkpPricing, {
      isTenantPkp: true,
    });
    const rent = draft.lines.find((l) => l.lineType === "RENT")!;
    expect(rent.amount.toString()).toBe("1200000");
    // A full recurring cycle carries no admin fee or deposit line — those are first-invoice-only.
    expect(draft.lines.some((l) => l.lineType === "ADMIN_FEE")).toBe(false);
    expect(draft.lines.some((l) => l.lineType === "DEPOSIT")).toBe(false);
  });
});

describe("recurringLeaseStrategy.computeFinalSettlement", () => {
  it("prorates the final partial month through the notice-effective end date", () => {
    const draft = recurringLeaseStrategy.computeFinalSettlement(
      { startDate: new Date(2026, 6, 16), anchorDay: 16 },
      pkpPricing,
      { isTenantPkp: true },
      new Date(2026, 8, 10), // moved out Sep 10
    );
    const rent = draft.lines.find((l) => l.lineType === "RENT")!;
    expect(rent.amount.toString()).toBe(money(1_200_000).mul(10).div(30).toDecimalPlaces(2).toString());
  });
});
