import { describe, expect, it } from "vitest";

import { BILLING_PLANS, computeMonthlyCharge, OVERAGE_PRICE_PER_ASSET_IDR } from "../src/billing/plans.js";

describe("computeMonthlyCharge", () => {
  it("charges only the flat plan price when usage is within the included allowance", () => {
    const result = computeMonthlyCharge("STARTER", 10);
    expect(result.planAmount.toString()).toBe("500000");
    expect(result.overageAssets).toBe(0);
    expect(result.overageAmount.toString()).toBe("0");
    expect(result.totalAmount.toString()).toBe("500000");
  });

  it("charges exactly the flat price at precisely the included limit (no off-by-one)", () => {
    const result = computeMonthlyCharge("STARTER", BILLING_PLANS.STARTER.includedAssets);
    expect(result.overageAssets).toBe(0);
    expect(result.totalAmount.toString()).toBe("500000");
  });

  it("adds a per-asset overage charge once usage exceeds the included allowance", () => {
    const result = computeMonthlyCharge("STARTER", 30);
    expect(result.overageAssets).toBe(5);
    expect(result.overageAmount.toString()).toBe(String(5 * OVERAGE_PRICE_PER_ASSET_IDR));
    expect(result.totalAmount.toString()).toBe(String(500_000 + 5 * OVERAGE_PRICE_PER_ASSET_IDR));
  });

  it("TRIAL plan is free within its allowance", () => {
    const result = computeMonthlyCharge("TRIAL", 3);
    expect(result.totalAmount.toString()).toBe("0");
  });

  it("never returns negative overage for zero usage", () => {
    const result = computeMonthlyCharge("GROWTH", 0);
    expect(result.overageAssets).toBe(0);
    expect(result.overageAmount.toString()).toBe("0");
  });
});
