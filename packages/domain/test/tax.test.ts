import { describe, expect, it } from "vitest";

import { money } from "../src/money.js";
import { computeTax, effectivePpnRate, ppnLabel, resolvePpnRate } from "../src/pricing/tax.js";

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

describe("PPN rate and label (PRD go-live 2 §2.6)", () => {
  it("uses the configured rate, and the statutory default when there is none or it is nonsense", () => {
    expect(resolvePpnRate({ ppnRate: 0.12 }).toString()).toBe("0.12");
    expect(resolvePpnRate({ ppnRate: "0.1" }).toString()).toBe("0.1");
    expect(resolvePpnRate({}).toString()).toBe("0.11");
    expect(resolvePpnRate(null).toString()).toBe("0.11");
    expect(resolvePpnRate({ ppnRate: 11 }).toString()).toBe("0.11");
    expect(resolvePpnRate({ ppnRate: -0.1 }).toString()).toBe("0.11");
    expect(resolvePpnRate({ ppnRate: "eleven" }).toString()).toBe("0.11");
  });

  it("labels the rate instead of hardcoding 11%", () => {
    expect(ppnLabel()).toBe("PPN 11%");
    expect(ppnLabel(0.12)).toBe("PPN 12%");
    expect(ppnLabel("0.1")).toBe("PPN 10%");
    expect(ppnLabel(0.011)).toBe("PPN 1,1%");
  });

  it("reads the rate an invoice was actually charged at from its own figures", () => {
    expect(effectivePpnRate(110_000, 1_000_000)?.toString()).toBe("0.11");
    // Rounding to whole rupiah must not print 10,99%.
    expect(effectivePpnRate(366_667, 3_333_333)?.toString()).toBe("0.11");
    expect(effectivePpnRate(120_000, 1_000_000)?.toString()).toBe("0.12");
    expect(effectivePpnRate(0, 1_000_000)).toBeNull();
    expect(effectivePpnRate(110_000, 0)).toBeNull();
  });
});
