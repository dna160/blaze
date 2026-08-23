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

const tieredPricing: PricingConfig = {
  ...pkpPricing,
  dailyRate: money(60_000),
  weeklyRate: money(350_000),
};

describe("recurringLeaseStrategy.computeInitialInvoice — DAILY rateTier", () => {
  it("charges dailyRate × whole days, no proration", () => {
    const draft = recurringLeaseStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 6, 1), endDate: new Date(2026, 6, 4), rateTier: "DAILY" },
      tieredPricing,
      { isTenantPkp: true },
    );
    const rent = draft.lines.find((l) => l.lineType === "RENT")!;
    expect(rent.amount.toString()).toBe("180000"); // 3 days × 60,000
    expect(rent.description).toContain("3 days");
    expect(draft.periodEnd).toEqual(new Date(2026, 6, 4));
  });

  it("bases the deposit on dailyRate, not the monthly basePrice", () => {
    const draft = recurringLeaseStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 6, 1), endDate: new Date(2026, 6, 2), rateTier: "DAILY" },
      { ...tieredPricing, depositRule: { type: "MULTIPLE_OF_RENT", multiple: 1 } },
      { isTenantPkp: true },
    );
    const deposit = draft.lines.find((l) => l.lineType === "DEPOSIT")!;
    expect(deposit.amount.toString()).toBe("60000");
  });

  it("throws a clear error when dailyRate is not configured", () => {
    expect(() =>
      recurringLeaseStrategy.computeInitialInvoice(
        { startDate: new Date(2026, 6, 1), endDate: new Date(2026, 6, 2), rateTier: "DAILY" },
        pkpPricing,
        { isTenantPkp: true },
      ),
    ).toThrow(/Daily rate is not configured/);
  });

  it("throws when endDate is missing", () => {
    expect(() =>
      recurringLeaseStrategy.computeInitialInvoice(
        { startDate: new Date(2026, 6, 1), rateTier: "DAILY" },
        tieredPricing,
        { isTenantPkp: true },
      ),
    ).toThrow(/requires an endDate/);
  });
});

describe("recurringLeaseStrategy.computeInitialInvoice — WEEKLY rateTier", () => {
  it("charges weeklyRate × whole weeks, rounding a partial week up", () => {
    const draft = recurringLeaseStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 6, 1), endDate: new Date(2026, 6, 10), rateTier: "WEEKLY" }, // 9 days -> 2 weeks
      tieredPricing,
      { isTenantPkp: true },
    );
    const rent = draft.lines.find((l) => l.lineType === "RENT")!;
    expect(rent.amount.toString()).toBe("700000"); // 2 weeks × 350,000
    expect(rent.description).toContain("2 weeks");
  });

  it("charges exactly one week for a 7-day stay", () => {
    const draft = recurringLeaseStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 6, 1), endDate: new Date(2026, 6, 8), rateTier: "WEEKLY" },
      tieredPricing,
      { isTenantPkp: true },
    );
    const rent = draft.lines.find((l) => l.lineType === "RENT")!;
    expect(rent.amount.toString()).toBe("350000");
  });

  it("throws a clear error when weeklyRate is not configured", () => {
    expect(() =>
      recurringLeaseStrategy.computeInitialInvoice(
        { startDate: new Date(2026, 6, 1), endDate: new Date(2026, 6, 8), rateTier: "WEEKLY" },
        pkpPricing,
        { isTenantPkp: true },
      ),
    ).toThrow(/Weekly rate is not configured/);
  });
});

describe("recurringLeaseStrategy.computeInitialInvoice — MONTHLY rateTier (default, zero-regression)", () => {
  it("behaves identically whether rateTier is 'MONTHLY' or omitted", () => {
    const withTier = recurringLeaseStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 6, 16), rateTier: "MONTHLY" },
      pkpPricing,
      { isTenantPkp: true },
    );
    const withoutTier = recurringLeaseStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 6, 16) },
      pkpPricing,
      { isTenantPkp: true },
    );
    expect(withTier.totalAmount.toString()).toBe(withoutTier.totalAmount.toString());
    expect(withTier.periodEnd).toEqual(withoutTier.periodEnd);
  });
});

describe("recurringLeaseStrategy — fixed-term payment schedule (PRD v2 D1)", () => {
  it("the proforma charges a FULL first month (no proration) + admin fee + deposit + PPN", () => {
    const draft = recurringLeaseStrategy.computeInitialInvoice(
      { startDate: new Date(2026, 7, 16), termMonths: 3 },
      pkpPricing,
      { isTenantPkp: true },
    );
    const rent = draft.lines.find((l) => l.lineType === "RENT")!;
    expect(rent.amount.toString()).toBe("1200000"); // not 16/31 of it
    expect(rent.description).toContain("month 1 of 3");
    expect(draft.lines.find((l) => l.lineType === "DEPOSIT")!.amount.toString()).toBe("1200000");
    expect(draft.lines.find((l) => l.lineType === "ADMIN_FEE")!.amount.toString()).toBe("75000");
    expect(draft.lines.find((l) => l.lineType === "TAX")!.amount.toString()).toBe(
      money(1_275_000).mul("0.11").toDecimalPlaces(2).toString(),
    );
    expect(draft.periodStart).toEqual(new Date(2026, 7, 16));
    expect(draft.periodEnd).toEqual(new Date(2026, 8, 15));
  });

  it("rejects a term that isn't one of 1/3/6/12", () => {
    expect(() =>
      recurringLeaseStrategy.computeInitialInvoice({ startDate: new Date(2026, 7, 16), termMonths: 2 }, pkpPricing, { isTenantPkp: true }),
    ).toThrow(/Unsupported term/);
  });

  it("a scheduled cycle is a full month's rent only — no admin fee, no deposit", () => {
    const draft = recurringLeaseStrategy.computeCycleInvoice!(new Date(2026, 8, 16), new Date(2026, 9, 15), pkpPricing, { isTenantPkp: true });
    expect(draft.lines.map((l) => l.lineType).sort()).toEqual(["RENT", "TAX"]);
    expect(draft.lines.find((l) => l.lineType === "RENT")!.amount.toString()).toBe("1200000");
    expect(draft.totalAmount.toString()).toBe(money(1_200_000).mul("1.11").toDecimalPlaces(2).toString());
    expect(draft.periodStart).toEqual(new Date(2026, 8, 16));
    expect(draft.periodEnd).toEqual(new Date(2026, 9, 15));
  });

  it("the legacy indefinite lease (no termMonths) is byte-for-byte unchanged — still prorated", () => {
    const legacy = recurringLeaseStrategy.computeInitialInvoice({ startDate: new Date(2026, 6, 16) }, pkpPricing, { isTenantPkp: true });
    const rent = legacy.lines.find((l) => l.lineType === "RENT")!;
    expect(rent.amount.toString()).toBe(money(1_200_000).mul(16).div(31).toDecimalPlaces(2).toString());
  });
});
