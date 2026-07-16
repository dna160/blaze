import { describe, expect, it } from "vitest";

import { money } from "../src/money.js";
import { computeTax } from "../src/pricing/tax.js";

describe("computeTax", () => {
  it("charges no tax at all for a non-PKP tenant", () => {
    const result = computeTax(money(1_000_000), { isTenantPkp: false, taxInclusive: false });
    expect(result.taxAmount.toString()).toBe("0");
    expect(result.grossAmount.toString()).toBe("1000000");
  });

  it("adds 11% PPN on top for tax-exclusive PKP pricing", () => {
    const result = computeTax(money(1_000_000), { isTenantPkp: true, taxInclusive: false });
    expect(result.taxAmount.toString()).toBe("110000");
    expect(result.grossAmount.toString()).toBe("1110000");
  });

  it("backs out 11% PPN for tax-inclusive PKP pricing", () => {
    const result = computeTax(money(1_110_000), { isTenantPkp: true, taxInclusive: true });
    expect(result.netAmount.toString()).toBe("1000000");
    expect(result.taxAmount.toString()).toBe("110000");
    expect(result.grossAmount.toString()).toBe("1110000");
  });
});
